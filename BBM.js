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
const COOLDOWN_TIME = 1 * 60 * 60 * 1000; // Cooldown 1 giờ
const MIN_VOL_24H = 2_000_000;             // Volume 24h > 2 triệu USDT
const MAX_DIFF_EMA20_15M = -2.0;           // diffema20 (15m) < -2%
const MIN_BBT_5M = 0.0;                    // bbt (5m) > 0%
const MAX_BBD_5M = 0.0;                    // bbd (5m) < 0% (điều kiện đóng lệnh)

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

// Tính các dải Bollinger Bands (Upper, Middle, Lower) tại nến vừa đóng (thứ tự cũ -> mới)
function calculateLatestBB(closedCandlesChronological, period = 20, multiplier = 2) {
  if (closedCandlesChronological.length < period) return null;

  const recentCandles = closedCandlesChronological.slice(-period);
  const closes = recentCandles.map((c) => parseFloat(c[4]));

  const sum = closes.reduce((acc, val) => acc + val, 0);
  const sma = sum / period;

  const variance = closes.reduce((acc, val) => acc + Math.pow(val - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    upper: sma + multiplier * stdDev,
    middle: sma,
    lower: sma - multiplier * stdDev
  };
}

// Lấy danh sách USDT-SWAP và chỉ lọc Volume 24h > 2M USDT
async function getFilteredMarkets() {
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

      if (volUsdt <= MIN_VOL_24H) continue;

      targetCoins.push({ instId: item.instId, volUsdt });
    }

    return { totalSwaps, targetCoins };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { totalSwaps, targetCoins };
  }
}

