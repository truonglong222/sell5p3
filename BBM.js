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
const COOLDOWN_TIME = 24 * 60 * 60 * 1000; // Cooldown 24 giờ
const MIN_VOL_24H = 2_000_000;             // Volume 24h > 2 triệu USDT
const MIN_BD3_5M = 2.0;                    // bd3 nến 5m > 2% (giá tăng hơn 2%)
const MIN_X_RATIO = 3.0;                   // Tỷ số x = bd3 / atr > 3
const MAX_DIFF_EMA10_1H = -1.0;            // diffema10 (1H) < -1%
const MAX_DIFF_EMA10_4H = -1.0;            // diffema10 (4H) < -1%
const EMA_PERIOD = 10;                     // Chu kỳ EMA 10
const ATR_PERIOD = 14;                     // Chu kỳ ATR 14

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
function calculateEMAArray(closes, period = 10) {
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

// Tính giá trị ATR(14) tại nến vừa đóng (mảng nến thứ tự cũ -> mới)
function calculateLatestATR(closedCandlesChronological, period = 14) {
  if (closedCandlesChronological.length <= period) return null;

  const trList = [];
  for (let i = 1; i < closedCandlesChronological.length; i++) {
    const high = parseFloat(closedCandlesChronological[i][2]);
    const low = parseFloat(closedCandlesChronological[i][3]);
    const prevClose = parseFloat(closedCandlesChronological[i - 1][4]);

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trList.push(tr);
  }

  if (trList.length < period) return null;

  // ATR đầu tiên bằng trung bình giản đơn của `period` phiên TR đầu
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += trList[i];
  }
  let atr = sum / period;

  // Làm mượt Wilder cho các nến tiếp theo
  for (let i = period; i < trList.length; i++) {
    atr = (atr * (period - 1) + trList[i]) / period;
  }

  return atr;
}

