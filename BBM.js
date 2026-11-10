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

// Cấu hình Cooldown & Ngưỡng lọc
const COOLDOWN_TIME = 8 * 60 * 60 * 1000; // Cooldown 8 giờ
const MIN_CHANGE_24H = -10.0; // Giới hạn dưới: -10%
const MAX_CHANGE_24H = -3.0;  // Giới hạn trên: -3%
const DIFF_EMA3_1H_THRESHOLD = -1.0; // diffema3 1H < -1%

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------- HÀM TIỆN ÍCH TRÁNH LỖI HTML TELEGRAM -------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ------------------- QUẢN LÝ DỮ LIỆU FILE LOG GỬI TIN -------------------
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

// ------------------- HÀM TÍNH TOÁN KỸ THUẬT -------------------

function calculateEMA(prices, period = 20) {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const emaArray = [];
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += prices[i];
  }
  let prevEMA = sum / period;
  emaArray.push(prevEMA);

  for (let i = period; i < prices.length; i++) {
    prevEMA = (prices[i] - prevEMA) * k + prevEMA;
    emaArray.push(prevEMA);
  }
  return emaArray;
}

function calculateBollingerBands(closes, period = 20, multiplier = 2) {
  if (!closes || closes.length < period) return null;

  const slice = closes.slice(-period);
  const sma = slice.reduce((acc, val) => acc + val, 0) / period;

  const variance = slice.reduce((acc, val) => acc + Math.pow(val - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = sma + (multiplier * stdDev);
  const lower = sma - (multiplier * stdDev);

  let hbb = 0;
  if (lower > 0) {
    hbb = ((upper - lower) / lower) * 100;
  }

  return { upper, lower, sma, hbb };
}

// ------------------- LỌC THỊ TRƯỜNG & LẤY NẾN -------------------

async function getFilteredMarkets() {
  let allSwaps = 0;
  let passedChange24h = 0;
  const targetCoins = [];

  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') {
      return { allSwaps, passedChange24h, targetCoins };
    }

    const tickers = res.data.data.filter((item) => item.instId.endsWith('-USDT-SWAP'));
    allSwaps = tickers.length;

    for (const item of tickers) {
      const open24h = parseFloat(item.open24h || 0);
      const lastPrice = parseFloat(item.last || 0);

      if (open24h > 0) {
        const bd24 = ((lastPrice - open24h) / open24h) * 100;
        
        // Điều kiện: -10% < bd24 < -3%
        if (bd24 > MIN_CHANGE_24H && bd24 < MAX_CHANGE_24H) {
          passedChange24h++;
          targetCoins.push({
            instId: item.instId,
            bd24: bd24
          });
        }
      }
    }

    return { allSwaps, passedChange24h, targetCoins };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { allSwaps, passedChange24h, targetCoins };
  }
}

async function getCandles(symbol, bar = '1H', limit = 100) {
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
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }, { timeout: 8000 });
    return true;
  } catch (err) {
    console.error('Lỗi gửi Telegram:', err.response ? JSON.stringify(err.response.data) : err.message);
    return false;
  }
}

// ------------------- TIẾN TRÌNH CHÍNH -------------------

