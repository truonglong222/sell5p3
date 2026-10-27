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

// Cấu hình Cooldown & Ngưỡng lọc
const COOLDOWN_TIME_LONG = 48 * 60 * 60 * 1000;      // 48h cho Long
const COOLDOWN_TIME_SHORT = 24 * 60 * 60 * 1000;     // 24h cho Short
const MIN_VOL_CCY24H = 5_000_000;                    // Volume 24h > 5 triệu USDT

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------- HÀM TIỆN ÍCH TRÁNH LỖI HTML TELEGRAM -------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ------------------- QUẢN LÝ DỮ LIỆU FILE -------------------
function cleanExpiredLogs(logData) {
  const now = Date.now();
  const cleanedLog = {};

  for (const [key, timestamp] of Object.entries(logData)) {
    const isLong = key.endsWith('_LONG');
    const cooldownLimit = isLong ? COOLDOWN_TIME_LONG : COOLDOWN_TIME_SHORT;

    if (now - timestamp < cooldownLimit) {
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

function calculateBollingerBands(prices, period = 20, multiplier = 2) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;

  const variance = slice.reduce((sum, price) => sum + Math.pow(price - mid, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = mid + multiplier * stdDev;
  const lower = mid - multiplier * stdDev;

  return { mid, upper, lower };
}

// ------------------- LỌC THỊ TRƯỜNG & LẤY NẾN -------------------
async function getFilteredMarkets() {
  let allSwaps = 0;
  let passedVol = 0;
  const targetCoins = [];

  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') {
      return { allSwaps, passedVol, targetCoins };
    }

    const tickers = res.data.data.filter((item) => item.instId.endsWith('-USDT-SWAP'));
    allSwaps = tickers.length;

    for (const item of tickers) {
      const vol = parseFloat(item.volCcy24h || 0);
      if (vol > MIN_VOL_CCY24H) {
        passedVol++;
        targetCoins.push({
          instId: item.instId,
          volCcy24h: vol
        });
      }
    }

    return { allSwaps, passedVol, targetCoins };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { allSwaps, passedVol, targetCoins };
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
    console.log('=== BẮT ĐẦU QUÉT THỊ TRƯỜNG ===\n');

    const sentLog = loadSentLog();
    const currentTime = Date.now();

    const { allSwaps, passedVol, targetCoins } = await getFilteredMarkets();

    const stats = {
      allSwaps,
      passedVol,
      candlesValid: 0,
      passedDiffEMA: 0,
      passedDiffShortBase: 0, // diffema10 < -2%
      passedDiffLongBase: 0,  // diffema10 > 2%
      shortSignals: 0,
      shortSentSuccess: 0,
      shortSkippedCooldown: 0,
      longSignals: 0,
      longSentSuccess: 0,
      longSkippedCooldown: 0
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;
      const coinName = escapeHtml(symbol.replace('-USDT-SWAP', ''));
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      // Lấy 80 nến 5m
      const candles5m = await getCandles(symbol, '5m', 80);
      if (!candles5m || candles5m.length < 35) {
        await sleep(60);
        continue;
      }

      // candles5m[0] là nến đang chạy, closedCandles[0] là nến số 1 (đã đóng gần nhất)
      const closedCandles = candles5m.slice(1);
      if (closedCandles.length < 25) {
        await sleep(60);
        continue;
      }

      stats.candlesValid++;

      // Chuỗi giá đóng cửa theo thứ tự thời gian tăng dần
      const chronological5m = [...closedCandles].reverse();
      const closes5m = chronological5m.map((c) => parseFloat(c[4]));

      // Tính EMA20
      const emaArray5m = calculateEMA(closes5m, 20);
      if (emaArray5m.length < 10) {
        await sleep(60);
        continue;
      }

      // DiffEMA10 = ((EMA1 - EMA10) / EMA10) * 100
      const ema1Val = emaArray5m[emaArray5m.length - 1];
      const ema10Val = emaArray5m[emaArray5m.length - 10];
      if (ema10Val === 0) {
        await sleep(60);
        continue;
      }

      const diffema10 = ((ema1Val - ema10Val) / ema10Val) * 100;

      // LỌC SAU VOLUME: Giữ lại coin có diffema10 < -2% HOẶC diffema10 > 2%
      const isDiffShort = diffema10 < -2.0;
      const isDiffLong = diffema10 > 2.0;

      if (!isDiffShort && !isDiffLong) {
        await sleep(60);
        continue;
      }

      stats.passedDiffEMA++;
      if (isDiffShort) stats.passedDiffShortBase++;
      if (isDiffLong) stats.passedDiffLongBase++;

      // THÔNG SỐ NẾN 1 (closedCandles[0])
      const open1 = parseFloat(closedCandles[0][1]);
      const close1 = parseFloat(closedCandles[0][4]);
      const isCandle1Green = close1 > open1;
      const isCandle1Red = close1 < open1;

      // THÔNG SỐ NẾN 2 (closedCandles[1])
      const high2 = parseFloat(closedCandles[1][2]);
      const low2 = parseFloat(closedCandles[1][3]);

      // BOLLINGER BAND MID NẾN 2 (SMA 20 của 20 nến tính từ nến số 2 trở về trước)
      const closesBB2 = closedCandles.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
      const bb2 = calculateBollingerBands(closesBB2, 20, 2);

      if (!bb2 || bb2.mid === 0) {
        await sleep(60);
        continue;
      }

      const bbMid2 = bb2.mid;

      // Tính bbms và bbml
      const bbms = ((high2 - bbMid2) / bbMid2) * 100; // High nến 2 - BB Mid nến 2
      const bbml = ((low2 - bbMid2) / bbMid2) * 100;  // Low nến 2 - BB Mid nến 2

      // ==================== 1. KIỂM TRA ĐIỀU KIỆN SHORT ====================
      // diffema10 < -2%, bbms > -0.5%, nến 1 là nến đỏ (bỏ điều kiện màu nến 2)
      if (isDiffShort && bbms > -0.5 && isCandle1Red) {
        stats.shortSignals++;

        const shortKey = `${symbol}_SHORT`;
        const lastSentShort = sentLog[shortKey] || 0;
        const isInShortCooldown = (currentTime - lastSentShort) < COOLDOWN_TIME_SHORT;

        if (isInShortCooldown) {
          stats.shortSkippedCooldown++;
        } else {
          sentLog[shortKey] = currentTime;
          saveSentLog(sentLog);

          const diffemaStr = diffema10.toFixed(2);
          const bbmsStr = bbms.toFixed(2);

          console.log(`[SHORT MATCHED] ${symbol} | DiffEMA10: ${diffemaStr}% | bbms: ${bbmsStr}%`);

          const shortMsg =
            `<b>⚠️ TÍN HIỆU SHORT</b>\n` +
            `Coin: <b>${coinName}</b> (5m)\n` +
            `DiffEMA10: <b>${diffemaStr}%</b> (&lt; -2%)\n` +
            `bbms (High nến 2 - BB Mid): <b>${bbmsStr}%</b> (&gt; -0.5%)\n` +
            `Pattern: <b>Nến 1 Đỏ</b>\n` +
            `<a href="${link}">🔗 Giao dịch OKX</a>`;

          const isSent = await sendTelegramMessage(shortMsg);
          if (isSent) stats.shortSentSuccess++;
        }
      }

      // ==================== 2. KIỂM TRA ĐIỀU KIỆN LONG ====================
      // diffema10 > 2%, bbml < 0.5%, nến 1 là nến xanh (bỏ điều kiện màu nến 2)
      if (isDiffLong && bbml < 0.5 && isCandle1Green) {
        stats.longSignals++;

        const longKey = `${symbol}_LONG`;
        const lastSentLong = sentLog[longKey] || 0;
        const isInLongCooldown = (currentTime - lastSentLong) < COOLDOWN_TIME_LONG;

        if (isInLongCooldown) {
          stats.longSkippedCooldown++;
        } else {
          sentLog[longKey] = currentTime;
          saveSentLog(sentLog);

          const diffemaStr = diffema10.toFixed(2);
          const bbmlStr = bbml.toFixed(2);

          console.log(`[LONG MATCHED] ${symbol} | DiffEMA10: ${diffemaStr}% | bbml: ${bbmlStr}%`);

          const longMsg =
            `<b>🚀 TÍN HIỆU LONG</b>\n` +
            `Coin: <b>${coinName}</b> (5m)\n` +
            `DiffEMA10: <b>+${diffemaStr}%</b> (&gt; 2%)\n` +
            `bbml (Low nến 2 - BB Mid): <b>${bbmlStr}%</b> (&lt; 0.5%)\n` +
            `Pattern: <b>Nến 1 Xanh</b>\n` +
            `<a href="${link}">🔗 Giao dịch OKX</a>`;

          const isSent = await sendTelegramMessage(longMsg);
          if (isSent) stats.longSentSuccess++;
        }
      }

      await sleep(100);
    }

    // ------------------- BÁO CÁO THỐNG KÊ CHI TIẾT -------------------
    console.log('\n================ BÁO CÁO THỐNG KÊ CHI TIẾT ================');
    console.log(`1. Tổng số cặp SWAP từ OKX                   : ${stats.allSwaps} coin`);
    console.log(`2. Số coin qua lọc Volume (> 5M USDT)         : ${stats.passedVol} coin`);
    console.log(`3. Số coin tải đủ dữ liệu nến 5m hợp lệ       : ${stats.candlesValid} coin`);
    console.log(`4. Số coin thỏa mãn |DiffEMA10| > 2%          : ${stats.passedDiffEMA} coin`);
    console.log(`   - DiffEMA10 < -2% (Ứng viên Short)         : ${stats.passedDiffShortBase} coin`);
    console.log(`   - DiffEMA10 > 2%  (Ứng viên Long)          : ${stats.passedDiffLongBase} coin`);
    console.log('------------------------------------------------------------');
    console.log(`[KẾT QUẢ SHORT]`);
    console.log(`- Thỏa mãn điều kiện Short (DiffEMA, bbms, Nến 1 Đỏ): ${stats.shortSignals} coin`);
    console.log(`- Bỏ qua do Cooldown (24h)                          : ${stats.shortSkippedCooldown} coin`);
    console.log(`- Gửi Telegram thành công                           : ${stats.shortSentSuccess} tin`);
    console.log('------------------------------------------------------------');
    console.log(`[KẾT QUẢ LONG]`);
    console.log(`- Thỏa mãn điều kiện Long (DiffEMA, bbml, Nến 1 Xanh): ${stats.longSignals} coin`);
    console.log(`- Bỏ qua do Cooldown (48h)                           : ${stats.longSkippedCooldown} coin`);
    console.log(`- Gửi Telegram thành công                            : ${stats.longSentSuccess} tin`);
    console.log('============================================================\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
