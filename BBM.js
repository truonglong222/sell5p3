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
const FILE_24H = path.join(__dirname, '24h.json');

// Cấu hình Cooldown & Ngưỡng lọc
const COOLDOWN_TIME_LONG = 48 * 60 * 60 * 1000;      // 48h cho Long
const COOLDOWN_TIME_SHORT = 8 * 60 * 60 * 1000;      // 8h cho Short
const CLEANUP_TIME_24H_FILE = 24 * 60 * 60 * 1000;   // Giữ coin trong 24h.json tối đa 24h
const MIN_VOL_CCY24H = 5_000_000;                    // Volume 24h > 5 triệu USDT
const MAX_BBM = 0.5;                                 // BBM < 0.5% cho Long

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

function load24hList() {
  try {
    if (fs.existsSync(FILE_24H)) {
      const data = fs.readFileSync(FILE_24H, 'utf8');
      return data.trim() ? JSON.parse(data) : {};
    }
  } catch (e) {}
  return {};
}

function updateAndSave24hList(list24h, newItems) {
  try {
    const now = Date.now();

    for (const item of newItems) {
      const existing = list24h[item.symbol];
      if (!existing || typeof existing !== 'object' || item.x > (existing.x || 0)) {
        list24h[item.symbol] = {
          timestamp: now,
          x: item.x,
          bd5: item.bd5,
          atr: item.atr,
          atrPct: item.atrPct
        };
      }
    }

    const cleaned24h = {};
    for (const [symbol, data] of Object.entries(list24h)) {
      const timestamp = typeof data === 'object' ? data.timestamp : data;
      if (now - timestamp < CLEANUP_TIME_24H_FILE) {
        cleaned24h[symbol] = data;
      }
    }

    fs.writeFileSync(FILE_24H, JSON.stringify(cleaned24h, null, 2), 'utf8');
    return cleaned24h;
  } catch (e) {
    console.error('Lỗi khi lưu 24h.json:', e.message);
    return list24h;
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
    console.log('=== BẮT ĐẦU QUÉT THỊ TRƯỜNG ===\n');

    const sentLog = loadSentLog();
    let list24h = load24hList();
    const currentTime = Date.now();

    // ==================================================================
    // BƯỚC 1: LUỒNG CHUNG - LỌC VOLUME -> LỌC BD5 > 2.5% -> TÍNH X -> LƯU 24H.JSON
    // ==================================================================
    console.log('--- 1. LUỒNG CHUNG: LỌC THỊ TRƯỜNG & TẠO WATCHLIST 24H.JSON ---');
    const { allSwaps, passedVol, targetCoins } = await getFilteredMarkets();

    const scanStats = {
      allSwaps,
      passedVol,
      candlesValid: 0,
      passedBD5_2_5: 0,
      savedTo24h: 0
    };

    const new24hItems = [];
    const market5mData = new Map();

    for (const coin of targetCoins) {
      const symbol = coin.instId;

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

      scanStats.candlesValid++;

      // Tính BD5: Biến động giá mở cửa nến 0 so với nến 4
      const open0 = parseFloat(candles5m[0][1]);
      const open4 = parseFloat(candles5m[4][1]);
      let bd5 = 0;
      if (open4 > 0) {
        bd5 = ((open0 - open4) / open4) * 100;
      }

      const chronological5m = [...closedCandles].reverse();
      const atrData = calculateATR(chronological5m, 14);
      const atrPct = atrData ? atrData.atrPct : 0;
      const atrVal = atrData ? atrData.atr : 0;
      const x = atrPct > 0 ? (bd5 / atrPct) : 0;

      // Lưu lại dữ liệu 5m vào bộ nhớ để luồng Short sử dụng trực tiếp
      market5mData.set(symbol, {
        bd5,
        x,
        atr: atrVal,
        atrPct,
        closedCandles,
        chronological5m
      });

      // LỌC BD5 > 2.5%
      if (bd5 > 2.5) {
        scanStats.passedBD5_2_5++;

        // NẾU x > 4 THÌ LƯU VÀO FILE 24h.json
        if (x > 4.0) {
          scanStats.savedTo24h++;
          new24hItems.push({
            symbol,
            x: parseFloat(x.toFixed(2)),
            bd5: parseFloat(bd5.toFixed(2)),
            atr: parseFloat(atrVal.toFixed(4)),
            atrPct: parseFloat(atrPct.toFixed(2))
          });
        }
      }

      await sleep(60);
    }

    // Cập nhật và lưu vào file 24h.json
    list24h = updateAndSave24hList(list24h, new24hItems);
    console.log(`=> Đã cập nhật ${new24hItems.length} coin mới thỏa x > 4 vào 24h.json. Tổng coin trong file: ${Object.keys(list24h).length}\n`);

    // ==================================================================
    // BƯỚC 2: LUỒNG LONG ĐỘC LẬP (CHỈ XÉT CÁC COIN TRONG FILE 24H.JSON)
    // ==================================================================
    console.log('--- 2. LUỒNG LONG: CHỈ XÉT CÁC COIN TRONG FILE 24H.JSON ---');
    const symbolsIn24h = Object.keys(list24h);

    const longStats = {
      totalIn24hList: symbolsIn24h.length,
      skippedCooldown: 0,
      candidatesAfterCooldown: 0,
      candlesValid: 0,
      passedBBM: 0,
      passedCandle1Green: 0,
      longSentSuccess: 0
    };

    const availableLongSymbols = symbolsIn24h.filter((symbol) => {
      const longKey = `${symbol}_LONG`;
      const lastSent = sentLog[longKey] || 0;
      const isInCooldown = (currentTime - lastSent) < COOLDOWN_TIME_LONG;
      if (isInCooldown) {
        longStats.skippedCooldown++;
        return false;
      }
      return true;
    });

    longStats.candidatesAfterCooldown = availableLongSymbols.length;

    for (const symbol of availableLongSymbols) {
      const coinName = escapeHtml(symbol.replace('-USDT-SWAP', ''));
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      const candles5m = await getCandles(symbol, '5m', 60);
      if (!candles5m || candles5m.length < 30) {
        await sleep(60);
        continue;
      }

      const closedCandles = candles5m.slice(1);
      if (closedCandles.length < 21) {
        await sleep(60);
        continue;
      }

      longStats.candlesValid++;

      // 1. Tính BBM: ((Low nến 1 - BB Mid) / BB Mid) * 100
      const closesBB = closedCandles.slice(0, 20).map((c) => parseFloat(c[4])).reverse();
      const bb = calculateBollingerBands(closesBB, 20, 2);

      const low1 = parseFloat(closedCandles[0][3]);
      let bbm = 999;
      if (bb && bb.mid > 0) {
        bbm = ((low1 - bb.mid) / bb.mid) * 100;
      }

      // Điều kiện BBM < 0.5%
      if (bbm >= MAX_BBM) {
        await sleep(60);
        continue;
      }
      longStats.passedBBM++;

      // 2. Điều kiện Nến 1 là nến xanh (Close > Open)
      const open1 = parseFloat(closedCandles[0][1]);
      const close1 = parseFloat(closedCandles[0][4]);
      const isCandle1Green = close1 > open1;

      if (!isCandle1Green) {
        await sleep(60);
        continue;
      }
      longStats.passedCandle1Green++;

      // THỎA MÃN TÍN HIỆU LONG -> GỬI TIN NHẮN
      const longKey = `${symbol}_LONG`;
      sentLog[longKey] = currentTime;
      saveSentLog(sentLog);

      // Lấy thông số x, bd5, atr đã lưu từ 24h.json
      const coinData24h = list24h[symbol] || {};
      const xDisplay = coinData24h.x !== undefined ? coinData24h.x.toFixed(2) : 'N/A';
      const bd5Display = coinData24h.bd5 !== undefined ? `+${coinData24h.bd5.toFixed(2)}%` : 'N/A';
      const atrDisplay = coinData24h.atr !== undefined 
        ? `${coinData24h.atr} (~${coinData24h.atrPct}%)` 
        : (coinData24h.atrPct ? `${coinData24h.atrPct}%` : 'N/A');

      console.log(`[LONG SIGNAL] ${symbol} | x: ${xDisplay} | BD5: ${bd5Display} | ATR: ${atrDisplay}`);

      // TIN NHẮN TELEGRAM LONG: GỒM X, BD5, ATR VÀ LINK
      const longMsg =
        `<b>🚀 TÍN HIỆU LONG</b>\n` +
        `Coin: <b>${coinName}</b>\n` +
        `• Tỉ số x: <b>${xDisplay}</b>\n` +
        `• BD5: <b>${bd5Display}</b>\n` +
        `• ATR: <b>${atrDisplay}</b>\n` +
        `<a href="${link}">🔗 Giao dịch OKX</a>`;

      const isLongSent = await sendTelegramMessage(longMsg);
      if (isLongSent) {
        longStats.longSentSuccess++;
      }

      await sleep(100);
    }

    // ==================================================================
    // BƯỚC 3: LUỒNG SHORT ĐỘC LẬP
    // ==================================================================
    console.log('--- 3. LUỒNG SHORT: BD5 > 4%, ATR > 1%, RSI < 65% & DIFFEMA10(15m) < -1% ---');

    const shortStats = {
      candidates: targetCoins.length,
      skippedCooldown: 0,
      passed5mConditions: 0,
      called15m: 0,
      passedDiffEMA10: 0,
      shortSentSuccess: 0
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;
      const coinName = escapeHtml(symbol.replace('-USDT-SWAP', ''));
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      const shortKey = `${symbol}_SHORT`;
      const lastSentShort = sentLog[shortKey] || 0;
      const isInShortCooldown = (currentTime - lastSentShort) < COOLDOWN_TIME_SHORT;

      if (isInShortCooldown) {
        shortStats.skippedCooldown++;
        continue;
      }

      const cached = market5mData.get(symbol);
      if (!cached) continue;

      const { bd5, x, atr, atrPct, chronological5m } = cached;

      // 1. Kiểm tra BD5 > 4% và ATR > 1%
      if (bd5 <= 4.0 || atrPct <= 1.0) {
        continue;
      }

      // 2. Tính RSI (20, 5m) và kiểm tra RSI < 65%
      const closes5m = chronological5m.map((c) => parseFloat(c[4]));
      const rsiSeries5m = calculateRSIArray(closes5m, 20);
      if (rsiSeries5m.length === 0) continue;

      const currentRsi5m = rsiSeries5m[rsiSeries5m.length - 1];
      if (currentRsi5m >= 65.0) {
        continue;
      }

      shortStats.passed5mConditions++;

      // 3. Gọi nến 15m để tính diffema10
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

      // 4. Kiểm tra diffema10 < -1%
      if (diffema10 !== null && diffema10 < -1.0) {
        shortStats.passedDiffEMA10++;

        sentLog[shortKey] = currentTime;
        saveSentLog(sentLog);

        const xStr = x.toFixed(2);
        const bd5Str = `+${bd5.toFixed(2)}%`;
        const atrStr = `${atr.toFixed(4)} (~${atrPct.toFixed(2)}%)`;
        const rsiStr = `${currentRsi5m.toFixed(2)}%`;
        const diffema10Str = `${diffema10.toFixed(4)}%`;

        console.log(`[SHORT SIGNAL] ${symbol} | x: ${xStr} | BD5: ${bd5Str} | ATR: ${atrStr} | RSI: ${rsiStr} | DiffEMA10: ${diffema10Str}`);

        // TIN NHẮN TELEGRAM SHORT: GỒM X, BD5, ATR, RSI, DIFFEMA10 VÀ LINK
        const shortMsg =
          `<b>⚠️ TÍN HIỆU SHORT</b>\n` +
          `Coin: <b>${coinName}</b>\n` +
          `• Tỉ số x: <b>${xStr}</b>\n` +
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
    console.log(`1. Tổng cặp SWAP quét từ OKX                : ${scanStats.allSwaps} coin`);
    console.log(`2. Số coin qua lọc Volume (> 5M USDT)       : ${scanStats.passedVol} coin`);
    console.log('-----------------------------------------------------------');
    console.log('--- LUỒNG CHUNG & WATCHLIST 24H ---');
    console.log(`- Tải nến 5m hợp lệ                         : ${scanStats.candlesValid} coin`);
    console.log(`- Thỏa mãn BD5 > 2.5%                       : ${scanStats.passedBD5_2_5} coin`);
    console.log(`- Thỏa mãn x = BD5/ATR > 4 (Lưu 24h.json)   : ${scanStats.savedTo24h} coin`);
    console.log('-----------------------------------------------------------');
    console.log('--- LUỒNG LONG (CHỈ TỪ 24H.JSON) ---');
    console.log(`- Tổng số coin trong file 24h.json          : ${longStats.totalIn24hList} coin`);
    console.log(`- Bị loại do Cooldown Long                  : ${longStats.skippedCooldown} coin`);
    console.log(`- Đi tiếp vào kiểm tra                      : ${longStats.candidatesAfterCooldown} coin`);
    console.log(`- Thỏa mãn BBM < 0.5%                       : ${longStats.passedBBM} coin`);
    console.log(`- Thỏa mãn Nến 1 Xanh                       : ${longStats.passedCandle1Green} coin`);
    console.log(`- Gửi tin LONG thành công                   : ${longStats.longSentSuccess} tin`);
    console.log('-----------------------------------------------------------');
    console.log('--- LUỒNG SHORT ---');
    console.log(`- Bị loại do Cooldown Short                 : ${shortStats.skippedCooldown} coin`);
    console.log(`- Thỏa BD5 > 4% & ATR > 1% & RSI < 65%      : ${shortStats.passed5mConditions} coin`);
    console.log(`- Gọi nến 15m kiểm tra                      : ${shortStats.called15m} coin`);
    console.log(`- Thỏa mãn DiffEMA10 (15m) < -1%            : ${shortStats.passedDiffEMA10} coin`);
    console.log(`- Gửi tin SHORT thành công                  : ${shortStats.shortSentSuccess} tin`);
    console.log('===========================================================\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
