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

// Cấu hình các ngưỡng điều kiện
const COOLDOWN_TIME = 4 * 60 * 60 * 1000; // Countdown 4 giờ
const MIN_BD24 = 5.0; // Biến động 24h > 5%
const MIN_HBB = 3.0; // Hbb > 3%

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cleanExpiredLogs(logData) {
  const now = Date.now();
  const cleanedLog = {};
  for (const [key, timestamp] of Object.entries(logData)) {
    if (now - timestamp < COOLDOWN_TIME) {
      cleanedLog[key] = timestamp;
    }
  }
  return cleanedLog;
}

function loadSentLog() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      const rawLog = data.trim() ? JSON.parse(data) : {};
      const cleanedLog = cleanExpiredLogs(rawLog);
      if (Object.keys(cleanedLog).length !== Object.keys(rawLog).length) {
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
      }
      return cleanedLog;
    }
  } catch (e) {
    console.error('Lỗi khi đọc sent_ema.json:', e.message);
  }
  return {};
}

function saveSentLog(logData) {
  try {
    const cleanedLog = cleanExpiredLogs(logData);
    fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
  } catch (e) {
    console.error('Lỗi khi lưu sent_ema.json:', e.message);
  }
}

function calculateEMA(prices, period = 20) {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const emaArray = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += prices[i];
  let prevEMA = sum / period;
  emaArray.push(prevEMA);

  for (let i = period; i < prices.length; i++) {
    prevEMA = (prices[i] - prevEMA) * k + prevEMA;
    emaArray.push(prevEMA);
  }
  return emaArray;
}

function calculateDiffEMA(closes, lookbackCandles = 20, period = 20) {
  const emaArray = calculateEMA(closes, period);
  if (emaArray.length <= lookbackCandles) return null;

  const emaCurrent = emaArray[emaArray.length - 1];
  const emaPrev = emaArray[emaArray.length - 1 - lookbackCandles];
  if (emaPrev === 0) return null;

  return ((emaCurrent - emaPrev) / emaPrev) * 100;
}

// Tính các dải Bollinger Band (Upper, Middle, Lower)
function calculateBollingerBands(closes, period = 20, multiplier = 2) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((acc, val) => acc + val, 0) / period;
  const variance = slice.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    upper: mean + multiplier * stdDev,
    middle: mean,
    lower: mean - multiplier * stdDev
  };
}

// 1. Lấy danh sách cặp USDT-SWAP và lọc biến động 24h (bd24) > 5%
async function getFilteredMarketsByBD24() {
  let totalSwaps = 0;
  const targetCoins = [];

  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') {
      return { totalSwaps, targetCoins };
    }

    const tickers = res.data.data.filter((item) => item.instId.endsWith('-USDT-SWAP'));
    totalSwaps = tickers.length;

    for (const item of tickers) {
      const last = parseFloat(item.last || 0);
      const open24h = parseFloat(item.open24h || 0);
      if (open24h <= 0) continue;

      const bd24 = ((last - open24h) / open24h) * 100;
      if (bd24 > MIN_BD24) {
        targetCoins.push({ instId: item.instId, bd24 });
      }
    }

    return { totalSwaps, targetCoins };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { totalSwaps, targetCoins };
  }
}

async function getCandles(symbol, bar = '15m', limit = 60) {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0' || !Array.isArray(res.data.data)) {
      return null;
    }
    return res.data.data;
  } catch (error) {
    return null;
  }
}

async function sendTelegramMessage(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('\n❌ [TELEGRAM ERROR] Thiếu cấu hình BOT_TOKEN hoặc CHAT_ID\n');
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(
      url,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      },
      { timeout: 8000 }
    );
    return true;
  } catch (err) {
    console.error('Lỗi gửi Telegram:', err.response ? JSON.stringify(err.response.data) : err.message);
    return false;
  }
}

