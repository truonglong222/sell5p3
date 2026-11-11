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

// Cấu hình Cooldown 24 giờ & Ngưỡng biến động 24h > 5%
const COOLDOWN_TIME = 24 * 60 * 60 * 1000;
const MIN_BD24 = 5.0; // Biến động 24h > 5%

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------- HÀM TIỆN ÍCH TRÁNH LỖI HTML TELEGRAM -------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ------------------- QUẢN LÝ DỮ LIỆU FILE LOG GỬI TIN -------------------

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

// ------------------- HÀM TÍNH TOÁN KỸ THUẬT -------------------

function calculateEMA(prices, period = 20) {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const emaArray = [];
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += prices[i];
  }
  let prevEMA = sum / period;
  emaArray.push(prevEMA);

  for (let i = period; i < prices.length; i++) {
    prevEMA = (prices[i] - prevEMA) * k + prevEMA;
    emaArray.push(prevEMA);
  }
  return emaArray;
}

function calculateBollingerBandMid(closes, period = 20) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((acc, val) => acc + val, 0) / period;
  return sma;
}

// ------------------- LỌC THỊ TRƯỜNG & LẤY NẾN -------------------

async function getFilteredMarkets() {
  let allSwaps = 0;
  let passedBD24 = 0;
  const targetCoins = [];

  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') {
      return { allSwaps, passedBD24, targetCoins };
    }

    const tickers = res.data.data.filter((item) => item.instId.endsWith('-USDT-SWAP'));
    allSwaps = tickers.length;

    for (const item of tickers) {
      const last = parseFloat(item.last || 0);
      const open24h = parseFloat(item.open24h || 0);

      if (open24h > 0 && last > 0) {
        // Tính % biến động giá 24h
        const bd24 = ((last - open24h) / open24h) * 100;

        if (bd24 > MIN_BD24) {
          passedBD24++;
          targetCoins.push({
            instId: item.instId,
            bd24
          });
        }
      }
    }

    return { allSwaps, passedBD24, targetCoins };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { allSwaps, passedBD24, targetCoins };
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
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }, { timeout: 8000 });
    return true;
  } catch (err) {
    console.error('Lỗi gửi Telegram:', err.response ? JSON.stringify(err.response.data) : err.message);
    return false;
  }
}

// ------------------- TIẾN TRÌNH CHÍNH -------------------

async function main() {
  try {
    console.log('=== BẮT ĐẦU QUÉT THỊ TRƯỜNG SHORT (BD24 > 5%, DIFFEMA10, BBM) ===\n');

    const sentLog = loadSentLog();
    const currentTime = Date.now();

    const { allSwaps, passedBD24, targetCoins } = await getFilteredMarkets();

    let skippedCooldown = 0;
    let shortSentSuccess = 0;

    for (const coin of targetCoins) {
      const symbol = coin.instId;
      const coinName = escapeHtml(symbol.replace('-USDT-SWAP', ''));
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      // 1. Kiểm tra Cooldown 24h
      const shortKey = `${symbol}_SHORT`;
      const lastSentShort = sentLog[shortKey] || 0;
      if (currentTime - lastSentShort < COOLDOWN_TIME) {
        skippedCooldown++;
        continue;
      }

      // 2. Lấy nến 15m (OKX trả về mảng nến mới nhất ở index 0)
      const candles15m = await getCandles(symbol, '15m', 80);
      // Cần tối thiểu ~35 nến đã đóng để tính EMA20 + 10 chu kỳ lùi
      if (!candles15m || candles15m.length < 35) {
        await sleep(60);
        continue;
      }

      // Nến index 0 là nến đang chạy, index 1 là nến 15m vừa đóng
      const closedCandle1 = candles15m[1];
      const highJustClosed = parseFloat(closedCandle1[2]);

      // Chuẩn bị chuỗi nến đã đóng theo thứ tự thời gian tăng dần
      const closed15m = candles15m.slice(1);
      const chronological15m = [...closed15m].reverse();
      const closes15m = chronological15m.map((c) => parseFloat(c[4]));

      // 3. Tính diffema10 nến 15m (so sánh EMA nến vừa đóng với EMA 10 nến trước)
      const emaArray15m = calculateEMA(closes15m, 20);
      let diffema10 = null;

      if (emaArray15m.length >= 11) {
        const emaCurrent = emaArray15m[emaArray15m.length - 1];
        const ema10Ago = emaArray15m[emaArray15m.length - 1 - 10];
        if (ema10Ago !== 0) {
          diffema10 = ((emaCurrent - ema10Ago) / ema10Ago) * 100;
        }
      }

      if (diffema10 === null) {
        await sleep(60);
        continue;
      }

      // Điều kiện 1: diffema10 < -0.7%
      if (diffema10 >= -0.7) {
        await sleep(60);
        continue;
      }

      // 4. Tính bbm = % chênh lệch giá cao nhất nến vừa đóng và giá trị Bollinger band mid (SMA20)
      const bbMid = calculateBollingerBandMid(closes15m, 20);
      if (!bbMid || bbMid <= 0) {
        await sleep(60);
        continue;
      }

      const bbm = ((highJustClosed - bbMid) / bbMid) * 100;

      // Điều kiện 2: -0.5% < bbm < 3%
      if (bbm <= -0.5 || bbm >= 3.0) {
        await sleep(60);
        continue;
      }

      // 5. Thỏa mãn toàn bộ điều kiện -> Gửi cảnh báo SHORT
      sentLog[shortKey] = currentTime;
      saveSentLog(sentLog);

      const bd24Str = `${coin.bd24 >= 0 ? '+' : ''}${coin.bd24.toFixed(2)}%`;
      const diffema10Str = `${diffema10.toFixed(4)}%`;
      const bbmStr = `${bbm.toFixed(4)}%`;

      console.log(`[SHORT SIGNAL] ${symbol} | BD24: ${bd24Str} | DiffEMA10: ${diffema10Str} | BBM: ${bbmStr}`);

      const shortMsg =
        `<b>🔴 TÍN HIỆU SHORT</b>\n` +
        `Coin: <b>${coinName}</b>\n` +
        `• BD24: <b>${bd24Str}</b>\n` +
        `• DiffEMA10: <b>${diffema10Str}</b>\n` +
        `• BBM: <b>${bbmStr}</b>\n` +
        `<a href="${link}">🔗 Giao dịch OKX</a>`;

      const isSent = await sendTelegramMessage(shortMsg);
      if (isSent) shortSentSuccess++;

      await sleep(100);
    }

    // ------------------- BÁO CÁO THỐNG KÊ RÚT GỌN -------------------
    console.log('\n--- KẾT QUẢ QUÉT THỊ TRƯỜNG ---');
    console.log(`Tổng SWAP: ${allSwaps}`);
    console.log(`Biến động 24h > 5%: ${passedBD24}`);
    console.log(`Bỏ qua do Cooldown 24h: ${skippedCooldown}`);
    console.log(`Đã gửi cảnh báo SHORT: ${shortSentSuccess}`);
    console.log('-------------------------------\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
