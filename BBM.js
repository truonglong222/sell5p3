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
const MIN_BD3_15M = 3.0; // Biến động 3 nến 15m > 3%
const MAX_DIFFEMA10_1H = -1.0; // Ngưỡng diffema10 (1H): < -1%
const MAX_DIFFEMA10_4H = -1.0; // Ngưỡng diffema10 (4H): < -1%

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

async function getCandles(symbol, bar = '15m', limit = 50) {
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
      afterBD3_15m: 0,
      fetchedCandles1H_4H: 0,
      matchedShort1H_4H: 0,
      afterCooldown: 0,
      telegramSent: 0
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;
      const shortName = symbol.replace('-USDT-SWAP', '');
      const coinName = escapeHtml(shortName);
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      // Bước 2: Lấy nến 15m, kiểm tra bd3 > 3% (chỉ cần lấy 5 nến là đủ)
      const candles15m = await getCandles(symbol, '15m', 5);
      if (!candles15m || candles15m.length < 4) {
        await sleep(50);
        continue;
      }

      // Bỏ nến đang chạy (index 0), lấy danh sách nến đã đóng từ mới -> cũ
      const closed15m = candles15m.slice(1);
      const closeCandle1 = parseFloat(closed15m[0][4]);
      const openCandle3 = parseFloat(closed15m[2][1]);

      if (openCandle3 <= 0) {
        await sleep(50);
        continue;
      }

      const bd3 = ((closeCandle1 - openCandle3) / openCandle3) * 100;
      if (bd3 <= MIN_BD3_15M) {
        await sleep(50);
        continue;
      }
      counts.afterBD3_15m++;

      // Bước 3: Gọi nến 1H và 4H để kiểm tra diffema10 đều < -1%
      const [candles1H, candles4H] = await Promise.all([
        getCandles(symbol, '1H', 50),
        getCandles(symbol, '4H', 50)
      ]);

      if (!candles1H || candles1H.length < 32 || !candles4H || candles4H.length < 32) {
        await sleep(50);
        continue;
      }
      counts.fetchedCandles1H_4H++;

      const closes1H = [...candles1H.slice(1)].reverse().map((c) => parseFloat(c[4]));
      const closes4H = [...candles4H.slice(1)].reverse().map((c) => parseFloat(c[4]));

      const diffema10_1H = calculateDiffEMA(closes1H, 10, 20);
      const diffema10_4H = calculateDiffEMA(closes4H, 10, 20);

      if (
        diffema10_1H === null ||
        diffema10_4H === null ||
        diffema10_1H >= MAX_DIFFEMA10_1H ||
        diffema10_4H >= MAX_DIFFEMA10_4H
      ) {
        await sleep(50);
        continue;
      }
      counts.matchedShort1H_4H++;

      // Bước 4: Kiểm tra Cooldown 24h cho tín hiệu SHORT
      const signalKey = `${symbol}_SHORT`;
      const lastSent = sentLog[signalKey] || 0;
      if (currentTime - lastSent < COOLDOWN_TIME) {
        await sleep(50);
        continue;
      }
      counts.afterCooldown++;

      // Bước 5: Lưu log Cooldown & Gửi Telegram
      sentLog[signalKey] = currentTime;
      saveSentLog(sentLog);

      const volStr = `${(coin.volUsdt / 1_000_000).toFixed(2)}M USDT`;
      const bd3Str = `+${bd3.toFixed(2)}%`;
      const diff10_1HStr = `${diffema10_1H.toFixed(2)}%`;
      const diff10_4HStr = `${diffema10_4H.toFixed(2)}%`;

      console.log(
        `[SHORT SIGNAL] ${symbol} | Vol24h: ${volStr} | bd3(15m): ${bd3Str} | diffema10(1H): ${diff10_1HStr} | diffema10(4H): ${diff10_4HStr}`
      );

      const msg =
        `<b>🔴 TÍN HIỆU SHORT</b>\n` +
        `Coin: <b>${coinName}</b>\n` +
        `• Vol 24h: <b>${volStr}</b>\n` +
        `• bd3 (15m): <b>${bd3Str}</b>\n` +
        `• diffema10 (1H): <b>${diff10_1HStr}</b>\n` +
        `• diffema10 (4H): <b>${diff10_4HStr}</b>\n` +
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
    console.log(`3. Sau lọc bd3 (15m) > ${MIN_BD3_15M}%: ${counts.afterBD3_15m}`);
    console.log(`4. Gọi nến 1H & 4H thành công: ${counts.fetchedCandles1H_4H}`);
    console.log(`5. Đạt tín hiệu SHORT (diffema10 1H & 4H < -1%): ${counts.matchedShort1H_4H}`);
    console.log(`6. Sau lọc Cooldown 24h: ${counts.afterCooldown}`);
    console.log(`7. Đã gửi Telegram: ${counts.telegramSent}`);
    console.log('----------------------------------------------\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
