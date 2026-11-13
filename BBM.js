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
const MIN_VOL_24H = 5_000_000; // Volume 24h > 5 triệu USDT
const MIN_BD5_5M = 3.0; // Biến động 5 nến 5m > 3%
const MAX_DIFFEMA5_15M = -0.5; // diffema5 (15m) < -0.5%
const MAX_DIFFEMA5_1H = -1.0; // diffema5 (1h) < -1%

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

// 1. Lấy danh sách cặp USDT-SWAP và lọc Volume 24h > 5 triệu USDT
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
      // Trên OKX SWAP, volCcy24h là khối lượng theo đồng coin cơ sở -> nhân giá last để ra USDT
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

async function getCandles(symbol, bar = '15m', limit = 40) {
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

    // Bước 1: Lọc Volume 24h > 5 triệu USDT
    const { totalSwaps, targetCoins } = await getFilteredMarketsByVolume();

    // Lưu danh sách coin qua từng bước lọc
    const filterSteps = {
      totalSwaps,
      afterVol24h: targetCoins.map((c) => c.instId.replace('-USDT-SWAP', '')),
      afterCooldown: [],
      afterBD5_5m: [],
      afterDiffEMA5_15m: [],
      afterDiffEMA5_1h: [],
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

      // Bước 3: Lấy nến 5m và kiểm tra bd5 > 3%
      const candles5m = await getCandles(symbol, '5m', 10);
      if (!candles5m || candles5m.length < 6) {
        await sleep(50);
        continue;
      }

      // Nến index 0 là nến đang chạy; index 1 -> 5 là 5 nến 5m đã đóng gần nhất
      const closed5m = candles5m.slice(1);
      const closeLatest5m = parseFloat(closed5m[0][4]); // Giá đóng của nến 5m vừa đóng
      const open5CandlesAgo = parseFloat(closed5m[4][1]); // Giá mở của nến cách đây 5 cây

      if (open5CandlesAgo <= 0) {
        await sleep(50);
        continue;
      }

      const bd5_5m = ((closeLatest5m - open5CandlesAgo) / open5CandlesAgo) * 100;
      if (bd5_5m <= MIN_BD5_5M) {
        await sleep(50);
        continue;
      }
      filterSteps.afterBD5_5m.push(shortName);

      // Bước 4: Gọi song song nến 15m và 1h (cần tối thiểu 26 nến: 1 đang chạy + 20 tính EMA + 5 lùi)
      const [candles15m, candles1h] = await Promise.all([
        getCandles(symbol, '15m', 40),
        getCandles(symbol, '1h', 40)
      ]);

      if (!candles15m || candles15m.length < 27 || !candles1h || candles1h.length < 27) {
        await sleep(50);
        continue;
      }

      // Kiểm tra diffema5 của nến 15m < -0.5%
      const closes15m = [...candles15m.slice(1)].reverse().map((c) => parseFloat(c[4]));
      const diffema5_15m = calculateDiffEMA(closes15m, 5, 20);
      if (diffema5_15m === null || diffema5_15m >= MAX_DIFFEMA5_15M) {
        await sleep(50);
        continue;
      }
      filterSteps.afterDiffEMA5_15m.push(shortName);

      // Kiểm tra diffema5 của nến 1h < -1%
      const closes1h = [...candles1h.slice(1)].reverse().map((c) => parseFloat(c[4]));
      const diffema5_1h = calculateDiffEMA(closes1h, 5, 20);
      if (diffema5_1h === null || diffema5_1h >= MAX_DIFFEMA5_1H) {
        await sleep(50);
        continue;
      }
      filterSteps.afterDiffEMA5_1h.push(shortName);

      // Bước 5: Thỏa mãn toàn bộ -> Lưu log Cooldown 4h & Gửi Telegram
      sentLog[shortKey] = currentTime;
      saveSentLog(sentLog);

      const volStr = `${(coin.volUsdt / 1_000_000).toFixed(2)}M USDT`;
      const bd5Str = `+${bd5_5m.toFixed(2)}%`;
      const diff15mStr = `${diffema5_15m.toFixed(2)}%`;
      const diff1hStr = `${diffema5_1h.toFixed(2)}%`;

      console.log(
        `[SHORT SIGNAL] ${symbol} | Vol24h: ${volStr} | bd5(5m): ${bd5Str} | diffema5(15m): ${diff15mStr} | diffema5(1h): ${diff1hStr}`
      );

      const shortMsg =
        `<b>🔴 TÍN HIỆU SHORT</b>\n` +
        `Coin: <b>${coinName}</b>\n` +
        `• Vol 24h: <b>${volStr}</b>\n` +
        `• bd5 (5m): <b>${bd5Str}</b>\n` +
        `• diffema5 (15m): <b>${diff15mStr}</b>\n` +
        `• diffema5 (1h): <b>${diff1hStr}</b>\n` +
        `<a href="${link}">🔗 Giao dịch OKX</a>`;

      const isSent = await sendTelegramMessage(shortMsg);
      if (isSent) {
        filterSteps.telegramSent.push(shortName);
      }

      await sleep(100);
    }

    // In thống kê số lượng & danh sách coin còn lại sau mỗi bước lọc
    const formatList = (arr) => (arr.length > 0 ? `[${arr.join(', ')}]` : '[]');

    console.log('\n--- THỐNG KÊ SỐ LƯỢNG & DANH SÁCH COIN SAU MỖI BƯỚC LỌC ---');
    console.log(`1. Tổng cặp USDT-SWAP: ${filterSteps.totalSwaps}`);
    console.log(
      `2. Sau lọc Vol 24h > 5M (${filterSteps.afterVol24h.length}): ${formatList(filterSteps.afterVol24h)}`
    );
    console.log(
      `3. Sau lọc Cooldown 4h (${filterSteps.afterCooldown.length}): ${formatList(filterSteps.afterCooldown)}`
    );
    console.log(
      `4. Sau lọc bd5 (5m) > ${MIN_BD5_5M}% (${filterSteps.afterBD5_5m.length}): ${formatList(filterSteps.afterBD5_5m)}`
    );
    console.log(
      `5. Sau lọc diffema5 (15m) < ${MAX_DIFFEMA5_15M}% (${filterSteps.afterDiffEMA5_15m.length}): ${formatList(filterSteps.afterDiffEMA5_15m)}`
    );
    console.log(
      `6. Sau lọc diffema5 (1h) < ${MAX_DIFFEMA5_1H}% (${filterSteps.afterDiffEMA5_1h.length}): ${formatList(filterSteps.afterDiffEMA5_1h)}`
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