async function main() {
  try {
    console.log('=== BẮT ĐẦU QUÉT THỊ TRƯỜNG (KHUNG 15M) ===\n');

    const sentLog = loadSentLog();
    const currentTime = Date.now();

    // Bước 1: Lọc biến động 24h (bd24) > 5%
    const { totalSwaps, targetCoins } = await getFilteredMarketsByBD24();

    // Lưu danh sách coin qua từng bước lọc
    const filterSteps = {
      totalSwaps,
      afterBD24: targetCoins.map((c) => c.instId.replace('-USDT-SWAP', '')),
      afterCooldown: [],
      afterDiffEMA20: [],
      afterBBT: [],
      afterHbb: [],
      telegramSent: []
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;
      const shortName = symbol.replace('-USDT-SWAP', '');
      const coinName = escapeHtml(shortName);
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      // Bước 2: Kiểm tra Cooldown 4h
      const shortKey = `${symbol}_SHORT`;
      const lastSent = sentLog[shortKey] || 0;
      if (currentTime - lastSent < COOLDOWN_TIME) {
        continue;
      }
      filterSteps.afterCooldown.push(shortName);

      // Lấy dữ liệu nến 15m (cần tối thiểu 41 nến: 1 đang chạy + 20 tính EMA + 20 lùi)
      const candles15m = await getCandles(symbol, '15m', 60);
      if (!candles15m || candles15m.length < 45) {
        await sleep(50);
        continue;
      }

      // Nến index 0 là nến đang chạy; nến index 1 là nến vừa đóng
      const closed15m = candles15m.slice(1);
      const chronological15m = [...closed15m].reverse(); // Sắp xếp từ cũ -> mới
      const closes15m = chronological15m.map((c) => parseFloat(c[4]));

      // Bước 3: Lọc diffema20 (15m) < 0
      const diffema20 = calculateDiffEMA(closes15m, 20, 20);
      if (diffema20 === null || diffema20 >= 0) {
        await sleep(50);
        continue;
      }
      filterSteps.afterDiffEMA20.push(shortName);

      // Bước 4: Tính bbt (15m) và lọc bbt > 0%
      // bbt = chênh lệch % giá cao nhất của nến 15m vừa đóng và giá trị BB trên của nến 15m vừa đóng
      const highJustClosed15m = parseFloat(closed15m[0][2]);
      const bb = calculateBollingerBands(closes15m, 20, 2);
      if (!bb || bb.upper <= 0 || bb.middle <= 0) {
        await sleep(50);
        continue;
      }

      const bbt = ((highJustClosed15m - bb.upper) / bb.upper) * 100;
      if (bbt <= 0) {
        await sleep(50);
        continue;
      }
      filterSteps.afterBBT.push(shortName);

      // Bước 5: Tính Hbb (độ rộng Bollinger Band %) và lọc Hbb > 3%
      const hbb = ((bb.upper - bb.lower) / bb.middle) * 100;
      if (hbb <= MIN_HBB) {
        await sleep(50);
        continue;
      }
      filterSteps.afterHbb.push(shortName);

      // Bước 6: Thỏa mãn toàn bộ -> Lưu log Cooldown 4h & Gửi Telegram
      sentLog[shortKey] = currentTime;
      saveSentLog(sentLog);

      const bd24Str = `+${coin.bd24.toFixed(2)}%`;
      const diffema20Str = `${diffema20.toFixed(4)}%`;
      const hbbStr = `${hbb.toFixed(2)}%`;
      const bbtStr = `+${bbt.toFixed(4)}%`;

      console.log(
        `[SHORT SIGNAL] ${symbol} | bd24: ${bd24Str} | diffema20: ${diffema20Str} | Hbb: ${hbbStr} | bbt: ${bbtStr}`
      );

      const shortMsg =
        `<b>🔴 TÍN HIỆU SHORT (15M)</b>\n` +
        `Coin: <b>${coinName}</b>\n` +
        `• bd24: <b>${bd24Str}</b>\n` +
        `• diffema20: <b>${diffema20Str}</b>\n` +
        `• Hbb: <b>${hbbStr}</b>\n` +
        `• bbt: <b>${bbtStr}</b>\n` +
        `<a href="${link}">🔗 Giao dịch OKX</a>`;

      const isSent = await sendTelegramMessage(shortMsg);
      if (isSent) {
        filterSteps.telegramSent.push(shortName);
      }

      await sleep(100);
    }

    // In thống kê số lượng & danh sách coin còn lại sau mỗi bước lọc
    const formatList = (arr) => (arr.length > 0 ? `[${arr.join(', ')}]` : '[]');

    console.log('\n--- DANH SÁCH & SỐ LƯỢNG COIN CÒN LẠI SAU MỖI BƯỚC LỌC ---');
    console.log(`1. Tổng cặp USDT-SWAP: ${filterSteps.totalSwaps}`);
    console.log(
      `2. Sau lọc bd24 > ${MIN_BD24}% (${filterSteps.afterBD24.length}): ${formatList(filterSteps.afterBD24)}`
    );
    console.log(
      `3. Sau lọc Cooldown 4h (${filterSteps.afterCooldown.length}): ${formatList(filterSteps.afterCooldown)}`
    );
    console.log(
      `4. Sau lọc diffema20 (15m) < 0 (${filterSteps.afterDiffEMA20.length}): ${formatList(filterSteps.afterDiffEMA20)}`
    );
    console.log(
      `5. Sau lọc bbt (15m) > 0% (${filterSteps.afterBBT.length}): ${formatList(filterSteps.afterBBT)}`
    );
    console.log(
      `6. Sau lọc Hbb (15m) > ${MIN_HBB}% (${filterSteps.afterHbb.length}): ${formatList(filterSteps.afterHbb)}`
    );
    console.log(
      `7. Đã gửi Telegram (${filterSteps.telegramSent.length}): ${formatList(filterSteps.telegramSent)}`
    );
    console.log('-----------------------------------------------------------\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