// Tính diffema10 (%) từ danh sách nến đã đóng (thứ tự cũ -> mới)
function getDiffEma10(closedCandlesChronological) {
  const closes = closedCandlesChronological.map((c) => parseFloat(c[4]));
  const emaSeries = calculateEMAArray(closes, EMA_PERIOD);
  const emaNewestFirst = [...emaSeries].reverse();

  const emaCandle1 = emaNewestFirst[0]; // EMA10 nến vừa đóng
  const emaCandle10 = emaNewestFirst[9]; // EMA10 nến thứ 10

  if (emaCandle1 === null || emaCandle10 === null || emaCandle10 <= 0) {
    return null;
  }

  return ((emaCandle1 - emaCandle10) / emaCandle10) * 100;
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
    console.log('=== BẮT ĐẦU QUÉT THỊ TRƯỜNG (5M BD3 > 2% + X=BD3/ATR + 1H/4H EMA10) ===\n');

    const sentLog = loadSentLog();
    const currentTime = Date.now();

    // Bước 1: Lọc Volume 24h > 2 triệu USDT
    const { totalSwaps, targetCoins } = await getFilteredMarketsByVolume();

    const counts = {
      totalSwaps,
      afterVol24h: targetCoins.length,
      afterBd3_5m: 0,
      afterRatioX: 0,
      afterDiffEma10_1H_4H: 0,
      afterCooldown: 0,
      telegramSent: 0
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;
      const shortName = symbol.replace('-USDT-SWAP', '');
      const coinName = escapeHtml(shortName);
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      // Bước 2: Lấy 100 nến 5m để tính bd3 và ATR(14) chính xác
      const candles5m = await getCandles(symbol, '5m', 100);
      if (!candles5m || candles5m.length < 30) {
        await sleep(50);
        continue;
      }

      // Bỏ nến đang chạy (index 0), lấy danh sách nến đã đóng
      const closed5mNewestFirst = candles5m.slice(1);
      const closeCandle1 = parseFloat(closed5mNewestFirst[0][4]); // Giá đóng cửa nến vừa đóng
      const closeCandle3 = parseFloat(closed5mNewestFirst[2][4]); // Giá đóng cửa nến số 3

      if (closeCandle1 <= 0 || closeCandle3 <= 0) {
        await sleep(50);
        continue;
      }

      // Tính bd3 = % tăng giá đóng cửa từ nến số 3 đến nến vừa đóng
      const bd3 = ((closeCandle1 - closeCandle3) / closeCandle3) * 100;
      if (bd3 <= MIN_BD3_5M) {
        await sleep(50);
        continue;
      }
      counts.afterBd3_5m++;

      // Bước 3: Tính ATR(14) khung 5m và lọc tỷ số x = bd3 / atr > 3
      const closed5mChronological = [...closed5mNewestFirst].reverse();
      const atr5m = calculateLatestATR(closed5mChronological, ATR_PERIOD);

      if (atr5m === null || atr5m <= 0) {
        await sleep(50);
        continue;
      }

      // Quy đổi ATR sang % để cùng đơn vị với bd3 (%)
      const atrPercent = (atr5m / closeCandle1) * 100;
      const xRatio = bd3 / atrPercent;

      if (xRatio <= MIN_X_RATIO) {
        await sleep(50);
        continue;
      }
      counts.afterRatioX++;

      // Bước 4: Chỉ khi x > 3 mới gọi nến 1H và 4H của coin đó để xét tiếp
      const [candles1H, candles4H] = await Promise.all([
        getCandles(symbol, '1H', 100),
        getCandles(symbol, '4H', 100)
      ]);

      if (!candles1H || candles1H.length < 30 || !candles4H || candles4H.length < 30) {
        await sleep(50);
        continue;
      }

      const closed1HChronological = candles1H.slice(1).reverse();
      const closed4HChronological = candles4H.slice(1).reverse();

      const diffema10_1H = getDiffEma10(closed1HChronological);
      const diffema10_4H = getDiffEma10(closed4HChronological);

      if (diffema10_1H === null || diffema10_4H === null) {
        await sleep(50);
        continue;
      }

      // Lọc diffema10 (1H) < -1% và diffema10 (4H) < -1%
      if (diffema10_1H >= MAX_DIFF_EMA10_1H || diffema10_4H >= MAX_DIFF_EMA10_4H) {
        await sleep(50);
        continue;
      }
      counts.afterDiffEma10_1H_4H++;

      // Bước 5: Kiểm tra Cooldown 24h trong sent_ema.json
      const signalKey = `${symbol}_SHORT_BD3_EMA10`;
      const lastSent = sentLog[signalKey] || 0;
      if (currentTime - lastSent < COOLDOWN_TIME) {
        await sleep(50);
        continue;
      }
      counts.afterCooldown++;

      // Bước 6: Lưu coin thỏa điều kiện vào sent_ema.json
      sentLog[signalKey] = currentTime;
      saveSentLog(sentLog);

      const bd3Str = `+${bd3.toFixed(2)}%`;
      const xRatioStr = xRatio.toFixed(2);
      const diff1HStr = `${diffema10_1H >= 0 ? '+' : ''}${diffema10_1H.toFixed(2)}%`;
      const diff4HStr = `${diffema10_4H >= 0 ? '+' : ''}${diffema10_4H.toFixed(2)}%`;

      console.log(
        `[SHORT SIGNAL] ${symbol} | bd3: ${bd3Str} | x (bd3/atr): ${xRatioStr} | diffema10 (1H): ${diff1HStr} | diffema10 (4H): ${diff4HStr}`
      );

      // Bước 7: Gửi tin Telegram
      const msg =
        `<b>🔴 SHORT ${coinName}</b>\n` +
        `• bd3 (5m): <b>${bd3Str}</b> (x = <b>${xRatioStr}</b>)\n` +
        `• diffema10 (1H): <b>${diff1HStr}</b>\n` +
        `• diffema10 (4H): <b>${diff4HStr}</b>\n` +
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
    console.log(`3. Sau lọc bd3 (5m) > +${MIN_BD3_5M}%: ${counts.afterBd3_5m}`);
    console.log(`4. Sau lọc tỷ số x (bd3/atr) > ${MIN_X_RATIO}: ${counts.afterRatioX}`);
    console.log(`5. Sau lọc diffema10 1H < ${MAX_DIFF_EMA10_1H}% & 4H < ${MAX_DIFF_EMA10_4H}%: ${counts.afterDiffEma10_1H_4H}`);
    console.log(`6. Sau lọc Cooldown 24h: ${counts.afterCooldown}`);
    console.log(`7. Đã gửi Telegram: ${counts.telegramSent}`);
    console.log('----------------------------------------------\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
