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
      // Cập nhật timestamp và giá trị x (nếu có x lớn hơn hoặc ghi mới)
      if (!existing || typeof existing !== 'object' || item.x > (existing.x || 0)) {
        list24h[item.symbol] = {
          timestamp: now,
          x: item.x,
          bd5: item.bd5,
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
    // PHẦN 1: QUÉT THỊ TRƯỜNG -> LƯU 24H.JSON (x > 4) & XÉT LỆNH SHORT
    // ==================================================================
    console.log('--- ĐANG QUÉT THỊ TRƯỜNG (LƯU 24H & LUỒNG SHORT) ---');
    const { allSwaps, passedVol, targetCoins } = await getFilteredMarkets();

    const shortStats = {
      allSwaps,
      passedVol,
      candidates: targetCoins.length,
      candlesValid: 0,
      passedBD5: 0,
      savedTo24h: 0,
      passedPreShort: 0,
      called15m: 0,
      passedDiffEMA10: 0,
      shortSentSuccess: 0
    };

    const new24hItems = [];

    for (const coin of targetCoins) {
      const symbol = coin.instId;
      const coinName = escapeHtml(symbol.replace('-USDT-SWAP', ''));
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

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

      // 1. TÍNH BD5 (Từ Open nến 0 đến Open nến 4)
      const open0 = parseFloat(candles5m[0][1]);
      const open4 = parseFloat(candles5m[4][1]);
      let bd5 = 0;
      if (open4 > 0) {
        bd5 = ((open0 - open4) / open4) * 100;
      }

      // Lọc bd5 > 2.5%
      if (bd5 <= 2.5) {
        await sleep(60);
        continue;
      }
      shortStats.passedBD5++;

      const chronological5m = [...closedCandles].reverse();
      const closes5m = chronological5m.map((c) => parseFloat(c[4]));

      // 2. TÍNH ATR 5M & TỈ SỐ x = bd5 / atr
      const atrData = calculateATR(chronological5m, 14);
      const atrPct = atrData ? atrData.atrPct : 0;
      const x = atrPct > 0 ? (bd5 / atrPct) : 0;

      // NẾU x > 4 -> LƯU VÀO FILE 24h.json
      if (x > 4.0) {
        new24hItems.push({
          symbol,
          x: parseFloat(x.toFixed(2)),
          bd5: parseFloat(bd5.toFixed(2)),
          atrPct: parseFloat(atrPct.toFixed(2))
        });
        shortStats.savedTo24h++;
      }

      // 3. KIỂM TRA ĐIỀU KIỆN SHORT: bd5 > 4%, ATR > 1%, RSI < 65%
      const rsiSeries5m = calculateRSIArray(closes5m, 20);
      const currentRsi5m = rsiSeries5m.length > 0 ? rsiSeries5m[rsiSeries5m.length - 1] : 100;

      if (bd5 > 4.0 && atrPct > 1.0 && currentRsi5m < 65.0) {
        shortStats.passedPreShort++;

        const shortKey = `${symbol}_SHORT`;
        const lastSentShort = sentLog[shortKey] || 0;
        const isInShortCooldown = (currentTime - lastSentShort) < COOLDOWN_TIME_SHORT;

        if (!isInShortCooldown) {
          shortStats.called15m++;
          // GỌI NẾN 15M ĐỂ TÍNH diffema10
          const candles15m = await getCandles(symbol, '15m', 80);
          if (candles15m && candles15m.length >= 35) {
            const closed15m = candles15m.slice(1);
            const chronological15m = [...closed15m].reverse();
            const closes15m = chronological15m.map((c) => parseFloat(c[4]));

            // EMA 20 trên khung 15m
            const emaArray15m = calculateEMA(closes15m, 20);
            let diffema10 = null;

            if (emaArray15m.length >= 10) {
              const ema1 = emaArray15m[emaArray15m.length - 1];
              const ema10 = emaArray15m[emaArray15m.length - 10];
              if (ema10 !== 0) {
                diffema10 = ((ema1 - ema10) / ema10) * 100;
              }
            }

            // ĐIỀU KIỆN SHORT: diffema10 < -1%
            if (diffema10 !== null && diffema10 < -1.0) {
              shortStats.passedDiffEMA10++;

              sentLog[shortKey] = currentTime;
              saveSentLog(sentLog);

              const bd5Str = `+${bd5.toFixed(2)}`;
              const atrText = `${atrData.atr.toFixed(4)} (~${atrPct.toFixed(2)}%)`;
              const rsiStr = currentRsi5m.toFixed(2);
              const diffema10Str = diffema10.toFixed(4);

              console.log(`[SHORT SIGNAL] ${symbol} | BD5: ${bd5Str}% | ATR%: ${atrPct.toFixed(2)}% | RSI: ${rsiStr}% | DiffEMA10 (15m): ${diffema10Str}%`);

              const shortMsg =
                `<b>⚠️ TÍN HIỆU SHORT</b>\n` +
                `Coin: <b>${coinName}</b> (15m/5m)\n` +
                `Chiến lược: <b>BD5 &gt; 4% &amp; ATR &gt; 1% &amp; RSI &lt; 65% &amp; DiffEMA10 (15m) &lt; -1%</b>\n` +
                `BD5 (5m): <b>${bd5Str}%</b>\n` +
                `ATR (14, 5m): <b>${atrText}</b>\n` +
                `RSI (20, 5m): <b>${rsiStr}%</b>\n` +
                `DiffEMA10 (15m): <b>${diffema10Str}%</b>\n` +
                `<a href="${link}">🔗 Giao dịch OKX</a>`;

              const isSent = await sendTelegramMessage(shortMsg);
              if (isSent) {
                shortStats.shortSentSuccess++;
              }
            }
          }
        }
      }

      await sleep(100);
    }

    // Cập nhật và lưu vào file 24h.json
    list24h = updateAndSave24hList(list24h, new24hItems);

    // ==================================================================
    // PHẦN 2: LUỒNG LONG (CHỈ XÉT CÁC COIN TRONG FILE 24H.JSON)
    // ==================================================================
    console.log('--- ĐANG QUÉT LUỒNG LONG (CHỈ XÉT COIN TRONG 24H.JSON) ---');
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

      // Nến đã đóng cửa: index 1 là nến 1 vừa đóng, index 2 là nến 2
      const closedCandles = candles5m.slice(1);
      if (closedCandles.length < 22) {
        await sleep(60);
        continue;
      }

      longStats.candlesValid++;

      // 1. TÍNH BBM: Độ lệch đáy nến 1 so với BB Mid (20, 2)
      // Sử dụng 20 nến tính từ nến 1 lùi về trước
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

      // 2. KIỂM TRA NẾN 1 LÀ NẾN XANH (Close > Open)
      const open1 = parseFloat(closedCandles[0][1]);
      const close1 = parseFloat(closedCandles[0][4]);
      const isCandle1Green = close1 > open1;

      if (!isCandle1Green) {
        await sleep(60);
        continue;
      }
      longStats.passedCandle1Green++;

      // GỬI CẢNH BÁO LONG
      const longKey = `${symbol}_LONG`;
      sentLog[longKey] = currentTime;
      saveSentLog(sentLog);

      const bbmSign = bbm >= 0 ? `+${bbm.toFixed(2)}` : bbm.toFixed(2);
      console.log(`[LONG SIGNAL] ${symbol} | BBM: ${bbmSign}% | Nến 1 Xanh (O: ${open1}, C: ${close1})`);

      const longMsg =
        `<b>🚀 TÍN HIỆU LONG</b>\n` +
        `Coin: <b>${coinName}</b> (5m)\n` +
        `Chiến lược: <b>Coin từ 24h.json &amp; BBM &lt; 0.5% &amp; Nến 1 Xanh</b>\n` +
        `BBM (5m): <b>${bbmSign}%</b> (Ngưỡng &lt; 0.5%)\n` +
        `Nến 1: <b>Xanh</b> (Open: ${open1} | Close: ${close1})\n` +
        `<a href="${link}">🔗 Giao dịch OKX</a>`;

      const isLongSent = await sendTelegramMessage(longMsg);
      if (isLongSent) {
        longStats.longSentSuccess++;
      }

      await sleep(100);
    }

    // ------------------- BÁO CÁO THỐNG KÊ -------------------
    console.log('\n================ BÁO CÁO THỐNG KÊ CHI TIẾT TỪNG BƯỚC ================');
    console.log(`1. Tổng cặp SWAP quét được từ OKX           : ${shortStats.allSwaps} coin`);
    console.log(`2. Số coin qua lọc Volume (> 5M USDT)        : ${shortStats.passedVol} coin`);
    console.log('------------------------------------------------------------------');
    console.log('--- LUỒNG 24H.JSON & SHORT ---');
    console.log(`- Tải nến 5m hợp lệ                          : ${shortStats.candlesValid} coin`);
    console.log(`- Thỏa mãn BD5 > 2.5%                        : ${shortStats.passedBD5} coin`);
    console.log(`- Thỏa x = BD5/ATR > 4 (Lưu vào 24h.json)    : ${shortStats.savedTo24h} coin`);
    console.log(`- Thỏa BD5 > 4% & ATR > 1% & RSI < 65%       : ${shortStats.passedPreShort} coin`);
    console.log(`- Gọi nến 15m kiểm tra                       : ${shortStats.called15m} coin`);
    console.log(`- Thỏa mãn DiffEMA10 (15m) < -1%             : ${shortStats.passedDiffEMA10} coin`);
    console.log(`- Gửi tin SHORT thành công                   : ${shortStats.shortSentSuccess} tin`);
    console.log('------------------------------------------------------------------');
    console.log('--- LUỒNG LONG (TỪ 24H.JSON) ---');
    console.log(`- Tổng số coin trong file 24h.json           : ${longStats.totalIn24hList} coin`);
    console.log(`- Bị loại do đang Cooldown Long              : ${longStats.skippedCooldown} coin`);
    console.log(`- Còn lại đi tiếp vào kiểm tra               : ${longStats.candidatesAfterCooldown} coin`);
    console.log(`- Thỏa mãn BBM < 0.5%                        : ${longStats.passedBBM} coin`);
    console.log(`- Thỏa nến 1 là nến xanh                     : ${longStats.passedCandle1Green} coin`);
    console.log(`- Gửi tin LONG thành công                    : ${longStats.longSentSuccess} tin`);
    console.log('==================================================================\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
