import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;
const OKX_BASE_URL = 'https://www.okx.com';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'sent_ema.json');
const RESULTS_FILE = path.join(__dirname, '24h.json');

// Cấu hình Cooldown: 8 TIẾNG (Dùng chung để chặn cảnh báo và loại trừ A1/A2)
const COOLDOWN_TIME = 8 * 60 * 60 * 1000;
const MIN_VOL_CCY24H = 5_000_000; // Lọc Volume 24h > 5 triệu USDT

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------- QUẢN LÝ LỊCH SỬ COOLDOWN / A1-A2 LOG -------------------
function loadSentLog() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return data.trim() ? JSON.parse(data) : {};
    }
  } catch (e) {}
  return {};
}

function saveSentLog(logData) {
  try {
    const now = Date.now();
    const cleanedLog = {};
    for (const [coin, lastTime] of Object.entries(logData)) {
      if (now - lastTime < COOLDOWN_TIME) {
        cleanedLog[coin] = lastTime;
      }
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
  } catch (e) {}
}

function saveScanResults(results) {
  try {
    const outputData = {
      lastScanAt: new Date().toISOString(),
      totalScanned: results.totalScanned,
      matchedCount: results.matched.length,
      matchedList: results.matched
    };
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(outputData, null, 2), 'utf8');
  } catch (e) {
    console.error('Lỗi khi lưu 24h.json:', e.message);
  }
}

// ------------------- HÀM TÍNH TOÁN KỸ THUẬT -------------------

// Tính mảng EMA (prices theo thứ tự thời gian từ cũ đến mới)
function calculateEMA(prices, period = 10) {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const emaArray = [];

  let sum = 0;
  for (let i = 0; i < period; i++) sum += prices[i];
  let currentEma = sum / period;
  emaArray.push(currentEma);

  for (let i = period; i < prices.length; i++) {
    currentEma = (prices[i] - currentEma) * k + currentEma;
    emaArray.push(currentEma);
  }
  return emaArray;
}

// Tính Bollinger Bands (prices từ cũ đến mới, tối thiểu `period` nến)
function calculateBollingerBands(prices, period = 20, stdDevMultiplier = 2) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    middle: mean,
    upper: mean + stdDevMultiplier * stdDev,
    lower: mean - stdDevMultiplier * stdDev
  };
}

// ------------------- LẤY DỮ LIỆU TỪ OKX API -------------------

// 1. Lọc Volume > 5M và Biến động 24h từ -5% đến +5%
async function getFilteredMarkets() {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') return [];

    const tickers = res.data.data;
    return tickers
      .filter((item) => item.instId.endsWith('-USDT-SWAP'))
      .map((item) => {
        const last = parseFloat(item.last || 0);
        const open24h = parseFloat(item.open24h || 0);
        const change24h = open24h > 0 ? ((last - open24h) / open24h) * 100 : 0;
        return {
          instId: item.instId,
          lastPrice: last,
          change24h: change24h,
          volCcy24h: parseFloat(item.volCcy24h || 0)
        };
      })
      .filter((c) => c.volCcy24h > MIN_VOL_CCY24H && c.change24h >= -5 && c.change24h <= 5);
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return [];
  }
}

// 2. Lấy nến 1H (Yêu cầu tối thiểu 30 nến để tính EMA10 và lùi 10 nến)
async function getCandles1h(symbol) {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=60`;
    const res = await axios.get(url, { timeout: 5000 });
    if (!res.data || res.data.code !== '0' || res.data.data.length < 30) return null;
    return res.data.data;
  } catch (error) {
    console.error(`Lỗi lấy dữ liệu nến 1H (${symbol}):`, error.message);
    return null;
  }
}

// 3. Lấy nến 15m
async function getCandles15m(symbol) {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=50`;
    const res = await axios.get(url, { timeout: 5000 });
    if (!res.data || res.data.code !== '0' || res.data.data.length < 25) return null;
    return res.data.data;
  } catch (error) {
    console.error(`Lỗi lấy dữ liệu nến 15M (${symbol}):`, error.message);
    return null;
  }
}

