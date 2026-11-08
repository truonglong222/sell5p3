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
const COOLDOWN_TIME = 1 * 60 * 60 * 1000; // Cooldown 1 giờ
const MIN_VOL_CCY24H = 5_000_000; // Volume 24h > 5 triệu USDT

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

function calculateATR(candles, period = 14) {
  if (!candles || candles.length <= period) return null;

  const trList = [];
  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i][2]);
    const low = parseFloat(candles[i][3]);
    const prevClose = parseFloat(candles[i - 1][4]);

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trList.push(tr);
  }

  if (trList.length < period) return null;

  let atr = trList.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

  for (let i = period; i < trList.length; i++) {
    atr = (atr * (period - 1) + trList[i]) / period;
  }

  const latestClose = parseFloat(candles[candles.length - 1][4]);
  const atrPct = latestClose > 0 ? (atr / latestClose) * 100 : 0;

  return { atr, atrPct };
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
  let passedVol = 0;
  const targetCoins = [];

  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') {
      return { allSwaps, passedVol, targetCoins };
    }

    const tickers = res.data.data.filter((item) => item.instId.endsWith('-USDT-SWAP'));
    allSwaps = tickers.length;

    for (const item of tickers) {
      const vol = parseFloat(item.volCcy24h || 0);
      if (vol > MIN_VOL_CCY24H) {
        passedVol++;
        targetCoins.push({
          instId: item.instId,
          volCcy24h: vol
        });
      }
    }

    return { allSwaps, passedVol, targetCoins };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { allSwaps, passedVol, targetCoins };
  }
}

