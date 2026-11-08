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
const COOLDOWN_TIME = 1 * 60 * 60 * 1000; // Cooldown 1 giờ
const MIN_VOL_CCY24H = 5_000_000; // Volume 24h > 5 triệu USDT

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

function calculateBollingerBands(closes, period = 20, multiplier = 2) {
  if (!closes || closes.length < period) return null;

  const slice = closes.slice(-period);
  const sma = slice.reduce((acc, val) => acc + val, 0) / period;

  const variance = slice.reduce((acc, val) => acc + Math.pow(val - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = sma + (multiplier * stdDev);
  const lower = sma - (multiplier * stdDev);

  let hbb = 0;
  if (lower > 0) {
    hbb = ((upper - lower) / lower) * 100;
  }

  return { upper, lower, sma, hbb };
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
    console.log('=== BẮT ĐẦU QUÉT THỊ TRƯỜNG (LONG & SHORT) ===\n');

    const sentLog = loadSentLog();
    const currentTime = Date.now();

    const { allSwaps, passedVol, targetCoins } = await getFilteredMarkets();

    const stats = {
      allSwaps,
      passedVol,
      skippedCooldown: 0,
      candlesValid: 0,
      passedBD3: 0,
      passedATR: 0,
      passedRSI: 0,
      candles15mValid: 0,
      passedDiffEMA5Calc: 0,
      passedDiffEMA5Long: 0,
      passedDiffEMA5Short: 0,
      candles1hValid: 0,
      passedXYCalc: 0,
      passedXYLong: 0,  // Số coin thỏa mãn x < 3 || y < 3
      passedXYShort: 0, // Số coin thỏa mãn x > 3 && y > 3
      longSentSuccess: 0,
      shortSentSuccess: 0
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;
      const coinName = escapeHtml(symbol.replace('-USDT-SWAP', ''));
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      // 1. KIỂM TRA COOLDOWN ĐẦU TIÊN
      const longKey = `${symbol}_LONG`;
      const shortKey = `${symbol}_SHORT`;
      const lastSentLong = sentLog[longKey] || 0;
      const lastSentShort = sentLog[shortKey] || 0;

      const isLongCooling = (currentTime - lastSentLong < COOLDOWN_TIME);
      const isShortCooling = (currentTime - lastSentShort < COOLDOWN_TIME);

      if (isLongCooling && isShortCooling) {
        stats.skippedCooldown++;
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

      stats.candlesValid++;

      // 3. Tính bd3: % chênh lệch giá mở cửa nến vừa đóng [1] và giá mở cửa nến số 3 [3]
      const openJustClosed = parseFloat(candles5m[1][1]);
      const closeJustClosed = parseFloat(candles5m[1][4]);
      const open3CandlesAgo = parseFloat(candles5m[3][1]);

      let bd3 = 0;
      if (open3CandlesAgo > 0) {
        bd3 = ((openJustClosed - open3CandlesAgo) / open3CandlesAgo) * 100;
      }

      if (bd3 <= 2.5) {
        await sleep(60);
        continue;
      }
      stats.passedBD3++;

      // 4. Tính ATR (14, 5m) và kiểm tra ATR > 0.7%
      const chronological5m = [...closedCandles].reverse();
      const atrData = calculateATR(chronological5m, 14);
      const atrPct = atrData ? atrData.atrPct : 0;
      const atrVal = atrData ? atrData.atr : 0;

      if (atrPct <= 0.7) {
        await sleep(60);
        continue;
      }
      stats.passedATR++;

      // 5. Tính RSI (20, 5m) và kiểm tra RSI < 72%
      const closes5m = chronological5m.map((c) => parseFloat(c[4]));
      const rsiSeries5m = calculateRSIArray(closes5m, 20);
      if (rsiSeries5m.length === 0) {
        await sleep(60);
        continue;
      }

      const currentRsi5m = rsiSeries5m[rsiSeries5m.length - 1];
      if (currentRsi5m >= 72.0) {
        await sleep(60);
        continue;
      }
      stats.passedRSI++;

      // 6. Lấy nến 15m để tính DiffEMA5
      const candles15m = await getCandles(symbol, '15m', 80);
      if (!candles15m || candles15m.length < 45) {
        await sleep(60);
        continue;
      }
      stats.candles15mValid++;

      const closed15m = candles15m.slice(1);
      const chronological15m = [...closed15m].reverse();
      const closes15m = chronological15m.map((c) => parseFloat(c[4]));

      const emaArray15m = calculateEMA(closes15m, 20);
      let diffema5 = null;

      if (emaArray15m.length >= 6) {
        const ema1 = emaArray15m[emaArray15m.length - 1];
        const ema5 = emaArray15m[emaArray15m.length - 1 - 5];
        if (ema5 !== 0) {
          diffema5 = ((ema1 - ema5) / ema5) * 100;
        }
      }

      if (diffema5 === null) {
        await sleep(60);
        continue;
      }
      stats.passedDiffEMA5Calc++;

      const isDiffLong = diffema5 > -1.0 && diffema5 < 1.0;
      const isDiffShort = diffema5 < -1.0;

      if (isDiffLong) stats.passedDiffEMA5Long++;
      if (isDiffShort) stats.passedDiffEMA5Short++;

      if (!isDiffLong && !isDiffShort) {
        await sleep(60);
        continue;
      }

      // 7. Lấy nến 1h để tính Hbb và ATR 1h
      const candles1h = await getCandles(symbol, '1H', 50);
      if (!candles1h || candles1h.length < 20) {
        await sleep(60);
        continue;
      }
      stats.candles1hValid++;

      const chronological1h = [...candles1h].reverse();
      const closes1h = chronological1h.map((c) => parseFloat(c[4]));
      const bb1h = calculateBollingerBands(closes1h, 20, 2);

      // 8. Tính tỉ số x = Hbb(15m) / ATR(15m) & y = Hbb(1h) / ATR(1h)
      const bb15m = calculateBollingerBands(closes15m, 20, 2);
      const atrData15m = calculateATR(chronological15m, 14);

      let xVal = null;
      let xStr = 'N/A';
      if (bb15m && atrData15m && atrData15m.atrPct > 0) {
        xVal = bb15m.hbb / atrData15m.atrPct;
        xStr = xVal.toFixed(2);
      }

      const atrData1h = calculateATR(chronological1h, 14);
      let yVal = null;
      let yStr = 'N/A';
      if (bb1h && atrData1h && atrData1h.atrPct > 0) {
        yVal = bb1h.hbb / atrData1h.atrPct;
        yStr = yVal.toFixed(2);
      }

      if (xVal === null || yVal === null) {
        await sleep(60);
        continue;
      }
      stats.passedXYCalc++;

      // Kiểm tra điều kiện x, y cho từng nhánh
      const isXYLong = (xVal < 3 || yVal < 3);
      const isXYShort = (xVal > 3 && yVal > 3);

      if (isXYLong) stats.passedXYLong++;
      if (isXYShort) stats.passedXYShort++;

      // Chuỗi thông số hiển thị
      const bd3Str = `+${bd3.toFixed(2)}%`;
      const atrStr = `${atrVal.toFixed(4)} (~${atrPct.toFixed(2)}%)`;
      const rsiStr = `${currentRsi5m.toFixed(2)}%`;
      const diffema5Str = `${diffema5.toFixed(4)}%`;

      // ================== NHÁNH LONG ==================
      const isLongCondition = !isLongCooling && isDiffLong && isXYLong;

      if (isLongCondition) {
        sentLog[longKey] = currentTime;
        saveSentLog(sentLog);

        console.log(`[LONG SIGNAL] ${symbol} | BD3: ${bd3Str} | ATR: ${atrStr} | RSI: ${rsiStr} | DiffEMA5: ${diffema5Str} | x: ${xStr} | y: ${yStr}`);

        const longMsg =
          `<b>🟢 TÍN HIỆU LONG</b>\n` +
          `Coin: <b>${coinName}</b>\n` +
          `• BD3: <b>${bd3Str}</b>\n` +
          `• ATR (5m): <b>${atrStr}</b>\n` +
          `• RSI (5m): <b>${rsiStr}</b>\n` +
          `• DiffEMA5 (15m): <b>${diffema5Str}</b>\n` +
          `• Tỉ số x (Hbb/ATR 15m): <b>${xStr}</b>\n` +
          `• Tỉ số y (Hbb/ATR 1h): <b>${yStr}</b>\n` +
          `<a href="${link}">🔗 Giao dịch OKX</a>`;

        const isSentLong = await sendTelegramMessage(longMsg);
        if (isSentLong) stats.longSentSuccess++;
      }

      // ================== NHÁNH SHORT ==================
      const isRedCandle = closeJustClosed < openJustClosed;
      const isShortCondition = !isShortCooling && isDiffShort && isRedCandle && isXYShort;

      if (isShortCondition) {
        sentLog[shortKey] = currentTime;
        saveSentLog(sentLog);

        console.log(`[SHORT SIGNAL] ${symbol} | BD3: ${bd3Str} | ATR: ${atrStr} | RSI: ${rsiStr} | DiffEMA5: ${diffema5Str} | x: ${xStr} | y: ${yStr}`);

        const shortMsg =
          `<b>🔴 TÍN HIỆU SHORT</b>\n` +
          `Coin: <b>${coinName}</b>\n` +
          `• BD3: <b>${bd3Str}</b>\n` +
          `• ATR (5m): <b>${atrStr}</b>\n` +
          `• RSI (5m): <b>${rsiStr}</b>\n` +
          `• DiffEMA5 (15m): <b>${diffema5Str}</b>\n` +
          `• Tỉ số x (Hbb/ATR 15m): <b>${xStr}</b>\n` +
          `• Tỉ số y (Hbb/ATR 1h): <b>${yStr}</b>\n` +
          `<a href="${link}">🔗 Giao dịch OKX</a>`;

        const isSentShort = await sendTelegramMessage(shortMsg);
        if (isSentShort) stats.shortSentSuccess++;
      }

      await sleep(100);
    }

    // ------------------- BÁO CÁO THỐNG KÊ RÚT GỌN -------------------
    console.log('\n--- KẾT QUẢ QUÉT THỊ TRƯỜNG ---');
    console.log(`Tổng SWAP: ${stats.allSwaps}`);
    console.log(`Volume > 5M: ${stats.passedVol}`);
    console.log(`Bỏ qua do Cooldown: ${stats.skippedCooldown}`);
    console.log(`Nến 5m hợp lệ: ${stats.candlesValid}`);
    console.log(`BD3 > 2.5%: ${stats.passedBD3}`);
    console.log(`ATR > 0.7%: ${stats.passedATR}`);
    console.log(`RSI < 72%: ${stats.passedRSI}`);
    console.log(`Nến 15m hợp lệ: ${stats.candles15mValid}`);
    console.log(`DiffEMA5 hợp lệ: ${stats.passedDiffEMA5Calc}`);
    console.log(`- Thỏa Long (-1% < DiffEMA5 < 1%): ${stats.passedDiffEMA5Long}`);
    console.log(`- Thỏa Short (DiffEMA5 < -1%): ${stats.passedDiffEMA5Short}`);
    console.log(`Nến 1h hợp lệ: ${stats.candles1hValid}`);
    console.log(`Tính toán x, y hợp lệ: ${stats.passedXYCalc}`);
    console.log(`- Thỏa x, y Long (x < 3 hoặc y < 3): ${stats.passedXYLong}`);
    console.log(`- Thỏa x, y Short (x > 3 và y > 3): ${stats.passedXYShort}`);
    console.log(`Gửi Telegram LONG: ${stats.longSentSuccess}`);
    console.log(`Gửi Telegram SHORT: ${stats.shortSentSuccess}`);
    console.log('-------------------------------\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
