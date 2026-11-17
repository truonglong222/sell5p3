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
const COOLDOWN_TIME = 24 * 60 * 60 * 1000; // Countdown 24 giờ
const MIN_VOL_24H = 2_000_000; // Volume 24h > 2 triệu USDT
const MIN_BD5_5M = 2.0; // Biến động 5 nến 5m > 2%
const MAX_DIFFEMA5_1H = -0.3; // diffema5 (1H) < -0.3%
const MIN_ATR_1H = 2.0; // ATR% (1H) > 2.0%
const MIN_DIFFEMA30_15M = -3.0; // diffema30 (15m) > -3.0%
const MAX_DIFFEMA30_15M = 3.0; // diffema30 (15m) < 3.0%
const ATR_PERIOD = 14; // Chu kỳ tính ATR%

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

// Tính % chênh lệch EMA(period) hiện tại so với lookbackCandles nến trước đó
function calculateDiffEMA(closes, lookbackCandles = 5, period = 20) {
  const emaArray = calculateEMA(closes, period);
  if (emaArray.length <= lookbackCandles) return null;

  const emaCurrent = emaArray[emaArray.length - 1];
  const emaPrev = emaArray[emaArray.length - 1 - lookbackCandles];
  if (emaPrev === 0) return null;

  return ((emaCurrent - emaPrev) / emaPrev) * 100;
}

/**
 * Tính ATR% theo chuẩn Wilder's Smoothing từ mảng nến đã sắp xếp từ cũ -> mới
 * Cấu trúc mỗi nến OKX: [ts, open, high, low, close, ...]
 */