async function main() {
  try {
    console.log('=== BẮT ĐẦU QUÉT THỊ TRƯỜNG SHORT (-10% < bd24 < -3%, DiffEMA3 1H < -1%, BBM 5m > 0) ===\n');

    const sentLog = loadSentLog();
    const currentTime = Date.now();

    const { allSwaps, passedChange24h, targetCoins } = await getFilteredMarkets();

    const stats = {
      allSwaps,
      passedChange24h,
      skippedCooldown: 0,
      passedDiffEMA3_1H: 0,
      passedBBM_5m: 0,
      shortSentSuccess: 0
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;
      const coinName = escapeHtml(symbol.replace('-USDT-SWAP', ''));
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      // 1. Kiểm tra Cooldown Short
      const shortKey = `${symbol}_SHORT`;
      const lastSentShort = sentLog[shortKey] || 0;
      if (currentTime - lastSentShort < COOLDOWN_TIME) {
        stats.skippedCooldown++;
        continue;
      }

      // 2. Lấy nến 1H và tính diffema3 (1H)
      const candles1H = await getCandles(symbol, '1H', 50);
      if (!candles1H || candles1H.length < 30) {
        await sleep(60);
        continue;
      }

      // Bỏ nến chưa đóng [0]
      const closedCandles1H = candles1H.slice(1);
      const chronological1H = [...closedCandles1H].reverse();
      const closes1H = chronological1H.map((c) => parseFloat(c[4]));

      const emaArray1H = calculateEMA(closes1H, 20);
      let diffema3_1h = null;

      // Cần tối thiểu 4 giá trị EMA để so sánh cây hiện tại với 3 cây trước
      if (emaArray1H.length >= 4) {
        const emaLatest1H = emaArray1H[emaArray1H.length - 1];
        const ema3BarsAgo1H = emaArray1H[emaArray1H.length - 1 - 3];
        if (ema3BarsAgo1H !== 0) {
          diffema3_1h = ((emaLatest1H - ema3BarsAgo1H) / ema3BarsAgo1H) * 100;
        }
      }

      // Điều kiện: diffema3 1H < -1%
      if (diffema3_1h === null || diffema3_1h >= DIFF_EMA3_1H_THRESHOLD) {
        await sleep(60);
        continue;
      }
      stats.passedDiffEMA3_1H++;

      // 3. Lấy nến 5m và tính BBM (5m)
      const candles5m = await getCandles(symbol, '5m', 50);
      if (!candles5m || candles5m.length < 25) {
        await sleep(60);
        continue;
      }

      const closedCandles5m = candles5m.slice(1);
      const chronological5m = [...closedCandles5m].reverse();
      const closes5m = chronological5m.map((c) => parseFloat(c[4]));

      const bb5m = calculateBollingerBands(closes5m, 20, 2);
      if (!bb5m) {
        await sleep(60);
        continue;
      }

      // bbm = High của nến vừa đóng - Middle Band (SMA 20) nến 5m
      const highJustClosed5m = parseFloat(candles5m[1][2]);
      const bbm = highJustClosed5m - bb5m.sma;

      // Điều kiện: bbm > 0
      if (bbm <= 0) {
        await sleep(60);
        continue;
      }
      stats.passedBBM_5m++;

      // 4. Thỏa mãn toàn bộ điều kiện -> Gửi cảnh báo SHORT
      sentLog[shortKey] = currentTime;
      saveSentLog(sentLog);

      const bd24Str = `${coin.bd24.toFixed(2)}%`;
      const diffema3_1hStr = `${diffema3_1h.toFixed(4)}%`;
      const bbmStr = bbm.toFixed(4);

      console.log(`[SHORT SIGNAL] ${symbol} | 24h: ${bd24Str} | DiffEMA3(1H): ${diffema3_1hStr} | BBM(5m): ${bbmStr}`);

      const shortMsg =
        `<b>🔴 TÍN HIỆU SHORT</b>\n` +
        `Coin: <b>${coinName}</b>\n` +
        `• Biến động 24h: <b>${bd24Str}</b>\n` +
        `• DiffEMA3 (1H): <b>${diffema3_1hStr}</b>\n` +
        `• BBM 5m (High - BB Mid): <b>${bbmStr}</b>\n` +
        `<a href="${link}">🔗 Giao dịch OKX</a>`;

      const isSent = await sendTelegramMessage(shortMsg);
      if (isSent) stats.shortSentSuccess++;

      await sleep(100);
    }

    // ------------------- BÁO CÁO THỐNG KÊ -------------------
    console.log('\n--- KẾT QUẢ QUÉT THỊ TRƯỜNG ---');
    console.log(`Tổng SWAP: ${stats.allSwaps}`);
    console.log(`Biến động (-10% < 24h < -3%): ${stats.passedChange24h}`);
    console.log(`Bỏ qua do Cooldown: ${stats.skippedCooldown}`);
    console.log(`Thỏa DiffEMA3 (1H) < -1%: ${stats.passedDiffEMA3_1H}`);
    console.log(`Thỏa BBM (5m) > 0: ${stats.passedBBM_5m}`);
    console.log(`Gửi Telegram SHORT thành công: ${stats.shortSentSuccess}`);
    console.log('-------------------------------\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