async function getCandles(symbol, bar = '15m', limit = 100) {
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

// =========================================================================
// NHÁNH 1: QUÉT TÍN HIỆU VÀO LỆNH SHORT
// =========================================================================
async function runShortScanner() {
  console.log('=== [NHÁNH 1] BẮT ĐẦU QUÉT TÍN HIỆU SHORT ===\n');

  const currentTime = Date.now();
  const { totalSwaps, targetCoins } = await getFilteredMarkets();

  const counts = {
    totalSwaps,
    afterVol24h: targetCoins.length,
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

    // 1. Lấy dữ liệu nến 15m và lọc diffema20 (15m) < -2%
    const candles15M = await getCandles(symbol, '15m', 100);
    if (!candles15M || candles15M.length < EMA20_PERIOD + 5) {
      await sleep(50);
      continue;
    }

    const closed15MNewestFirst = candles15M.slice(1);
    const closed15MChronological = [...closed15MNewestFirst].reverse();

    const diffema20_15M = getDiffEma(closed15MChronological, EMA20_PERIOD);
    if (diffema20_15M === null || diffema20_15M >= MAX_DIFF_EMA20_15M) {
      await sleep(50);
      continue;
    }
    counts.afterDiffEma20_15M++;

    // 2. Gọi nến 5m của những coin thỏa diffema20 (15m) < -2%
    const candles5M = await getCandles(symbol, '5m', 100);
    if (!candles5M || candles5M.length < BB_PERIOD + 5) {
      await sleep(50);
      continue;
    }

    const closed5MNewestFirst = candles5M.slice(1);
    const closed5MChronological = [...closed5MNewestFirst].reverse();

    const bb5M = calculateLatestBB(closed5MChronological, BB_PERIOD, BB_STD_DEV);
    const highCandle1_5M = parseFloat(closed5MNewestFirst[0][2]); // Giá cao nhất nến 5m vừa đóng

    if (!bb5M || bb5M.upper <= 0 || highCandle1_5M <= 0) {
      await sleep(50);
      continue;
    }

    // Kiểm tra bbt (5m) > 0%
    const bbtPercent5M = ((highCandle1_5M - bb5M.upper) / bb5M.upper) * 100;
    if (bbtPercent5M <= MIN_BBT_5M) {
      await sleep(50);
      continue;
    }
    counts.afterBbt_5M++;

    // 3. Kiểm tra Cooldown (1H)
    const signalKey = `${symbol}_SHORT_BBT_EMA20`;
    const latestLog = loadSentLog();
    const lastSent = latestLog[signalKey] || 0;
    if (currentTime - lastSent < COOLDOWN_TIME) {
      await sleep(50);
      continue;
    }
    counts.afterCooldown++;

    // Lưu vào sent_ema.json sau khi thỏa mãn toàn bộ điều kiện
    latestLog[signalKey] = currentTime;
    saveSentLog(latestLog);

    const volStr = `${(coin.volUsdt / 1_000_000).toFixed(2)}M`;
    const diff15MStr = `${diffema20_15M >= 0 ? '+' : ''}${diffema20_15M.toFixed(2)}%`;
    const bbt5MStr = `${bbtPercent5M >= 0 ? '+' : ''}${bbtPercent5M.toFixed(2)}%`;

    console.log(
      `[SHORT SIGNAL] ${symbol} | Vol24h: ${volStr} | diffema20 (15m): ${diff15MStr} | bbt (5m): ${bbt5MStr}`
    );

    const msg =
      `<b>🔴 SHORT ${coinName}</b>\n` +
      `• Vol 24h: <b>${volStr} USDT</b>\n` +
      `• diffema20 (15m): <b>${diff15MStr}</b>\n` +
      `• bbt (5m): <b>${bbt5MStr}</b>\n` +
      `<a href="${link}">🔗 Giao dịch OKX</a>`;

    const isSent = await sendTelegramMessage(msg);
    if (isSent) {
      counts.telegramSent++;
    }

    await sleep(100);
  }

  console.log('\n--- THỐNG KÊ NHÁNH SHORT ---');
  console.log(`1. Tổng cặp USDT-SWAP: ${counts.totalSwaps}`);
  console.log(`2. Sau lọc Vol 24h > ${MIN_VOL_24H / 1_000_000}M: ${counts.afterVol24h}`);
  console.log(`3. Sau lọc diffema20 (15m) < ${MAX_DIFF_EMA20_15M}%: ${counts.afterDiffEma20_15M}`);
  console.log(`4. Sau lọc bbt (5m) > ${MIN_BBT_5M}%: ${counts.afterBbt_5M}`);
  console.log(`5. Sau lọc Cooldown (1H): ${counts.afterCooldown}`);
  console.log(`6. Đã gửi Telegram SHORT: ${counts.telegramSent}`);
  console.log('----------------------------\n');
}

// =========================================================================
// NHÁNH 2: QUÉT TÍN HIỆU ĐÓNG LỆNH (CÁC COIN ĐANG COUNTDOWN 1H TRONG sent_ema.json)
// =========================================================================
async function runCloseScanner() {
  console.log('=== [NHÁNH 2] BẮT ĐẦU QUÉT TÍN HIỆU ĐÓNG LỆNH ===\n');

  const sentLog = loadSentLog();
  const currentTime = Date.now();

  // Lấy danh sách các coin đang trong thời gian countdown của lệnh SHORT
  const activeShortSymbols = Object.keys(sentLog)
    .filter((key) => key.endsWith('_SHORT_BBT_EMA20'))
    .map((key) => key.replace('_SHORT_BBT_EMA20', ''));

  let checkedCount = 0;
  let closeAlertSent = 0;

  for (const symbol of activeShortSymbols) {
    checkedCount++;
    const shortName = symbol.replace('-USDT-SWAP', '');
    const coinName = escapeHtml(shortName);
    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

    // Kiểm tra xem coin này đã báo đóng lệnh trong đợt cooldown hiện tại chưa
    const closeAlertKey = `${symbol}_CLOSE_ALERT`;
    const shortSentTime = sentLog[`${symbol}_SHORT_BBT_EMA20`] || 0;
    const lastCloseAlertTime = sentLog[closeAlertKey] || 0;

    if (lastCloseAlertTime >= shortSentTime && lastCloseAlertTime > 0) {
      continue;
    }

    // Lấy nến 5m của coin đang countdown
    const candles5M = await getCandles(symbol, '5m', 100);
    if (!candles5M || candles5M.length < BB_PERIOD + 5) {
      await sleep(50);
      continue;
    }

    const closed5MNewestFirst = candles5M.slice(1);
    const lowCandle1_5M = parseFloat(closed5MNewestFirst[0][3]); // Giá thấp nhất (low) của nến 5m vừa đóng

    const closed5MChronological = [...closed5MNewestFirst].reverse();
    const bb5M = calculateLatestBB(closed5MChronological, BB_PERIOD, BB_STD_DEV);

    if (!bb5M || bb5M.lower <= 0 || lowCandle1_5M <= 0) {
      await sleep(50);
      continue;
    }

    // bbd (5m) = chênh lệch % giá thấp nhất của nến 5m vừa đóng và giá trị Bollinger band dưới
    const bbdPercent5M = ((lowCandle1_5M - bb5M.lower) / bb5M.lower) * 100;

    if (bbdPercent5M < MAX_BBD_5M) {
      const latestLog = loadSentLog();
      latestLog[closeAlertKey] = currentTime;
      saveSentLog(latestLog);

      const bbdStr = `${bbdPercent5M >= 0 ? '+' : ''}${bbdPercent5M.toFixed(2)}%`;

      console.log(`[CLOSE SIGNAL] ${symbol} | bbd (5m): ${bbdStr}`);

      const msg =
        `<b>🟢 Đóng lệnh ${coinName}</b>\n` +
        `• bbd (5m): <b>${bbdStr}</b>\n` +
        `<a href="${link}">🔗 Giao dịch OKX</a>`;

      const isSent = await sendTelegramMessage(msg);
      if (isSent) {
        closeAlertSent++;
      }
    }

    await sleep(50);
  }

  console.log('\n--- THỐNG KÊ NHÁNH ĐÓNG LỆNH ---');
  console.log(`1. Số coin đang countdown (1H): ${activeShortSymbols.length}`);
  console.log(`2. Số coin đã kiểm tra: ${checkedCount}`);
  console.log(`3. Đã gửi Telegram Đóng lệnh: ${closeAlertSent}`);
  console.log('--------------------------------\n');
}

// =========================================================================
// HÀM CHÍNH ĐIỀU PHỐI 2 NHÁNH ĐỘC LẬP
// =========================================================================
async function main() {
  try {
    await Promise.allSettled([
      runShortScanner(),
      runCloseScanner()
    ]);
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
