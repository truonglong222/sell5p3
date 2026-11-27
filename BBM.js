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
const MIN_HBB_15M = 3.0;                   // Hbb (15m) > 3%
const MIN_DIFF_EMA20_15M = 0.5;            // diffema20 (15m) > 0.5%
const MIN_BBT_15M = -0.5;                  // bbt (15m) > -0.5%
const MAX_DIFF_EMA10_1H = -1.0;            // diffema10 (1H) < -1%
const MAX_DIFF_EMA10_4H = -1.0;            // diffema10 (4H) < -1%
const MAX_BBD_15M = 0.0;                   // bbd (15m) < 0% (điều kiện đóng lệnh)

const EMA10_PERIOD = 10;                   // Chu kỳ EMA 10 (khung 1H & 4H)
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
    afterHbb_15M: 0,
    afterDiffEma20_15M: 0,
    afterBbt_15M: 0,
    afterCooldown: 0,
    afterDiffEma10_1H: 0,
    afterDiffEma10_4H: 0,
    telegramSent: 0
  };

  for (const coin of targetCoins) {
    const symbol = coin.instId;
    const shortName = symbol.replace('-USDT-SWAP', '');
    const coinName = escapeHtml(shortName);
    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

    // Lấy dữ liệu nến 15m
    const candles15M = await getCandles(symbol, '15m', 100);
    if (!candles15M || candles15M.length < 30) {
      await sleep(50);
      continue;
    }

    const closed15MNewestFirst = candles15M.slice(1);
    const closed15MChronological = [...closed15MNewestFirst].reverse();

    // Tính Bollinger Bands khung 15m
    const bb15M = calculateLatestBB(closed15MChronological, BB_PERIOD, BB_STD_DEV);
    if (!bb15M || bb15M.upper <= 0 || bb15M.lower <= 0) {
      await sleep(50);
      continue;
    }

    // 1. Lọc Hbb (15m) > 3%
    const hbbPercent = ((bb15M.upper - bb15M.lower) / bb15M.lower) * 100;
    if (hbbPercent <= MIN_HBB_15M) {
      await sleep(50);
      continue;
    }
    counts.afterHbb_15M++;

    // 2. Lọc diffema20 (15m) > 0.5%
    const diffema20_15M = getDiffEma(closed15MChronological, EMA20_PERIOD);
    if (diffema20_15M === null || diffema20_15M <= MIN_DIFF_EMA20_15M) {
      await sleep(50);
      continue;
    }
    counts.afterDiffEma20_15M++;

    // 3. Kiểm tra nến 15m: bbt (15m) > -0.5%
    const highCandle1 = parseFloat(closed15MNewestFirst[0][2]); // Giá cao nhất nến 15m vừa đóng
    if (highCandle1 <= 0) {
      await sleep(50);
      continue;
    }

    const bbtPercent = ((highCandle1 - bb15M.upper) / bb15M.upper) * 100;
    if (bbtPercent <= MIN_BBT_15M) {
      await sleep(50);
      continue;
    }
    counts.afterBbt_15M++;

    // 4. Kiểm tra Cooldown
    const signalKey = `${symbol}_SHORT_BBT_EMA20`;
    const latestLog = loadSentLog();
    const lastSent = latestLog[signalKey] || 0;
    if (currentTime - lastSent < COOLDOWN_TIME) {
      await sleep(50);
      continue;
    }
    counts.afterCooldown++;

    // 5. Gọi nến 1H và kiểm tra diffema10 (1H) < -1%
    const candles1H = await getCandles(symbol, '1H', 100);
    if (!candles1H || candles1H.length < EMA10_PERIOD + 5) {
      await sleep(50);
      continue;
    }

    const closed1HNewestFirst = candles1H.slice(1);
    const closed1HChronological = [...closed1HNewestFirst].reverse();
    const diffema10_1H = getDiffEma(closed1HChronological, EMA10_PERIOD);

    if (diffema10_1H === null || diffema10_1H >= MAX_DIFF_EMA10_1H) {
      await sleep(50);
      continue;
    }
    counts.afterDiffEma10_1H++;

    // 6. Gọi nến 4H sau khi thỏa tất cả điều kiện trên và kiểm tra diffema10 (4H) < -1%
    const candles4H = await getCandles(symbol, '4H', 100);
    if (!candles4H || candles4H.length < EMA10_PERIOD + 5) {
      await sleep(50);
      continue;
    }

    const closed4HNewestFirst = candles4H.slice(1);
    const closed4HChronological = [...closed4HNewestFirst].reverse();
    const diffema10_4H = getDiffEma(closed4HChronological, EMA10_PERIOD);

    if (diffema10_4H === null || diffema10_4H >= MAX_DIFF_EMA10_4H) {
      await sleep(50);
      continue;
    }
    counts.afterDiffEma10_4H++;

    // Lưu vào sent_ema.json sau khi đã thỏa mãn toàn bộ điều kiện (bao gồm nến 4H)
    latestLog[signalKey] = currentTime;
    saveSentLog(latestLog);

    const volStr = `${(coin.volUsdt / 1_000_000).toFixed(2)}M`;
    const hbbStr = `${hbbPercent.toFixed(2)}%`;
    const diff15MStr = `${diffema20_15M >= 0 ? '+' : ''}${diffema20_15M.toFixed(2)}%`;
    const bbtStr = `${bbtPercent >= 0 ? '+' : ''}${bbtPercent.toFixed(2)}%`;
    const diff1HStr = `${diffema10_1H >= 0 ? '+' : ''}${diffema10_1H.toFixed(2)}%`;
    const diff4HStr = `${diffema10_4H >= 0 ? '+' : ''}${diffema10_4H.toFixed(2)}%`;

    console.log(
      `[SHORT SIGNAL] ${symbol} | Vol24h: ${volStr} | Hbb (15m): ${hbbStr} | diffema20 (15m): ${diff15MStr} | bbt (15m): ${bbtStr} | diffema10 (1H): ${diff1HStr} | diffema10 (4H): ${diff4HStr}`
    );

    const msg =
      `<b>🔴 SHORT ${coinName}</b>\n` +
      `• Vol 24h: <b>${volStr} USDT</b>\n` +
      `• Hbb (15m): <b>${hbbStr}</b>\n` +
      `• diffema20 (15m): <b>${diff15MStr}</b>\n` +
      `• bbt (15m): <b>${bbtStr}</b>\n` +
      `• diffema10 (1H): <b>${diff1HStr}</b>\n` +
      `• diffema10 (4H): <b>${diff4HStr}</b>\n` +
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
  console.log(`3. Sau lọc Hbb (15m) > ${MIN_HBB_15M}%: ${counts.afterHbb_15M}`);
  console.log(`4. Sau lọc diffema20 (15m) > ${MIN_DIFF_EMA20_15M}%: ${counts.afterDiffEma20_15M}`);
  console.log(`5. Sau lọc bbt (15m) > ${MIN_BBT_15M}%: ${counts.afterBbt_15M}`);
  console.log(`6. Sau lọc Cooldown: ${counts.afterCooldown}`);
  console.log(`7. Sau lọc diffema10 (1H) < ${MAX_DIFF_EMA10_1H}%: ${counts.afterDiffEma10_1H}`);
  console.log(`8. Sau lọc diffema10 (4H) < ${MAX_DIFF_EMA10_4H}%: ${counts.afterDiffEma10_4H}`);
  console.log(`9. Đã gửi Telegram SHORT: ${counts.telegramSent}`);
  console.log('----------------------------\n');
}

