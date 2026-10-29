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
const COOLDOWN_TIME_SHORT = 8 * 60 * 60 * 1000;      // 8h cho Short
const MIN_VOL_CCY24H = 5_000_000;                    // Volume 24h > 5 triệu USDT

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
    if (now - timestamp < COOLDOWN_TIME_SHORT) {
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

function calculateRSIArray(closes, period = 20) {
  if (closes.length <= period) return [];

  const rsiArray = [];
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  rsiArray.push(100 - (100 / (1 + rs)));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiArray.push(100 - (100 / (1 + rs)));
  }

  return rsiArray;
}

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

function calculateATR(candles, period = 14) {
  if (!candles || candles.length <= period) return null;

  const trList = [];
  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i][2]);
    const low = parseFloat(candles[i][3]);
    const prevClose = parseFloat(candles[i - 1][4]);

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trList.push(tr);
  }

  if (trList.length < period) return null;

  let atr = trList.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

  for (let i = period; i < trList.length; i++) {
    atr = (atr * (period - 1) + trList[i]) / period;
  }

  const latestClose = parseFloat(candles[candles.length - 1][4]);
  const atrPct = latestClose > 0 ? (atr / latestClose) * 100 : 0;

  return { atr, atrPct };
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
    console.log('=== BẮT ĐẦU QUÉT THỊ TRƯỜNG SHORT ===\n');

    const sentLog = loadSentLog();
    const currentTime = Date.now();

    const { allSwaps, passedVol, targetCoins } = await getFilteredMarkets();

    const shortStats = {
      allSwaps,
      passedVol,
      candidates: targetCoins.length,
      skippedCooldown: 0,
      candlesValid: 0,
      passed5mConditions: 0,
      called15m: 0,
      passedDiffEMA10: 0,
      shortSentSuccess: 0
    };

    console.log(`--- QUÉT SHORT: BD5 > 4%, ATR > 1%, RSI < 65% & DIFFEMA10(15m) < -0.5% ---`);

    for (const coin of targetCoins) {
      const symbol = coin.instId;
      const coinName = escapeHtml(symbol.replace('-USDT-SWAP', ''));
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      // 1. Kiểm tra Cooldown
      const shortKey = `${symbol}_SHORT`;
      const lastSentShort = sentLog[shortKey] || 0;
      if (currentTime - lastSentShort < COOLDOWN_TIME_SHORT) {
        shortStats.skippedCooldown++;
        continue;
      }

      // 2. Lấy nến 5m
      const candles5m = await getCandles(symbol, '5m', 80);
      if (!candles5m || candles5m.length < 35) {
        await sleep(60);
        continue;
      }

      const closedCandles = candles5m.slice(1);
      if (closedCandles.length < 21) {
        await sleep(60);
        continue;
      }

      shortStats.candlesValid++;

      // 3. Tính BD5: Biến động giá mở cửa nến 0 so với nến 4
      const open0 = parseFloat(candles5m[0][1]);
      const open4 = parseFloat(candles5m[4][1]);
      let bd5 = 0;
      if (open4 > 0) {
        bd5 = ((open0 - open4) / open4) * 100;
      }

      // Điều kiện BD5 > 4%
      if (bd5 <= 4.0) {
        await sleep(60);
        continue;
      }

      // 4. Tính ATR (14, 5m) và kiểm tra ATR > 1%
      const chronological5m = [...closedCandles].reverse();
      const atrData = calculateATR(chronological5m, 14);
      const atrPct = atrData ? atrData.atrPct : 0;
      const atrVal = atrData ? atrData.atr : 0;

      if (atrPct <= 1.0) {
        await sleep(60);
        continue;
      }

      // 5. Tính RSI (20, 5m) và kiểm tra RSI < 65%
      const closes5m = chronological5m.map((c) => parseFloat(c[4]));
      const rsiSeries5m = calculateRSIArray(closes5m, 20);
      if (rsiSeries5m.length === 0) {
        await sleep(60);
        continue;
      }

      const currentRsi5m = rsiSeries5m[rsiSeries5m.length - 1];
      if (currentRsi5m >= 65.0) {
        await sleep(60);
        continue;
      }

      shortStats.passed5mConditions++;

      // 6. Lấy nến 15m để tính DiffEMA10 (EMA 20 trên nến 15m)
      shortStats.called15m++;
      const candles15m = await getCandles(symbol, '15m', 80);
      if (!candles15m || candles15m.length < 35) {
        await sleep(60);
        continue;
      }

      const closed15m = candles15m.slice(1);
      const chronological15m = [...closed15m].reverse();
      const closes15m = chronological15m.map((c) => parseFloat(c[4]));

      const emaArray15m = calculateEMA(closes15m, 20);
      let diffema10 = null;

      if (emaArray15m.length >= 10) {
        const ema1 = emaArray15m[emaArray15m.length - 1];
        const ema10 = emaArray15m[emaArray15m.length - 10];
        if (ema10 !== 0) {
          diffema10 = ((ema1 - ema10) / ema10) * 100;
        }
      }

      // Điều kiện DiffEMA10 < -0.5%
      if (diffema10 !== null && diffema10 < -0.5) {
        shortStats.passedDiffEMA10++;

        sentLog[shortKey] = currentTime;
        saveSentLog(sentLog);

        const bd5Str = `+${bd5.toFixed(2)}%`;
        const atrStr = `${atrVal.toFixed(4)} (~${atrPct.toFixed(2)}%)`;
        const rsiStr = `${currentRsi5m.toFixed(2)}%`;
        const diffema10Str = `${diffema10.toFixed(4)}%`;

        console.log(`[SHORT SIGNAL] ${symbol} | BD5: ${bd5Str} | ATR: ${atrStr} | RSI: ${rsiStr} | DiffEMA10: ${diffema10Str}`);

        const shortMsg =
          `<b>⚠️ TÍN HIỆU SHORT</b>\n` +
          `Coin: <b>${coinName}</b>\n` +
          `• BD5: <b>${bd5Str}</b>\n` +
          `• ATR: <b>${atrStr}</b>\n` +
          `• RSI (5m): <b>${rsiStr}</b>\n` +
          `• DiffEMA10 (15m): <b>${diffema10Str}</b>\n` +
          `<a href="${link}">🔗 Giao dịch OKX</a>`;

        const isSent = await sendTelegramMessage(shortMsg);
        if (isSent) {
          shortStats.shortSentSuccess++;
        }
      }

      await sleep(100);
    }

    // ------------------- BÁO CÁO THỐNG KÊ CHI TIẾT -------------------
    console.log('\n================ BÁO CÁO THỐNG KÊ CHI TIẾT ================');
    console.log(`1. Tổng cặp SWAP quét từ OKX                 : ${shortStats.allSwaps} coin`);
    console.log(`2. Số coin qua lọc Volume (> 5M USDT)        : ${shortStats.passedVol} coin`);
    console.log(`- Bị loại do Cooldown Short                  : ${shortStats.skippedCooldown} coin`);
    console.log(`- Nến 5m hợp lệ                              : ${shortStats.candlesValid} coin`);
    console.log(`- Thỏa BD5 > 4% & ATR > 1% & RSI < 65%       : ${shortStats.passed5mConditions} coin`);
    console.log(`- Gọi nến 15m kiểm tra                       : ${shortStats.called15m} coin`);
    console.log(`- Thỏa mãn DiffEMA10 (15m) < -0.5%           : ${shortStats.passedDiffEMA10} coin`);
    console.log(`- Gửi tin SHORT thành công                   : ${shortStats.shortSentSuccess} tin`);
    console.log('===========================================================\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
