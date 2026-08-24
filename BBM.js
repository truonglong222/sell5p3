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

// Cấu hình Cooldown: 4 TIẾNG
const COOLDOWN_TIME = 4 * 60 * 60 * 1000;
const MIN_VOL_CCY24H = 5_000_000; // Volume 24h > 5 triệu USDT

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    for (const [coin, timeData] of Object.entries(logData)) {
      const temp = {};
      if (timeData.longAlert && now - timeData.longAlert < COOLDOWN_TIME) {
        temp.longAlert = timeData.longAlert;
      }
      if (timeData.shortAlert && now - timeData.shortAlert < COOLDOWN_TIME) {
        temp.shortAlert = timeData.shortAlert;
      }
      if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
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

// Tính mảng EMA (mảng prices theo thứ tự thời gian tăng dần: cũ nhất -> mới nhất)
function calculateEMAArray(prices, period = 20) {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const emaArray = [];
  
  // Giá trị đầu tiên là SMA
  let sum = 0;
  for (let i = 0; i < period; i++) sum += prices[i];
  let currentEma = sum / period;
  emaArray.push(currentEma);

  for (let i = period; i < prices.length; i++) {
    currentEma = prices[i] * k + currentEma * (1 - k);
    emaArray.push(currentEma);
  }
  return emaArray;
}

// Tính Bollinger Bands cho nến đóng gần nhất
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

// ------------------- LỌC THỊ TRƯỜNG THEO VOLUME VÀ % 24H -------------------
async function getFilteredMarkets() {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') return [];

    const tickers = res.data.data;
    return tickers
      .filter(item => item.instId.endsWith('-USDT-SWAP'))
      .map(item => {
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
      .filter(c => c.volCcy24h > MIN_VOL_CCY24H && c.change24h >= -5 && c.change24h <= 5);
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return [];
  }
}

// ------------------- LẤY DỮ LIỆU NẾN (OKX API) -------------------
async function getCandles(symbol, bar, limit = 100) {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 6000 });
    if (!res.data || res.data.code !== '0' || res.data.data.length < 35) return null;
    return res.data.data; // Dữ liệu trả về từ nến mới nhất [0] -> nến cũ nhất [limit - 1]
  } catch (error) {
    console.error(`Lỗi lấy dữ liệu nến ${bar} (${symbol}):`, error.message);
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

    // BƯỚC 1: Lọc Volume > 5M và biến động 24h từ -5% đến +5%
    const targetCoins = await getFilteredMarkets();
    console.log(`🔍 Số coin thỏa mãn điều kiện Vol > 5M và 24h (-5% -> +5%): ${targetCoins.length}`);

    const scanResults = {
      totalScanned: targetCoins.length,
      matched: []
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // BƯỚC 2: Lấy nến 4H để tính diffema10
      const candles4h = await getCandles(symbol, '4H', 100);
      if (!candles4h) {
        await sleep(80);
        continue;
      }

      // Đảo ngược mảng giá đóng cửa để có thứ tự thời gian cũ -> mới
      const closes4h = candles4h.map(c => parseFloat(c[4])).reverse();
      const ema4hArray = calculateEMAArray(closes4h, 20);

      if (ema4hArray.length < 11) {
        await sleep(80);
        continue;
      }

      // EMA nến hiện tại (cuối mảng) và EMA cách đó 10 nến
      const ema0 = ema4hArray[ema4hArray.length - 1];
      const ema10 = ema4hArray[ema4hArray.length - 11];
      const diffema10 = ema10 > 0 ? ((ema0 - ema10) / ema10) * 100 : 0;

      // Điều kiện: diffema10 nằm trong khoảng -2% đến +2%
      if (diffema10 < -2 || diffema10 > 2) {
        await sleep(80);
        continue;
      }

      // BƯỚC 3: Lấy nến 1H để tính BB và các chỉ số liên quan
      const candles1h = await getCandles(symbol, '1H', 50);
      if (!candles1h) {
        await sleep(80);
        continue;
      }

      // Nến 1h vừa đóng (index 1) hoặc nến hiện tại (index 0)
      // Lấy chuỗi 20 nến từ nến vừa đóng [1..20] theo thứ tự cũ -> mới
      const closedCandle1h = candles1h[1] || candles1h[0];
      const currentPrice1h = parseFloat(closedCandle1h[4]); // Giá close của nến vừa đóng

      const closes1hForBB = candles1h.slice(1, 21).map(c => parseFloat(c[4])).reverse();
      const bb1h = calculateBollingerBands(closes1hForBB, 20);

      if (!bb1h || bb1h.lower <= 0 || bb1h.upper <= 0) {
        await sleep(80);
        continue;
      }

      // Tính Hbb, bbd1h, bbt1h
      const Hbb = ((bb1h.upper - bb1h.lower) / bb1h.lower) * 100;
      const bbd1h = ((currentPrice1h - bb1h.lower) / bb1h.lower) * 100;
      const bbt1h = ((currentPrice1h - bb1h.upper) / bb1h.upper) * 100;

      // Điều kiện tiên quyết: Hbb > 3%
      if (Hbb <= 3) {
        await sleep(80);
        continue;
      }

      // BƯỚC 4: Kiểm tra điều kiện Long / Short
      // Long: -2% < bbd1h < 0.5%
      const isLong = bbd1h > -2 && bbd1h < 0.5;
      // Short: -0.5% < bbt1h < 2%
      const isShort = bbt1h > -0.5 && bbt1h < 2;

      if (isLong || isShort) {
        const type = isLong ? 'LONG' : 'SHORT';
        const coinName = symbol.replace('-USDT-SWAP', '');
        const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

        if (!sentLog[symbol]) sentLog[symbol] = {};
        const lastSentTime = isLong ? sentLog[symbol].longAlert : sentLog[symbol].shortAlert;
        const isCooldown = currentTime - (lastSentTime || 0) < COOLDOWN_TIME;

        scanResults.matched.push({
          symbol,
          type,
          Hbb: Hbb.toFixed(2) + '%',
          diffema10: diffema10.toFixed(2) + '%',
          bbd1h: bbd1h.toFixed(2) + '%',
          bbt1h: bbt1h.toFixed(2) + '%',
          change24h: coin.change24h.toFixed(2) + '%',
          teleSent: !isCooldown
        });

        if (!isCooldown) {
          const icon = isLong ? '🟢' : '🔴';
          // Thứ tự: Hbb -> diffema10 -> bbd1h -> bbt1h -> % biến động 24h -> Link OKX
          const message = `${icon} <b>TÍN HIỆU ${type}: ${coinName}</b>\n` +
            `• <b>Hbb:</b> ${Hbb.toFixed(2)}%\n` +
            `• <b>diffema10:</b> ${diffema10.toFixed(2)}%\n` +
            `• <b>bbd1h:</b> ${bbd1h.toFixed(2)}%\n` +
            `• <b>bbt1h:</b> ${bbt1h.toFixed(2)}%\n` +
            `• <b>Biến động 24h:</b> ${coin.change24h >= 0 ? '+' : ''}${coin.change24h.toFixed(2)}%\n` +
            `• <a href="${link}">Link OKX</a>`;

          console.log(`🚀 [${type}] Gửi Telegram cho ${symbol}...`);
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

          if (isLong) sentLog[symbol].longAlert = currentTime;
          if (isShort) sentLog[symbol].shortAlert = currentTime;
          hasNewAlert = true;
        }
      }

      await sleep(80);
    }

    if (hasNewAlert) saveSentLog(sentLog);

    // Ghi kết quả quét ra file
    saveScanResults(scanResults);

    console.log('\n================== KẾT QUẢ QUÉT ==================');
    console.log(`Số tín hiệu thỏa mãn: ${scanResults.matched.length}`);
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
