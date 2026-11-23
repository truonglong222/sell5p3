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
const COOLDOWN_TIME = 4 * 60 * 60 * 1000; // Cooldown 4 giờ
const MIN_VOL_24H = 2_000_000;            // Volume 24h > 2 triệu USDT
const MAX_DIFF_EMA20_5M = -2.0;           // diffema20 (5m) < -2%
const EMA_PERIOD = 20;                    // Chu kỳ EMA 20
const BB_PERIOD = 20;                     // Chu kỳ Bollinger Bands Mid (SMA 20)

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

// Tính chuỗi giá trị EMA cho toàn bộ mảng closes (thứ tự cũ -> mới)
function calculateEMAArray(closes, period = 20) {
  const emaArray = new Array(closes.length).fill(null);
  if (closes.length < period) return emaArray;

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += closes[i];
  }
  let ema = sum / period;
  emaArray[period - 1] = ema;

  const multiplier = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] - ema) * multiplier + ema;
    emaArray[i] = ema;
  }

  return emaArray;
}

// Tính Bollinger Band Mid (SMA 20) của nến vừa đóng (mảng closes thứ tự cũ -> mới)
function calculateBBMid(closes, period = 20) {
  if (closes.length < period) return null;
  const recentCloses = closes.slice(-period);
  const sum = recentCloses.reduce((acc, val) => acc + val, 0);
  return sum / period;
}

// 1. Lấy danh sách cặp USDT-SWAP và lọc Volume 24h > 2 triệu USDT
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
      const last = parseFloat(item.last || 0);
      const volCoin = parseFloat(item.volCcy24h || 0);
      const volUsdt = volCoin * last;

      if (volUsdt > MIN_VOL_24H) {
        targetCoins.push({ instId: item.instId, volUsdt });
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
    console.log('=== BẮT ĐẦU QUÉT THỊ TRƯỜNG (KHUNG 5M) ===\n');

    const sentLog = loadSentLog();
    const currentTime = Date.now();

    // Bước 1: Lọc Volume 24h > 2 triệu USDT
    const { totalSwaps, targetCoins } = await getFilteredMarketsByVolume();

    const counts = {
      totalSwaps,
      afterVol24h: targetCoins.length,
      afterDiffEma20_5m: 0,
      afterBBM_5m: 0,
      afterCooldown: 0,
      telegramSent: 0
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;
      const shortName = symbol.replace('-USDT-SWAP', '');
      const coinName = escapeHtml(shortName);
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      // Lấy 100 nến 5m để EMA(20) hội tụ chính xác
      const candles5m = await getCandles(symbol, '5m', 100);
      if (!candles5m || candles5m.length < 40) {
        await sleep(50);
        continue;
      }

      // Bỏ nến 5m đang chạy (index 0), lấy danh sách nến đã đóng từ mới -> cũ
      const closed5mNewestFirst = candles5m.slice(1);
      const highCandle1 = parseFloat(closed5mNewestFirst[0][2]);  // Giá cao nhất nến 5m vừa đóng
      const closeCandle1 = parseFloat(closed5mNewestFirst[0][4]); // Giá đóng cửa nến 5m vừa đóng

      if (highCandle1 <= 0 || closeCandle1 <= 0) {
        await sleep(50);
        continue;
      }

      // Đảo ngược sang thứ tự cũ -> mới để tính chỉ báo
      const closed5mChronological = [...closed5mNewestFirst].reverse();
      const closedCloses5m = closed5mChronological.map((c) => parseFloat(c[4]));

      // Bước 2: Tính diffema20 (5m) và lọc diffema20 < -2%
      const emaSeries5m = calculateEMAArray(closedCloses5m, EMA_PERIOD);
      const emaNewestFirst = [...emaSeries5m].reverse();

      const emaCandle1 = emaNewestFirst[0]; // EMA20 nến 5m vừa đóng
      const emaCandle10 = emaNewestFirst[9]; // EMA20 nến 5m thứ 10

      if (emaCandle1 === null || emaCandle10 === null || emaCandle10 <= 0) {
        await sleep(50);
        continue;
      }

      const diffema20 = ((emaCandle1 - emaCandle10) / emaCandle10) * 100;
      if (diffema20 >= MAX_DIFF_EMA20_5M) {
        await sleep(50);
        continue;
      }
      counts.afterDiffEma20_5m++;

      // Bước 3: Tính bbm = High nến vừa đóng - Bollinger Band Mid (SMA 20) nến vừa đóng, lọc bbm > 0
      const bbMid = calculateBBMid(closedCloses5m, BB_PERIOD);
      if (bbMid === null || bbMid <= 0) {
        await sleep(50);
        continue;
      }

      const bbm = highCandle1 - bbMid;
      if (bbm <= 0) {
        await sleep(50);
        continue;
      }
      counts.afterBBM_5m++;

      // Bước 4: Kiểm tra Cooldown 4h trong sent_ema.json
      const signalKey = `${symbol}_SHORT_5M`;
      const lastSent = sentLog[signalKey] || 0;
      if (currentTime - lastSent < COOLDOWN_TIME) {
        await sleep(50);
        continue;
      }
      counts.afterCooldown++;

      // Bước 5: Lưu coin thỏa điều kiện vào sent_ema.json
      sentLog[signalKey] = currentTime;
      saveSentLog(sentLog);

      const diffEma20Str = `${diffema20 >= 0 ? '+' : ''}${diffema20.toFixed(2)}%`;
      const bbmPercent = (bbm / bbMid) * 100;
      const bbmStr = `${bbm.toPrecision(4)} (+${bbmPercent.toFixed(2)}%)`;

      console.log(
        `[SHORT SIGNAL] ${symbol} | diffema20 (5m): ${diffEma20Str} | High: ${highCandle1} | BB Mid: ${bbMid.toPrecision(6)} | bbm: ${bbmStr}`
      );

      // Bước 6: Gửi tin Telegram
      const msg =
        `<b>🔴 SHORT ${coinName}</b>\n` +
        `• diffema20 (5m): <b>${diffEma20Str}</b>\n` +
        `• bbm: <b>${bbmStr}</b>\n` +
        `• High (5m): <b>${highCandle1}</b>\n` +
        `• BB Mid (20): <b>${Number(bbMid.toPrecision(6))}</b>\n` +
        `<a href="${link}">🔗 Giao dịch OKX</a>`;

      const isSent = await sendTelegramMessage(msg);
      if (isSent) {
        counts.telegramSent++;
      }

      await sleep(100);
    }

    // In thống kê số lượng coin còn lại sau mỗi bước lọc
    console.log('\n--- THỐNG KÊ SỐ LƯỢNG COIN SAU MỖI BƯỚC LỌC ---');
    console.log(`1. Tổng cặp USDT-SWAP: ${counts.totalSwaps}`);
    console.log(`2. Sau lọc Vol 24h > ${MIN_VOL_24H / 1_000_000}M: ${counts.afterVol24h}`);
    console.log(`3. Sau lọc diffema20 (5m) < ${MAX_DIFF_EMA20_5M}%: ${counts.afterDiffEma20_5m}`);
    console.log(`4. Sau lọc bbm > 0: ${counts.afterBBM_5m}`);
    console.log(`5. Sau lọc Cooldown 4h: ${counts.afterCooldown}`);
    console.log(`6. Đã gửi Telegram: ${counts.telegramSent}`);
    console.log('----------------------------------------------\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
