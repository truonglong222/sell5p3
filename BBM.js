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
const MIN_VOL_24H = 2_000_000;             // Volume 24h > 2 triệu USDT
const MAX_BD24 = -2.0;                     // Biến động 24h (bd24) < -2%
const MAX_DIFF_EMA10_4H = -1.0;            // diffema10 (4H) < -1%
const MAX_DIFF_EMA20_15M = -1.0;           // diffema20 (15m) < -1%
const MIN_BBT_5M = -0.5;                   // bbt (5m) > -0.5%
const MAX_BBT_5M = 0.5;                    // bbt (5m) < +0.5%

const EMA10_PERIOD = 10;                   // Chu kỳ EMA 10 (khung 4H)
const EMA20_PERIOD = 20;                   // Chu kỳ EMA 20 (khung 15m)
const BB_PERIOD = 20;                      // Chu kỳ Bollinger Bands 20
const BB_STD_DEV = 2;                      // Độ lệch chuẩn Bollinger Bands 2

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
function calculateEMAArray(closes, period) {
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

// Tính diffema theo chu kỳ `period` (%) từ danh sách nến đã đóng (thứ tự cũ -> mới)
// Ví dụ: period = 10 -> so sánh EMA10 nến vừa đóng với nến thứ 10 (index 0 vs 9)
// Ví dụ: period = 20 -> so sánh EMA20 nến vừa đóng với nến thứ 20 (index 0 vs 19)
function getDiffEma(closedCandlesChronological, period) {
  const closes = closedCandlesChronological.map((c) => parseFloat(c[4]));
  const emaSeries = calculateEMAArray(closes, period);
  const emaNewestFirst = [...emaSeries].reverse();

  const emaCandle1 = emaNewestFirst[0];
  const emaCandleN = emaNewestFirst[period - 1];

  if (emaCandle1 === null || emaCandleN === null || emaCandleN <= 0) {
    return null;
  }

  return ((emaCandle1 - emaCandleN) / emaCandleN) * 100;
}

// Tính dải trên Bollinger Bands (Upper Band) tại nến vừa đóng (thứ tự cũ -> mới)
function calculateLatestUpperBB(closedCandlesChronological, period = 20, multiplier = 2) {
  if (closedCandlesChronological.length < period) return null;

  const recentCandles = closedCandlesChronological.slice(-period);
  const closes = recentCandles.map((c) => parseFloat(c[4]));

  const sum = closes.reduce((acc, val) => acc + val, 0);
  const sma = sum / period;

  const variance = closes.reduce((acc, val) => acc + Math.pow(val - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  return sma + multiplier * stdDev;
}

// Bước 1 & 2: Lấy danh sách USDT-SWAP, lọc Volume 24h > 2M USDT và bd24 < -2%
async function getFilteredMarkets() {
  let totalSwaps = 0;
  let afterVolCount = 0;
  const targetCoins = [];

  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') {
      return { totalSwaps, afterVolCount, targetCoins };
    }

    const tickers = res.data.data.filter((item) => item.instId.endsWith('-USDT-SWAP'));
    totalSwaps = tickers.length;

    for (const item of tickers) {
      const last = parseFloat(item.last || 0);
      const open24h = parseFloat(item.open24h || 0);
      const volCoin = parseFloat(item.volCcy24h || 0);
      const volUsdt = volCoin * last;

      // Lọc Volume 24h > 2M USDT
      if (volUsdt <= MIN_VOL_24H) continue;
      afterVolCount++;

      // Tính biến động 24h: bd24 (%)
      if (open24h <= 0 || last <= 0) continue;
      const bd24 = ((last - open24h) / open24h) * 100;

      // Lọc bd24 < -2%
      if (bd24 < MAX_BD24) {
        targetCoins.push({ instId: item.instId, volUsdt, bd24 });
      }
    }

    return { totalSwaps, afterVolCount, targetCoins };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { totalSwaps, afterVolCount, targetCoins };
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
    console.log('=== BẮT ĐẦU QUÉT THỊ TRƯỜNG (VOL > 2M + BD24 < -2% + 4H EMA10 + 15M EMA20 + 5M BBT) ===\n');

    const sentLog = loadSentLog();
    const currentTime = Date.now();

    // Bước 1 & 2: Lọc Volume 24h > 2M và bd24 < -2%
    const { totalSwaps, afterVolCount, targetCoins } = await getFilteredMarkets();

    const counts = {
      totalSwaps,
      afterVol24h: afterVolCount,
      afterBd24: targetCoins.length,
      afterDiffEma10_4H: 0,
      afterDiffEma20_15M: 0,
      afterBbt_5M: 0,
      afterCooldown: 0,
      telegramSent: 0
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;
      const shortName = symbol.replace('-USDT-SWAP', '');
      const coinName = escapeHtml(shortName);
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      // Bước 3: Gọi nến 4H và lọc diffema10 (4H) < -1%
      const candles4H = await getCandles(symbol, '4H', 100);
      if (!candles4H || candles4H.length < 30) {
        await sleep(50);
        continue;
      }

      const closed4HChronological = candles4H.slice(1).reverse();
      const diffema10_4H = getDiffEma(closed4HChronological, EMA10_PERIOD);

      if (diffema10_4H === null || diffema10_4H >= MAX_DIFF_EMA10_4H) {
        await sleep(50);
        continue;
      }
      counts.afterDiffEma10_4H++;

      // Bước 4: Gọi tiếp nến 15m và lọc diffema20 (15m) < -1%
      const candles15M = await getCandles(symbol, '15m', 100);
      if (!candles15M || candles15M.length < 50) {
        await sleep(50);
        continue;
      }

      const closed15MChronological = candles15M.slice(1).reverse();
      const diffema20_15M = getDiffEma(closed15MChronological, EMA20_PERIOD);

      if (diffema20_15M === null || diffema20_15M >= MAX_DIFF_EMA20_15M) {
        await sleep(50);
        continue;
      }
      counts.afterDiffEma20_15M++;

      // Bước 5: Gọi nến 5m của coin đó, kiểm tra -0.5% < bbt < 0.5%
      const candles5M = await getCandles(symbol, '5m', 100);
      if (!candles5M || candles5M.length < BB_PERIOD + 5) {
        await sleep(50);
        continue;
      }

      const closed5MNewestFirst = candles5M.slice(1);
      const highCandle1 = parseFloat(closed5MNewestFirst[0][2]); // Giá cao nhất của nến 5m vừa đóng

      const closed5MChronological = [...closed5MNewestFirst].reverse();
      const upperBB5M = calculateLatestUpperBB(closed5MChronological, BB_PERIOD, BB_STD_DEV);

      if (upperBB5M === null || upperBB5M <= 0 || highCandle1 <= 0) {
        await sleep(50);
        continue;
      }

      const bbtPercent = ((highCandle1 - upperBB5M) / upperBB5M) * 100;

      if (bbtPercent <= MIN_BBT_5M || bbtPercent >= MAX_BBT_5M) {
        await sleep(50);
        continue;
      }
      counts.afterBbt_5M++;

      // Bước 6: Kiểm tra Cooldown 24h trong sent_ema.json
      const signalKey = `${symbol}_SHORT_BBT_EMA20`;
      const lastSent = sentLog[signalKey] || 0;
      if (currentTime - lastSent < COOLDOWN_TIME) {
        await sleep(50);
        continue;
      }
      counts.afterCooldown++;

      // Bước 7: Lưu coin thỏa điều kiện vào sent_ema.json
      sentLog[signalKey] = currentTime;
      saveSentLog(sentLog);

      const bd24Str = `${coin.bd24 >= 0 ? '+' : ''}${coin.bd24.toFixed(2)}%`;
      const diff4HStr = `${diffema10_4H >= 0 ? '+' : ''}${diffema10_4H.toFixed(2)}%`;
      const diff15MStr = `${diffema20_15M >= 0 ? '+' : ''}${diffema20_15M.toFixed(2)}%`;
      const bbtStr = `${bbtPercent >= 0 ? '+' : ''}${bbtPercent.toFixed(2)}%`;

      console.log(
        `[SHORT SIGNAL] ${symbol} | bd24: ${bd24Str} | diffema10 (4H): ${diff4HStr} | diffema20 (15m): ${diff15MStr} | bbt (5m): ${bbtStr}`
      );

      // Bước 8: Gửi tin Telegram
      const msg =
        `<b>🔴 SHORT ${coinName}</b>\n` +
        `• Biến động 24h (bd24): <b>${bd24Str}</b>\n` +
        `• diffema10 (4H): <b>${diff4HStr}</b>\n` +
        `• diffema20 (15m): <b>${diff15MStr}</b>\n` +
        `• bbt (5m): <b>${bbtStr}</b>\n` +
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
    console.log(`3. Sau lọc bd24 < ${MAX_BD24}%: ${counts.afterBd24}`);
    console.log(`4. Sau lọc diffema10 (4H) < ${MAX_DIFF_EMA10_4H}%: ${counts.afterDiffEma10_4H}`);
    console.log(`5. Sau lọc diffema20 (15m) < ${MAX_DIFF_EMA20_15M}%: ${counts.afterDiffEma20_15M}`);
    console.log(`6. Sau lọc bbt (5m) trong khoảng (${MIN_BBT_5M}%, +${MAX_BBT_5M}%): ${counts.afterBbt_5M}`);
    console.log(`7. Sau lọc Cooldown 24h: ${counts.afterCooldown}`);
    console.log(`8. Đã gửi Telegram: ${counts.telegramSent}`);
    console.log('----------------------------------------------\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
