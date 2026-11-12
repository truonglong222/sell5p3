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
const COOLDOWN_TIME = 24 * 60 * 60 * 1000; // 24 giờ
const MIN_VOL_24H = 5_000_000; // 5 triệu USDT
const MIN_BD5 = 2.0; // Biến động 5 nến 5m > 2%

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

function calculateDiffEMA(closes, lookbackCandles, period = 20) {
  const emaArray = calculateEMA(closes, period);
  if (emaArray.length <= lookbackCandles) return null;

  const emaCurrent = emaArray[emaArray.length - 1];
  const emaPrev = emaArray[emaArray.length - 1 - lookbackCandles];
  if (emaPrev === 0) return null;

  return ((emaCurrent - emaPrev) / emaPrev) * 100;
}

// Tính dải trên Bollinger Band (BB Upper = SMA20 + 2 * StdDev20)
function calculateBollingerBandUpper(closes, period = 20, multiplier = 2) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((acc, val) => acc + val, 0) / period;
  const variance = slice.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return mean + multiplier * stdDev;
}

// 1. Lấy danh sách cặp USDT-SWAP và lọc Volume 24h > 5 triệu USD
async function getFilteredMarketsByVolume() {
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
      // volCcy24h là khối lượng giao dịch 24h tính theo đồng định giá (USDT)
      const vol24h = parseFloat(item.volCcy24h || 0);
      if (vol24h > MIN_VOL_24H) {
        targetCoins.push({ instId: item.instId, vol24h });
      }
    }

    return { totalSwaps, targetCoins };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { totalSwaps, targetCoins };
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