function calculateATRPercent(chronologicalCandles, period = 14) {
  if (!chronologicalCandles || chronologicalCandles.length < period + 1) {
    return null;
  }

  const trueRanges = [];
  for (let i = 1; i < chronologicalCandles.length; i++) {
    const high = parseFloat(chronologicalCandles[i][2]);
    const low = parseFloat(chronologicalCandles[i][3]);
    const prevClose = parseFloat(chronologicalCandles[i - 1][4]);

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return null;

  // ATR khởi tạo = trung bình cộng `period` giá trị TR đầu tiên
  let atr = 0;
  for (let i = 0; i < period; i++) {
    atr += trueRanges[i];
  }
  atr /= period;

  // Làm mượt theo công thức Wilder
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  const lastClose = parseFloat(chronologicalCandles[chronologicalCandles.length - 1][4]);
  if (lastClose <= 0) return null;

  return (atr / lastClose) * 100;
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

async function getCandles(symbol, bar = '1H', limit = 40) {
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
    console.log('=== BẮT ĐẦU QUÉT THỊ TRƯỜNG ===\n');

    const sentLog = loadSentLog();
    const currentTime = Date.now();

    // Bước 1: Lọc Volume 24h > 2 triệu USDT
    const { totalSwaps, targetCoins } = await getFilteredMarketsByVolume();

    // Biến đếm số lượng coin còn lại sau mỗi bước lọc
    const counts = {
      totalSwaps,
      afterVol24h: targetCoins.length,
      afterCooldown: 0,
      afterBD5_5m: 0,
      fetchedCandles1H: 0,
      afterDiffEMA5_1H: 0,
      afterATR_1H: 0,
      fetchedCandles15m: 0,
      afterDiffEMA30_15m: 0,
      telegramSent: 0
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;
      const shortName = symbol.replace('-USDT-SWAP', '');
      const coinName = escapeHtml(shortName);
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      // Bước 2: Kiểm tra Cooldown
      const shortKey = `${symbol}_SHORT`;
      const lastSent = sentLog[shortKey] || 0;
      if (currentTime - lastSent < COOLDOWN_TIME) {
        continue;
      }
      counts.afterCooldown++;

      // Bước 3: Lấy nến 5m và kiểm tra bd5 > 2%
      const candles5m = await getCandles(symbol, '5m', 10);
      if (!candles5m || candles5m.length < 6) {
        await sleep(50);
        continue;
      }

      const closed5m = candles5m.slice(1);
      const closeCandle1 = parseFloat(closed5m[0][4]);
      const openCandle5 = parseFloat(closed5m[4][1]);

      if (openCandle5 <= 0) {
        await sleep(50);
        continue;
      }

      const bd5 = ((closeCandle1 - openCandle5) / openCandle5) * 100;
      if (bd5 <= MIN_BD5_5M) {
        await sleep(50);
        continue;
      }
      counts.afterBD5_5m++;

      // Bước 4: Gọi nến 1H, kiểm tra diffema5 < -0.3% và ATR% > 2.0%
      const candles1H = await getCandles(symbol, '1H', 40);
      if (!candles1H || candles1H.length < 27) {
        await sleep(50);
        continue;
      }
      counts.fetchedCandles1H++;

      // Sắp xếp lại danh sách nến 1H đã đóng từ cũ -> mới
      const closedCandles1H = [...candles1H.slice(1)].reverse();
      const closes1H = closedCandles1H.map((c) => parseFloat(c[4]));

      const diffema5_1H = calculateDiffEMA(closes1H, 5, 20);
      if (diffema5_1H === null || diffema5_1H >= MAX_DIFFEMA5_1H) {
        await sleep(50);
        continue;
      }
      counts.afterDiffEMA5_1H++;

      // Kiểm tra điều kiện ATR% (1H) > 2.0%
      const atrPercent1H = calculateATRPercent(closedCandles1H, ATR_PERIOD);
      if (atrPercent1H === null || atrPercent1H <= MIN_ATR_1H) {
        await sleep(50);
        continue;
      }
      counts.afterATR_1H++;

      // Bước 5: Gọi 100 nến 15m và kiểm tra -3.0% < diffema30 < 3.0%
      // (Cần tối thiểu: 1 nến chưa đóng + 20 nến EMA20 + 30 nến lookback = 51 nến)
      const candles15m = await getCandles(symbol, '15m', 100);
      if (!candles15m || candles15m.length < 52) {
        await sleep(50);
        continue;
      }
      counts.fetchedCandles15m++;

      // Sắp xếp lại danh sách nến 15m đã đóng từ cũ -> mới
      const closedCandles15m = [...candles15m.slice(1)].reverse();
      const closes15m = closedCandles15m.map((c) => parseFloat(c[4]));

      const diffema30_15m = calculateDiffEMA(closes15m, 30, 20);
      if (
        diffema30_15m === null ||
        diffema30_15m <= MIN_DIFFEMA30_15M ||
        diffema30_15m >= MAX_DIFFEMA30_15M
      ) {
        await sleep(50);
        continue;
      }
      counts.afterDiffEMA30_15m++;

      // Bước 6: Lưu log Cooldown & Gửi Telegram
      sentLog[shortKey] = currentTime;
      saveSentLog(sentLog);

      const volStr = `${(coin.volUsdt / 1_000_000).toFixed(2)}M USDT`;
      const bd5Str = `+${bd5.toFixed(2)}%`;
      const diff5_1HStr = `${diffema5_1H.toFixed(2)}%`;
      const diff30_15mStr = `${diffema30_15m.toFixed(2)}%`;
      const atrStr = `${atrPercent1H.toFixed(2)}%`;

      console.log(
        `[SHORT SIGNAL] ${symbol} | Vol24h: ${volStr} | bd5(5m): ${bd5Str} | diffema5(1H): ${diff5_1HStr} | ATR%(1H): ${atrStr} | diffema30(15m): ${diff30_15mStr}`
      );

      const shortMsg =
        `<b>🔴 TÍN HIỆU SHORT</b>\n` +
        `Coin: <b>${coinName}</b>\n` +
        `• Vol 24h: <b>${volStr}</b>\n` +
        `• bd5 (5m): <b>${bd5Str}</b>\n` +
        `• diffema5 (1H): <b>${diff5_1HStr}</b>\n` +
        `• ATR% (1H): <b>${atrStr}</b>\n` +
        `• diffema30 (15m): <b>${diff30_15mStr}</b>\n` +
        `<a href="${link}">🔗 Giao dịch OKX</a>`;

      const isSent = await sendTelegramMessage(shortMsg);
      if (isSent) {
        counts.telegramSent++;
      }

      await sleep(100);
    }

    // In thống kê số lượng coin còn lại sau mỗi bước lọc
    console.log('\n--- THỐNG KÊ SỐ LƯỢNG COIN SAU MỖI BƯỚC LỌC ---');
    console.log(`1. Tổng cặp USDT-SWAP: ${counts.totalSwaps}`);
    console.log(`2. Sau lọc Vol 24h > ${MIN_VOL_24H / 1_000_000}M: ${counts.afterVol24h}`);
    console.log(`3. Sau lọc Cooldown 24h: ${counts.afterCooldown}`);
    console.log(`4. Sau lọc bd5 (5m) > ${MIN_BD5_5M}%: ${counts.afterBD5_5m}`);
    console.log(`5. Gọi nến 1H thành công: ${counts.fetchedCandles1H}`);
    console.log(`6. Sau lọc diffema5 (1H) < ${MAX_DIFFEMA5_1H}%: ${counts.afterDiffEMA5_1H}`);
    console.log(`7. Sau lọc ATR% (1H) > ${MIN_ATR_1H}%: ${counts.afterATR_1H}`);
    console.log(`8. Gọi nến 15m thành công: ${counts.fetchedCandles15m}`);
    console.log(
      `9. Sau lọc ${MIN_DIFFEMA30_15M}% < diffema30 (15m) < ${MAX_DIFFEMA30_15M}%: ${counts.afterDiffEMA30_15m}`
    );
    console.log(`10. Đã gửi Telegram: ${counts.telegramSent}`);
    console.log('----------------------------------------------\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
