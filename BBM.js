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
const MIN_VOL_24H = 2_000_000;   // Volume 24h > 2 triệu USDT
const MIN_BD2_5M = 3.0;          // Biến động 2 nến 5m > 3%
const MAX_RSI_5M = 60;           // RSI nến 5m vừa đóng < 60
const MIN_X_RATIO = 1.5;         // Tỉ số x = bd2 / atr > 1.5
const RSI_PERIOD = 20;
const ATR_PERIOD = 14;

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

// Tính chuỗi giá trị RSI theo chuẩn Wilder's Smoothing cho toàn bộ mảng closes (cũ -> mới)
function calculateRSIArray(closes, period = 20) {
  const rsiArray = new Array(closes.length).fill(null);
  if (closes.length <= period) return rsiArray;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  rsiArray[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const currentGain = diff > 0 ? diff : 0;
    const currentLoss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;

    rsiArray[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsiArray;
}

// Tính ATR theo chuẩn Wilder's Smoothing (mảng candles theo thứ tự cũ -> mới)
function calculateATR(candles, period = 14) {
  if (candles.length <= period) return null;

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i][2]);
    const low = parseFloat(candles[i][3]);
    const prevClose = parseFloat(candles[i - 1][4]);

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return null;

  let sumTR = 0;
  for (let i = 0; i < period; i++) {
    sumTR += trueRanges[i];
  }
  let atr = sumTR / period;

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return atr;
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
    console.log('=== BẮT ĐẦU QUÉT THỊ TRƯỜNG (5M) ===\n');

    const sentLog = loadSentLog();
    const currentTime = Date.now();

    // Bước 1: Lọc Volume 24h > 2 triệu USDT
    const { totalSwaps, targetCoins } = await getFilteredMarketsByVolume();

    const counts = {
      totalSwaps,
      afterVol24h: targetCoins.length,
      afterBD2_5m: 0,
      afterRSI_5m: 0,
      afterX_5m: 0,
      afterCooldown: 0,
      telegramSent: 0
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;
      const shortName = symbol.replace('-USDT-SWAP', '');
      const coinName = escapeHtml(shortName);
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      // Lấy 100 nến 5m để tính chính xác Wilder's Smoothing cho RSI(20) và ATR(14)
      const candles5m = await getCandles(symbol, '5m', 100);
      if (!candles5m || candles5m.length < 40) {
        await sleep(50);
        continue;
      }

      // Bỏ nến 5m đang chạy (index 0), lấy danh sách nến đã đóng từ mới -> cũ
      const closed5m = candles5m.slice(1);
      const closeCandle1 = parseFloat(closed5m[0][4]); // Giá đóng cửa nến 5m vừa đóng
      const openCandle2 = parseFloat(closed5m[1][1]);  // Giá mở cửa nến 5m thứ 2

      if (closeCandle1 <= 0 || openCandle2 <= 0) {
        await sleep(50);
        continue;
      }

      // Bước 2: Lọc bd2 nến 5m > 3%
      const bd2 = ((closeCandle1 - openCandle2) / openCandle2) * 100;
      if (bd2 <= MIN_BD2_5M) {
        await sleep(50);
        continue;
      }
      counts.afterBD2_5m++;

      // Bước 3: Lọc RSI nến 5m vừa đóng < 60
      const chronological5m = [...closed5m].reverse();
      const closes5m = chronological5m.map((c) => parseFloat(c[4]));
      const rsiSeries5m = calculateRSIArray(closes5m, RSI_PERIOD);
      const lastClosedRsi5m = rsiSeries5m[rsiSeries5m.length - 1];

      if (lastClosedRsi5m === null || lastClosedRsi5m >= MAX_RSI_5M) {
        await sleep(50);
        continue;
      }
      counts.afterRSI_5m++;

      // Bước 4: Tính ATR(14) (%) và tỉ số x = bd2 / atr, lọc x > 1.5
      const atr5m = calculateATR(chronological5m, ATR_PERIOD);
      if (atr5m === null || atr5m <= 0) {
        await sleep(50);
        continue;
      }

      const atrPercent = (atr5m / closeCandle1) * 100;
      const x = bd2 / atrPercent;

      if (x <= MIN_X_RATIO) {
        await sleep(50);
        continue;
      }
      counts.afterX_5m++;

      // Bước 5: Kiểm tra Cooldown 4h trong sent_ema.json
      const signalKey = `${symbol}_SHORT_5M`;
      const lastSent = sentLog[signalKey] || 0;
      if (currentTime - lastSent < COOLDOWN_TIME) {
        await sleep(50);
        continue;
      }
      counts.afterCooldown++;

      // Bước 6: Lưu coin thỏa điều kiện vào sent_ema.json
      sentLog[signalKey] = currentTime;
      saveSentLog(sentLog);

      const xStr = x.toFixed(2);
      const bd2Str = `${bd2 >= 0 ? '+' : ''}${bd2.toFixed(2)}%`;
      const rsiStr = lastClosedRsi5m.toFixed(2);
      const atrStr = `${atrPercent.toFixed(2)}%`;

      console.log(
        `[SHORT SIGNAL] ${symbol} | x: ${xStr} | bd2: ${bd2Str} | RSI(5m): ${rsiStr} | atr: ${atrStr}`
      );

      // Bước 7: Gửi tin Telegram
      const msg =
        `<b>🔴 SHORT ${coinName}</b>\n` +
        `• x (bd2/atr): <b>${xStr}</b>\n` +
        `• bd2 (5m): <b>${bd2Str}</b>\n` +
        `• RSI (5m): <b>${rsiStr}</b>\n` +
        `• atr (5m): <b>${atrStr}</b>\n` +
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
    console.log(`3. Sau lọc bd2 (5m) > ${MIN_BD2_5M}%: ${counts.afterBD2_5m}`);
    console.log(`4. Sau lọc RSI (5m) < ${MAX_RSI_5M}: ${counts.afterRSI_5m}`);
    console.log(`5. Sau lọc x (bd2/atr) > ${MIN_X_RATIO}: ${counts.afterX_5m}`);
    console.log(`6. Sau lọc Cooldown 4h: ${counts.afterCooldown}`);
    console.log(`7. Đã gửi Telegram: ${counts.telegramSent}`);
    console.log('----------------------------------------------\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