async function main() {
  try {
    console.log('=== BẮT ĐẦU QUÉT THỊ TRƯỜNG ===\n');

    const sentLog = loadSentLog();
    const currentTime = Date.now();

    // Bước 1: Lọc Volume 24h > 5 triệu USD
    const { totalSwaps, targetCoins } = await getFilteredMarketsByVolume();

    // Khởi tạo bộ đếm thống kê số coin còn lại qua từng điều kiện
    const counts = {
      total: totalSwaps,
      afterVol24h: targetCoins.length,
      afterCooldown: 0,
      afterBD5: 0,
      afterBBT: 0,
      afterDiffEMA9_5m: 0,
      afterDiffEMA10_15m: 0,
      telegramSent: 0
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;
      const coinName = escapeHtml(symbol.replace('-USDT-SWAP', ''));
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      // Bước 2: Kiểm tra Cooldown 24h
      const shortKey = `${symbol}_SHORT`;
      const lastSent = sentLog[shortKey] || 0;
      if (currentTime - lastSent < COOLDOWN_TIME) {
        continue;
      }
      counts.afterCooldown++;

      // Lấy dữ liệu nến 5m (cần tối thiểu 30 nến: 1 đang chạy + 20 tính EMA/BB + 9 lùi)
      const candles5m = await getCandles(symbol, '5m', 60);
      if (!candles5m || candles5m.length < 35) {
        await sleep(50);
        continue;
      }

      // Nến index 0 là nến đang chạy; nến index 1 là nến vừa đóng
      const closed5m = candles5m.slice(1);
      const chronological5m = [...closed5m].reverse(); // Sắp xếp từ cũ -> mới
      const closes5m = chronological5m.map((c) => parseFloat(c[4]));

      // Bước 3: Lọc bd5 > 2% (Biến động 5 nến 5m gần nhất vừa đóng)
      // Open của nến thứ 5 tính từ cuối lên (closed5m[4][1]) -> Close của nến vừa đóng (closed5m[0][4])
      const open5CandlesAgo = parseFloat(closed5m[4][1]);
      const closeJustClosed5m = parseFloat(closed5m[0][4]);
      if (open5CandlesAgo <= 0) {
        await sleep(50);
        continue;
      }
      const bd5 = ((closeJustClosed5m - open5CandlesAgo) / open5CandlesAgo) * 100;
      if (bd5 <= MIN_BD5) {
        await sleep(50);
        continue;
      }
      counts.afterBD5++;

      // Bước 4: Lọc bbt > 0
      // bbt = Giá cao nhất nến 5m vừa đóng - Giá trị Bollinger Band trên của nến 5m vừa đóng
      const highJustClosed5m = parseFloat(closed5m[0][2]);
      const bbUpper5m = calculateBollingerBandUpper(closes5m, 20, 2);
      if (bbUpper5m === null) {
        await sleep(50);
        continue;
      }
      const bbt = highJustClosed5m - bbUpper5m;
      if (bbt <= 0) {
        await sleep(50);
        continue;
      }
      counts.afterBBT++;

      // Bước 5: Tính diffema9 (5m) > 0
      const diffema9_5m = calculateDiffEMA(closes5m, 9, 20);
      if (diffema9_5m === null || diffema9_5m <= 0) {
        await sleep(50);
        continue;
      }
      counts.afterDiffEMA9_5m++;

      // Bước 6: Gọi nến 15m của những coin thỏa mãn và kiểm tra diffema10 (15m) < -0.5%
      const candles15m = await getCandles(symbol, '15m', 60);
      if (!candles15m || candles15m.length < 35) {
        await sleep(50);
        continue;
      }

      const closed15m = candles15m.slice(1);
      const chronological15m = [...closed15m].reverse();
      const closes15m = chronological15m.map((c) => parseFloat(c[4]));

      const diffema10_15m = calculateDiffEMA(closes15m, 10, 20);
      if (diffema10_15m === null || diffema10_15m >= -0.5) {
        await sleep(50);
        continue;
      }
      counts.afterDiffEMA10_15m++;

      // Bước 7: Thỏa mãn toàn bộ -> Lưu log Cooldown 24h & Gửi Telegram
      sentLog[shortKey] = currentTime;
      saveSentLog(sentLog);

      const volStr = `${(coin.vol24h / 1_000_000).toFixed(2)}M$`;
      const bd5Str = `+${bd5.toFixed(2)}%`;
      const bbtStr = `${bbt.toFixed(6)}`;
      const diffema9Str = `+${diffema9_5m.toFixed(4)}%`;
      const diffema10Str = `${diffema10_15m.toFixed(4)}%`;

      console.log(
        `[SHORT SIGNAL] ${symbol} | Vol24h: ${volStr} | BD5: ${bd5Str} | BBT: ${bbtStr} | DiffEMA9(5m): ${diffema9Str} | DiffEMA10(15m): ${diffema10Str}`
      );

      const shortMsg =
        `<b>🔴 TÍN HIỆU SHORT</b>\n` +
        `Coin: <b>${coinName}</b>\n` +
        `• Volume 24h: <b>${volStr}</b>\n` +
        `• BD5 (5m): <b>${bd5Str}</b>\n` +
        `• BBT (5m): <b>${bbtStr}</b>\n` +
        `• DiffEMA9 (5m): <b>${diffema9Str}</b>\n` +
        `• DiffEMA10 (15m): <b>${diffema10Str}</b>\n` +
        `<a href="${link}">🔗 Giao dịch OKX</a>`;

      const isSent = await sendTelegramMessage(shortMsg);
      if (isSent) counts.telegramSent++;

      await sleep(100);
    }

    // In thống kê số lượng coin còn lại sau mỗi điều kiện
    console.log('\n--- SỐ LƯỢNG COIN CÒN LẠI SAU MỖI ĐIỀU KIỆN ---');
    console.log(`1. Tổng cặp USDT-SWAP: ${counts.total}`);
    console.log(`2. Sau lọc Volume 24h > 5M$: ${counts.afterVol24h}`);
    console.log(`3. Sau lọc Cooldown 24h: ${counts.afterCooldown}`);
    console.log(`4. Sau lọc BD5 (5m) > 2%: ${counts.afterBD5}`);
    console.log(`5. Sau lọc BBT (5m) > 0: ${counts.afterBBT}`);
    console.log(`6. Sau lọc DiffEMA9 (5m) > 0%: ${counts.afterDiffEMA9_5m}`);
    console.log(`7. Sau lọc DiffEMA10 (15m) < -0.5%: ${counts.afterDiffEMA10_15m}`);
    console.log(`8. Đã gửi thông báo Telegram: ${counts.telegramSent}`);
    console.log('----------------------------------------------\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