// =========================================================================
// NHÁNH 2: QUÉT TÍN HIỆU ĐÓNG LỆNH (CÁC COIN ĐANG COUNTDOWN TRONG sent_ema.json)
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

    // Lấy nến 15m của coin đang countdown
    const candles15M = await getCandles(symbol, '15m', 100);
    if (!candles15M || candles15M.length < BB_PERIOD + 5) {
      await sleep(50);
      continue;
    }

    const closed15MNewestFirst = candles15M.slice(1);
    const lowCandle1 = parseFloat(closed15MNewestFirst[0][3]); // Giá thấp nhất (low) của nến 15m vừa đóng

    const closed15MChronological = [...closed15MNewestFirst].reverse();
    const bb15M = calculateLatestBB(closed15MChronological, BB_PERIOD, BB_STD_DEV);

    if (!bb15M || bb15M.lower <= 0 || lowCandle1 <= 0) {
      await sleep(50);
      continue;
    }

    // bbd (15m) = chênh lệch % giá thấp nhất của nến 15m vừa đóng và giá trị Bollinger band dưới
    const bbdPercent = ((lowCandle1 - bb15M.lower) / bb15M.lower) * 100;

    if (bbdPercent < MAX_BBD_15M) {
      const latestLog = loadSentLog();
      latestLog[closeAlertKey] = currentTime;
      saveSentLog(latestLog);

      const bbdStr = `${bbdPercent >= 0 ? '+' : ''}${bbdPercent.toFixed(2)}%`;

      console.log(`[CLOSE SIGNAL] ${symbol} | bbd (15m): ${bbdStr}`);

      const msg =
        `<b>🟢 Đóng lệnh ${coinName}</b>\n` +
        `• bbd (15m): <b>${bbdStr}</b>\n` +
        `<a href="${link}">🔗 Giao dịch OKX</a>`;

      const isSent = await sendTelegramMessage(msg);
      if (isSent) {
        closeAlertSent++;
      }
    }

    await sleep(50);
  }

  console.log('\n--- THỐNG KÊ NHÁNH ĐÓNG LỆNH ---');
  console.log(`1. Số coin đang countdown: ${activeShortSymbols.length}`);
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
