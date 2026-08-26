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

// Cấu hình Cooldown: 8 TIẾNG (Dùng chung cho tất cả các trường hợp)
const COOLDOWN_TIME = 8 * 60 * 60 * 1000;
const MIN_VOL_CCY24H = 5_000_000; // Lọc Volume 24h > 5 triệu USDT

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------- QUẢN LÝ LỊCH SỬ GỬI TIN -------------------
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
    for (const [coin, lastAlertTime] of Object.entries(logData)) {
      if (now - lastAlertTime < COOLDOWN_TIME) {
        cleanedLog[coin] = lastAlertTime;
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
function calculateEMA(prices, period = 20) {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const emaArray = [];

  // Khởi tạo EMA đầu tiên bằng SMA
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

// 2. Lấy nến 4H
async function getCandles4h(symbol) {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=4H&limit=60`;
    const res = await axios.get(url, { timeout: 5000 });
    if (!res.data || res.data.code !== '0' || res.data.data.length < 35) return null;
    return res.data.data;
  } catch (error) {
    console.error(`Lỗi lấy dữ liệu nến 4H (${symbol}):`, error.message);
    return null;
  }
}

// 3. Lấy nến 1H
async function getCandles1h(symbol) {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=50`;
    const res = await axios.get(url, { timeout: 5000 });
    if (!res.data || res.data.code !== '0' || res.data.data.length < 25) return null;
    return res.data.data;
  } catch (error) {
    console.error(`Lỗi lấy dữ liệu nến 1H (${symbol}):`, error.message);
    return null;
  }
}

// ------------------- TIẾN TRÌNH CHÍNH -------------------
async function main() {
  try {
    console.log('--- BẮT ĐẦU QUÉT THỊ TRƯỜNG OKX ---');

    const sentLog = loadSentLog();
    const currentTime = Date.now();
    let hasNewAlert = false;

    // Bước 1: Lọc Market sơ bộ (Vol > 5M, Biến động 24h [-5%, +5%])
    const targetCoins = await getFilteredMarkets();
    console.log(`📊 Số coin thỏa Vol > 5M và Biến động 24h [-5%, +5%]: ${targetCoins.length}`);

    const scanResults = {
      totalScanned: targetCoins.length,
      matched: []
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // Bước 2: Kiểm tra nến 4H & tính diffema10
      const raw4h = await getCandles4h(symbol);
      if (!raw4h) {
        await sleep(80);
        continue;
      }

      // Sắp xếp giá đóng cửa từ quá khứ đến hiện tại
      const closes4hAsc = raw4h.map((c) => parseFloat(c[4])).reverse();
      const ema4hList = calculateEMA(closes4hAsc, 20);

      if (ema4hList.length < 11) {
        await sleep(80);
        continue;
      }

      // Nến 4h hiện tại là phần tử cuối, nến 4h cách đó 10 nến lùi về 10 vị trí
      const emaCurrent = ema4hList[ema4hList.length - 1];
      const ema10Ago = ema4hList[ema4hList.length - 11];
      const diffema10 = ((emaCurrent - ema10Ago) / ema10Ago) * 100;

      // Điều kiện diffema10 trong khoảng [-2%, +2%]
      if (diffema10 < -2 || diffema10 > 2) {
        await sleep(80);
        continue;
      }

      // Bước 3: Lấy nến 1H & tính các chỉ số kỹ thuật
      const raw1h = await getCandles1h(symbol);
      if (!raw1h) {
        await sleep(80);
        continue;
      }

      // raw1h[0] là nến đang chạy, raw1h[1] là nến 1h vừa đóng cửa
      const closedCandle1h = raw1h[1];
      const o1 = parseFloat(closedCandle1h[1]);
      const c1 = parseFloat(closedCandle1h[4]);
      const change1h = ((c1 - o1) / o1) * 100;

      // Tính Bollinger Bands 1H tại thời điểm nến vừa đóng (index 1 -> 20)
      const closes1hClosedAsc = raw1h.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
      const bb1h = calculateBollingerBands(closes1hClosedAsc, 20, 2);

      if (!bb1h) {
        await sleep(80);
        continue;
      }

      const Hbb = ((bb1h.upper - bb1h.lower) / bb1h.lower) * 100;

      // Điều kiện Hbb > 3%
      if (Hbb <= 3) {
        await sleep(80);
        continue;
      }

      // Tính x = biến động nến 1h vừa đóng / Hbb
      const x = change1h / Hbb;

      // Tính bbd1h và bbt1h
      const bbd1h = ((c1 - bb1h.lower) / bb1h.lower) * 100;
      const bbt1h = ((c1 - bb1h.upper) / bb1h.upper) * 100;

      // Bước 4: Phân loại theo 4 nhóm tín hiệu
      let alertType = null;
      let groupName = '';

      if (x > 0.4 && c1 < bb1h.upper) {
        alertType = 'LONG';
        groupName = 'Nhóm A1';
      } else if (x < -0.4 && c1 > bb1h.lower) {
        alertType = 'SHORT';
        groupName = 'Nhóm A2';
      } else if (bbd1h > -3 && bbd1h < -0.5) {
        alertType = 'LONG';
        groupName = 'Nhóm B1';
      } else if (bbt1h > 0.5 && bbt1h < 3) {
        alertType = 'SHORT';
        groupName = 'Nhóm B2';
      }

      // Bước 5: Gửi cảnh báo Telegram
      if (alertType) {
        const coinName = symbol.replace('-USDT-SWAP', '');
        const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
        const isCooldown = currentTime - (sentLog[symbol] || 0) < COOLDOWN_TIME;

        scanResults.matched.push({
          symbol,
          type: alertType,
          group: groupName,
          Hbb: Hbb.toFixed(2) + '%',
          x: x.toFixed(2),
          diffema10: diffema10.toFixed(2) + '%',
          bandDiff: (alertType === 'LONG' ? bbd1h : bbt1h).toFixed(2) + '%',
          change24h: coin.change24h.toFixed(2) + '%',
          teleSent: !isCooldown
        });

        if (!isCooldown) {
          const icon = alertType === 'LONG' ? '🟢' : '🔴';
          const bandLine = alertType === 'LONG'
            ? `• <b>bbd1h:</b> ${bbd1h.toFixed(2)}%\n`
            : `• <b>bbt1h:</b> ${bbt1h.toFixed(2)}%\n`;

          // Thứ tự nội dung: Hbb -> x -> diffema10 -> bbd1h/bbt1h -> Biến động 24h -> Link OKX
          const message = `${icon} <b>TÍN HIỆU ${alertType} (${groupName}): ${coinName}</b>\n` +
            `• <b>Hbb:</b> ${Hbb.toFixed(2)}%\n` +
            `• <b>x:</b> ${x.toFixed(2)}\n` +
            `• <b>diffema10:</b> ${diffema10.toFixed(2)}%\n` +
            bandLine +
            `• <b>Biến động 24h:</b> ${coin.change24h > 0 ? '+' : ''}${coin.change24h.toFixed(2)}%\n` +
            `• <a href="${link}">Link OKX</a>`;

          console.log(`🚀 [${alertType} - ${groupName}] Gửi Telegram cho ${symbol}...`);
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          }).catch((err) => console.error('Lỗi gửi Telegram:', err.message));

          sentLog[symbol] = currentTime;
          hasNewAlert = true;
        }
      }

      await sleep(80); // Rate limit tránh bị OKX chặn IP
    }

    if (hasNewAlert) saveSentLog(sentLog);
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
