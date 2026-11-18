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
const MIN_BD5_5M = 3.0; // Biến động 5 nến 5m > 3%
const MIN_ATR_5M = 0.7; // ATR% (5m) > 0.7%
const DIFFEMA10_15M_MIN = -2.0; // Ngưỡng dưới diffema10 (15m): > -2%
const DIFFEMA10_15M_MAX = 2.0;  // Ngưỡng trên diffema10 (15m): < 2%
const DIFFEMA10_1H_THRESHOLD = 2.0; // Ngưỡng diffema10 (1H): > 2% LONG, < -2% SHORT
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
function calculateDiffEMA(closes, lookbackCandles = 10, period = 20) {
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

  let atr = 0;
  for (let i = 0; i < period; i++) {
    atr += trueRanges[i];
  }
  atr /= period;

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

async function getCandles(symbol, bar = '5m', limit = 40) {
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
      afterBD5_5m: 0,
      afterATR_5m: 0,
      fetchedCandles15m: 0,
      afterDiffEMA10_15m: 0,
      fetchedCandles1H: 0,
      matchedSignal1H: 0,
      afterCooldown: 0,
      telegramSent: 0
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;
      const shortName = symbol.replace('-USDT-SWAP', '');
      const coinName = escapeHtml(shortName);
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      // Bước 2: Lấy 40 nến 5m, kiểm tra bd5 > 3% và ATR% (5m) > 0.7%
      const candles5m = await getCandles(symbol, '5m', 40);
      if (!candles5m || candles5m.length < ATR_PERIOD + 2) {
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

      // Kiểm tra điều kiện ATR% (5m) > 0.7%
      const chronologicalCandles5m = [...closed5m].reverse();
      const atrPercent5m = calculateATRPercent(chronologicalCandles5m, ATR_PERIOD);
      if (atrPercent5m === null || atrPercent5m <= MIN_ATR_5M) {
        await sleep(50);
        continue;
      }
      counts.afterATR_5m++;

      // Bước 3: Gọi nến 15m và kiểm tra -2% < diffema10 < 2%
      const candles15m = await getCandles(symbol, '15m', 50);
      if (!candles15m || candles15m.length < 32) {
        await sleep(50);
        continue;
      }
      counts.fetchedCandles15m++;

      const closedCandles15m = [...candles15m.slice(1)].reverse();
      const closes15m = closedCandles15m.map((c) => parseFloat(c[4]));

      const diffema10_15m = calculateDiffEMA(closes15m, 10, 20);
      // Bỏ qua nếu nằm ngoài khoảng (-2%, 2%)
      if (
        diffema10_15m === null ||
        diffema10_15m <= DIFFEMA10_15M_MIN ||
        diffema10_15m >= DIFFEMA10_15M_MAX
      ) {
        await sleep(50);
        continue;
      }
      counts.afterDiffEMA10_15m++;

      // Bước 4: Gọi nến 1H để xác định tín hiệu LONG (> 2%) hoặc SHORT (< -2%)
      const candles1H = await getCandles(symbol, '1H', 50);
      if (!candles1H || candles1H.length < 32) {
        await sleep(50);
        continue;
      }
      counts.fetchedCandles1H++;

      const closedCandles1H = [...candles1H.slice(1)].reverse();
      const closes1H = closedCandles1H.map((c) => parseFloat(c[4]));

      const diffema10_1H = calculateDiffEMA(closes1H, 10, 20);
      if (diffema10_1H === null) {
        await sleep(50);
        continue;
      }

      let signalSide = null;
      if (diffema10_1H > DIFFEMA10_1H_THRESHOLD) {
        signalSide = 'LONG';
      } else if (diffema10_1H < -DIFFEMA10_1H_THRESHOLD) {
        signalSide = 'SHORT';
      } else {
        await sleep(50);
        continue;
      }
      counts.matchedSignal1H++;

      // Bước 5: Kiểm tra Cooldown theo đúng chiều tín hiệu (LONG / SHORT)
      const signalKey = `${symbol}_${signalSide}`;
      const lastSent = sentLog[signalKey] || 0;
      if (currentTime - lastSent < COOLDOWN_TIME) {
        await sleep(50);
        continue;
      }
      counts.afterCooldown++;

      // Bước 6: Lưu log Cooldown & Gửi Telegram
      sentLog[signalKey] = currentTime;
      saveSentLog(sentLog);

      const volStr = `${(coin.volUsdt / 1_000_000).toFixed(2)}M USDT`;
      const bd5Str = `+${bd5.toFixed(2)}%`;
      const atr5mStr = `${atrPercent5m.toFixed(2)}%`;
      const diff10_15mStr = `${diffema10_15m > 0 ? '+' : ''}${diffema10_15m.toFixed(2)}%`;
      const diff10_1HStr = `${diffema10_1H > 0 ? '+' : ''}${diffema10_1H.toFixed(2)}%`;

      const headerBadge = signalSide === 'LONG' ? '🟢 TÍN HIỆU LONG' : '🔴 TÍN HIỆU SHORT';

      console.log(
        `[${signalSide} SIGNAL] ${symbol} | Vol24h: ${volStr} | bd5(5m): ${bd5Str} | ATR%(5m): ${atr5mStr} | diffema10(15m): ${diff10_15mStr} | diffema10(1H): ${diff10_1HStr}`
      );

      const msg =
        `<b>${headerBadge}</b>\n` +
        `Coin: <b>${coinName}</b>\n` +
        `• Vol 24h: <b>${volStr}</b>\n` +
        `• bd5 (5m): <b>${bd5Str}</b>\n` +
        `• ATR% (5m): <b>${atr5mStr}</b>\n` +
        `• diffema10 (15m): <b>${diff10_15mStr}</b>\n` +
        `• diffema10 (1H): <b>${diff10_1HStr}</b>\n` +
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
    console.log(`3. Sau lọc bd5 (5m) > ${MIN_BD5_5M}%: ${counts.afterBD5_5m}`);
    console.log(`4. Sau lọc ATR% (5m) > ${MIN_ATR_5M}%: ${counts.afterATR_5m}`);
    console.log(`5. Gọi nến 15m thành công: ${counts.fetchedCandles15m}`);
    console.log(`6. Sau lọc ${DIFFEMA10_15M_MIN}% < diffema10 (15m) < ${DIFFEMA10_15M_MAX}%: ${counts.afterDiffEMA10_15m}`);
    console.log(`7. Gọi nến 1H thành công: ${counts.fetchedCandles1H}`);
    console.log(`8. Đạt tín hiệu LONG/SHORT (|diffema10 1H| > ${DIFFEMA10_1H_THRESHOLD}%): ${counts.matchedSignal1H}`);
    console.log(`9. Sau lọc Cooldown 24h: ${counts.afterCooldown}`);
    console.log(`10. Đã gửi Telegram: ${counts.telegramSent}`);
    console.log('----------------------------------------------\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