// ------------------- TIẾN TRÌNH CHÍNH -------------------
async function main() {
  try {
    console.log('--- BẮT ĐẦU QUÉT THỊ TRƯỜNG OKX ---');

    const sentLog = loadSentLog();
    const currentTime = Date.now();
    let hasLogUpdated = false;

    // Bước 1: Lọc Market sơ bộ (Vol > 5M, Biến động 24h [-5%, +5%])
    const targetCoins = await getFilteredMarkets();
    console.log(`📊 Số coin thỏa Vol > 5M và Biến động 24h [-5%, +5%]: ${targetCoins.length}`);

    const scanResults = {
      totalScanned: targetCoins.length,
      matched: []
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // Bước 2: Kiểm tra nến 1H & tính diffema10
      const raw1h = await getCandles1h(symbol);
      if (!raw1h) {
        await sleep(80);
        continue;
      }

      // Sắp xếp giá đóng cửa từ quá khứ đến hiện tại
      const closes1hAsc = raw1h.map((c) => parseFloat(c[4])).reverse();
      const ema1hList = calculateEMA(closes1hAsc, 10);

      // Cần tối thiểu 11 phần tử EMA để so sánh giữa hiện tại và 10 nến trước
      if (ema1hList.length < 11) {
        await sleep(80);
        continue;
      }

      const emaCurrent = ema1hList[ema1hList.length - 1];
      const ema10Ago = ema1hList[ema1hList.length - 11];
      const diffema10 = ((emaCurrent - ema10Ago) / ema10Ago) * 100;

      // Bước 3: Lấy nến 15m & tính các chỉ số kỹ thuật
      const raw15m = await getCandles15m(symbol);
      if (!raw15m || raw15m.length < 25) {
        await sleep(80);
        continue;
      }

      // Nến 0 (đang chạy), Nến 1 (vừa đóng), Nến 2 (đóng trước đó)
      const c0 = raw15m[0];
      const c1 = raw15m[1];
      const c2 = raw15m[2];

      const h0 = parseFloat(c0[2]); // High nến 0
      const l0 = parseFloat(c0[3]); // Low nến 0

      // Tính biến động từng nến: ((Close - Open) / Open) * 100
      const change0 = ((parseFloat(c0[4]) - parseFloat(c0[1])) / parseFloat(c0[1])) * 100;
      const change1 = ((parseFloat(c1[4]) - parseFloat(c1[1])) / parseFloat(c1[1])) * 100;
      const change2 = ((parseFloat(c2[4]) - parseFloat(c2[1])) / parseFloat(c2[1])) * 100;

      // Tìm biến động có độ lớn (biên độ) lớn nhất trong 3 nến 0, 1, 2
      const changes = [change0, change1, change2];
      const maxChangeSigned = changes.reduce((prev, curr) =>
        Math.abs(curr) > Math.abs(prev) ? curr : prev
      );

      // Tính Bollinger Bands 15m của nến số 2 (lấy 20 nến tính từ nến số 2 trở về quá khứ: index 2 -> 21)
      const closes15mAtCandle2Asc = raw15m.slice(2, 22).map((c) => parseFloat(c[4])).reverse();
      const bb15mAtCandle2 = calculateBollingerBands(closes15mAtCandle2Asc, 20, 2);

      if (!bb15mAtCandle2) {
        await sleep(80);
        continue;
      }

      // Hbb tính theo nến số 2
      const Hbb = ((bb15mAtCandle2.upper - bb15mAtCandle2.lower) / bb15mAtCandle2.lower) * 100;

      // Điều kiện Hbb > 3%
      if (Hbb <= 3) {
        await sleep(80);
        continue;
      }

      // Tính x = biến động nến lớn nhất trong 3 nến / Hbb của nến số 2
      const x = maxChangeSigned / Hbb;

      // Tính bbd15m bằng Low hiện tại và bbt15m bằng High hiện tại so với BB nến số 2
      const bbd15m = ((l0 - bb15mAtCandle2.lower) / bb15mAtCandle2.lower) * 100;
      const bbt15m = ((h0 - bb15mAtCandle2.upper) / bb15mAtCandle2.upper) * 100;

      // Kiểm tra trạng thái bị khóa trong 8h qua từ sent_ema.json
      const isLockedIn8h = currentTime - (sentLog[symbol] || 0) < COOLDOWN_TIME;

      // Bước 4: Xét điều kiện Nhóm A1, A2 (Dùng để khóa danh sách trong 8h)
      // A1 (LONG): x > 0.4, l0 < Upper BB, và 0 < diffema10 < 3%
      const isA1 = x > 0.4 && l0 < bb15mAtCandle2.upper && (diffema10 > 0 && diffema10 < 3);
      // A2 (SHORT): x < -0.4, h0 > Lower BB, và -3% < diffema10 < 0
      const isA2 = x < -0.4 && h0 > bb15mAtCandle2.lower && (diffema10 > -3 && diffema10 < 0);

      if (isA1 || isA2) {
        const aGroupName = isA1 ? 'Nhóm A1' : 'Nhóm A2';
        const aType = isA1 ? 'LONG' : 'SHORT';

        scanResults.matched.push({
          symbol,
          type: aType,
          group: aGroupName,
          Hbb: Hbb.toFixed(2) + '%',
          x: x.toFixed(2),
          diffema10: diffema10.toFixed(2) + '%',
          bandDiff: (isA1 ? bbd15m : bbt15m).toFixed(2) + '%',
          change24h: coin.change24h.toFixed(2) + '%',
          teleSent: false
        });

        // Lưu vào sent_ema.json để khóa 8 tiếng (không gửi Telegram)
        sentLog[symbol] = currentTime;
        hasLogUpdated = true;

        console.log(`🔒 [${aGroupName}] ${symbol} đã được lưu vào sent_ema.json (Khóa 8h, Không gửi Tele)`);
        await sleep(80);
        continue;
      }

      // Bước 5: Xét điều kiện Nhóm B1, B2 kèm diffema10 tương ứng
      let bType = null;
      let bGroupName = '';

      // Long: x > -0.3, -3% < bbd15m < -0.5% và 0% < diffema10 < 3%
      if (x > -0.3 && bbd15m > -3 && bbd15m < -0.5 && (diffema10 > 0 && diffema10 < 3)) {
        bType = 'LONG';
        bGroupName = 'Nhóm B1';
      // Short: x < 0.3, 0.5% < bbt15m < 3% và -3% < diffema10 < 0%
      } else if (x < 0.3 && bbt15m > 0.5 && bbt15m < 3 && (diffema10 > -3 && diffema10 < 0)) {
        bType = 'SHORT';
        bGroupName = 'Nhóm B2';
      }

      if (bType) {
        scanResults.matched.push({
          symbol,
          type: bType,
          group: bGroupName,
          Hbb: Hbb.toFixed(2) + '%',
          x: x.toFixed(2),
          diffema10: diffema10.toFixed(2) + '%',
          bandDiff: (bType === 'LONG' ? bbd15m : bbt15m).toFixed(2) + '%',
          change24h: coin.change24h.toFixed(2) + '%',
          teleSent: !isLockedIn8h
        });

        if (!isLockedIn8h) {
          const coinName = symbol.replace('-USDT-SWAP', '');
          const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
          const icon = bType === 'LONG' ? '🟢' : '🔴';
          const bandLine = bType === 'LONG'
            ? `• <b>bbd15m (Low):</b> ${bbd15m.toFixed(2)}%\n`
            : `• <b>bbt15m (High):</b> ${bbt15m.toFixed(2)}%\n`;

          const message = `${icon} <b>TÍN HIỆU ${bType} (${bGroupName}): ${coinName}</b>\n` +
            `• <b>Hbb (Nến 2):</b> ${Hbb.toFixed(2)}%\n` +
            `• <b>x (Max 3 nến):</b> ${x.toFixed(2)}\n` +
            `• <b>diffema10:</b> ${diffema10.toFixed(2)}%\n` +
            bandLine +
            `• <b>Biến động 24h:</b> ${coin.change24h > 0 ? '+' : ''}${coin.change24h.toFixed(2)}%\n` +
            `• <a href="${link}">Link OKX</a>`;

          console.log(`🚀 [${bType} - ${bGroupName}] Gửi Telegram cho ${symbol}...`);
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          }).catch((err) => console.error('Lỗi gửi Telegram:', err.message));

          sentLog[symbol] = currentTime;
          hasLogUpdated = true;
        } else {
          console.log(`⏳ [${bGroupName}] ${symbol} thỏa điều kiện B nhưng đang trong cooldown 8h.`);
        }
      }

      await sleep(80); // Rate limit tránh bị OKX chặn IP
    }

    if (hasLogUpdated) saveSentLog(sentLog);
    saveScanResults(scanResults);

    console.log('\n================== KẾT QUẢ QUÉT ==================');
    console.log(`Số lượng tín hiệu thỏa mãn: ${scanResults.matched.length}`);
    if (scanResults.matched.length > 0) {
      console.table(scanResults.matched);
    }
    console.log(`📁 File kết quả đã lưu: ${RESULTS_FILE}`);
    console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---\n');

  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