async function getCandles(symbol, bar = '5m', limit = 100) {
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
    console.log('=== BẮT ĐẦU QUÉT THỊ TRƯỜNG SHORT (BD3 > 1.5%) ===\n');

    const sentLog = loadSentLog();
    const currentTime = Date.now();

    const { allSwaps, passedVol, targetCoins } = await getFilteredMarkets();

    const stats = {
      allSwaps,
      passedVol,
      skippedCooldown: 0,
      candles5mValid: 0,
      passedBD3: 0,
      passedATR: 0,
      passedTrigger5m: 0, // bbm > 0 && diffema55 < -0.2%
      candles15mValid: 0,
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

      // 2. Lấy nến 5m
      const candles5m = await getCandles(symbol, '5m', 80);
      if (!candles5m || candles5m.length < 35) {
        await sleep(60);
        continue;
      }

      // Bỏ nến đang chạy [0], lấy các nến đã đóng
      const closedCandles5m = candles5m.slice(1);
      if (closedCandles5m.length < 25) {
        await sleep(60);
        continue;
      }
      stats.candles5mValid++;

      // 3. Tính bd3: % chênh lệch giá mở cửa nến vừa đóng [1] và nến [3]
      const openJustClosed = parseFloat(candles5m[1][1]);
      const highJustClosed = parseFloat(candles5m[1][2]);
      const open3CandlesAgo = parseFloat(candles5m[3][1]);

      let bd3 = 0;
      if (open3CandlesAgo > 0) {
        bd3 = ((openJustClosed - open3CandlesAgo) / open3CandlesAgo) * 100;
      }

      // Điều kiện 1: bd3 > 1.5%
      if (bd3 <= 1.5) {
        await sleep(60);
        continue;
      }
      stats.passedBD3++;

      // Chuỗi nến 5m theo thứ tự thời gian tăng dần để tính chỉ báo
      const chronological5m = [...closedCandles5m].reverse();

      // 4. Tính ATR (14, 5m) và kiểm tra ATR > 0.7%
      const atrData = calculateATR(chronological5m, 14);
      const atrPct = atrData ? atrData.atrPct : 0;
      const atrVal = atrData ? atrData.atr : 0;

      // Điều kiện 2: atr > 0.7%
      if (atrPct <= 0.7) {
        await sleep(60);
        continue;
      }
      stats.passedATR++;

      // 5. Tính Bollinger Band Mid (SMA 20) trên nến 5m để tính bbm
      const closes5m = chronological5m.map((c) => parseFloat(c[4]));
      const bb5m = calculateBollingerBands(closes5m, 20, 2);
      if (!bb5m) {
        await sleep(60);
        continue;
      }

      // bbm = Giá cao nhất của nến vừa đóng - Bollinger Band Mid
      const bbm = highJustClosed - bb5m.sma;

      // 6. Tính diffema55 trên nến 5m: chênh lệch % EMA20 nến vừa đóng so với 5 nến trước đó
      const emaArray5m = calculateEMA(closes5m, 20);
      let diffema55 = null;
      if (emaArray5m.length >= 6) {
        const emaLatest5m = emaArray5m[emaArray5m.length - 1];
        const ema5BarsAgo5m = emaArray5m[emaArray5m.length - 1 - 5];
        if (ema5BarsAgo5m !== 0) {
          diffema55 = ((emaLatest5m - ema5BarsAgo5m) / ema5BarsAgo5m) * 100;
        }
      }

      if (diffema55 === null) {
        await sleep(60);
        continue;
      }

      // Điều kiện 3: bbm > 0 VÀ diffema55 < -0.2%
      if (!(bbm > 0 && diffema55 < -0.2)) {
        await sleep(60);
        continue;
      }
      stats.passedTrigger5m++;

      // 7. Gọi nến 15m để tính diffema515
      const candles15m = await getCandles(symbol, '15m', 80);
      if (!candles15m || candles15m.length < 35) {
        await sleep(60);
        continue;
      }
      stats.candles15mValid++;

      const closedCandles15m = candles15m.slice(1);
      const chronological15m = [...closedCandles15m].reverse();
      const closes15m = chronological15m.map((c) => parseFloat(c[4]));

      const emaArray15m = calculateEMA(closes15m, 20);
      let diffema515 = null;
      if (emaArray15m.length >= 6) {
        const emaLatest15m = emaArray15m[emaArray15m.length - 1];
        const ema5BarsAgo15m = emaArray15m[emaArray15m.length - 1 - 5];
        if (ema5BarsAgo15m !== 0) {
          diffema515 = ((emaLatest15m - ema5BarsAgo15m) / ema5BarsAgo15m) * 100;
        }
      }

      if (diffema515 === null) {
        await sleep(60);
        continue;
      }

      // Điều kiện 4: diffema515 < -0.7% -> BÁO SHORT
      if (diffema515 < -0.7) {
        sentLog[shortKey] = currentTime;
        saveSentLog(sentLog);

        const bd3Str = `+${bd3.toFixed(2)}%`;
        const atrStr = `${atrVal.toFixed(4)} (~${atrPct.toFixed(2)}%)`;
        const bbmStr = bbm.toFixed(4);
        const diffema55Str = `${diffema55.toFixed(4)}%`;
        const diffema515Str = `${diffema515.toFixed(4)}%`;

        console.log(`[SHORT SIGNAL] ${symbol} | BD3: ${bd3Str} | ATR: ${atrStr} | BBM: ${bbmStr} | diffema55: ${diffema55Str} | diffema515: ${diffema515Str}`);

        const shortMsg =
          `<b>🔴 TÍN HIỆU SHORT</b>\n` +
          `Coin: <b>${coinName}</b>\n` +
          `• BD3: <b>${bd3Str}</b>\n` +
          `• ATR (5m): <b>${atrStr}</b>\n` +
          `• BBM (High - BB Mid 5m): <b>${bbmStr}</b>\n` +
          `• DiffEMA5 (5m): <b>${diffema55Str}</b>\n` +
          `• DiffEMA5 (15m): <b>${diffema515Str}</b>\n` +
          `<a href="${link}">🔗 Giao dịch OKX</a>`;

        const isSent = await sendTelegramMessage(shortMsg);
        if (isSent) stats.shortSentSuccess++;
      }

      await sleep(100);
    }

    // ------------------- BÁO CÁO THỐNG KÊ -------------------
    console.log('\n--- KẾT QUẢ QUÉT THỊ TRƯỜNG ---');
    console.log(`Tổng SWAP: ${stats.allSwaps}`);
    console.log(`Volume > 5M: ${stats.passedVol}`);
    console.log(`Bỏ qua do Cooldown: ${stats.skippedCooldown}`);
    console.log(`Nến 5m hợp lệ: ${stats.candles5mValid}`);
    console.log(`BD3 > 1.5%: ${stats.passedBD3}`);
    console.log(`ATR > 0.7%: ${stats.passedATR}`);
    console.log(`Thỏa BBM > 0 & DiffEMA5(5m) < -0.2%: ${stats.passedTrigger5m}`);
    console.log(`Nến 15m hợp lệ: ${stats.candles15mValid}`);
    console.log(`Gửi Telegram SHORT thành công: ${stats.shortSentSuccess}`);
    console.log('-------------------------------\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
