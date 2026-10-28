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
const COOLDOWN_TIME_SHORT = 8 * 60 * 60 * 1000;     // 24h cho Short
const CLEANUP_TIME_24H_FILE = 6 * 60 * 60 * 1000;    // Xóa coin trong 24h.json sau 6h
const MIN_VOL_CCY24H = 5_000_000;                    // Volume 24h > 5 triệu USDT
const MAX_BBD = 0.5;                                 // BBD < 0.5% cho Long

// Ngưỡng tối thiểu nến 1H để warm-up chuẩn theo sàn OKX (dùng cho luồng Long)
const MIN_CANDLES_1H_WARMUP = 90;

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

function updateAndSave24hList(list24h, newRsiItems) {
  try {
    const now = Date.now();
    
    for (const item of newRsiItems) {
      const existing = list24h[item.symbol];

      if (!existing || typeof existing !== 'object' || existing.rsi === undefined || item.rsi > existing.rsi) {
        list24h[item.symbol] = {
          timestamp: now,
          rsi: item.rsi
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
    // PHẦN 1: QUÉT THỊ TRƯỜNG -> SHORT & WATCHLIST 24H
    // ==================================================================
    console.log('--- ĐANG QUÉT LUỒNG SHORT & WATCHLIST 24H ---');
    const { allSwaps, passedVol, targetCoins } = await getFilteredMarkets();

    const shortStats = {
      allSwaps,
      passedVol,
      skippedCooldown: 0,
      candidatesAfterCooldown: 0,
      candlesValid: 0,
      passedBD5: 0,
      newRsi75Detected: 0,
      passedPreShortCondition: 0,
      passedATR1Pct: 0,
      passedRatioX: 0,
      passedDiffEMA10: 0,
      shortSentSuccess: 0
    };

    const eligibleCoins = targetCoins.filter((coin) => {
      const shortKey = `${coin.instId}_SHORT`;
      const lastSentShort = sentLog[shortKey] || 0;
      const isInShortCooldown = (currentTime - lastSentShort) < COOLDOWN_TIME_SHORT;

      if (isInShortCooldown) {
        shortStats.skippedCooldown++;
        return false;
      }
      return true;
    });

    shortStats.candidatesAfterCooldown = eligibleCoins.length;
    const newRsiSymbols = [];

    for (const coin of eligibleCoins) {
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

      // 1. TÍNH BD5: TỪ GIÁ MỞ CỬA NẾN 0 ĐẾN GIÁ MỞ CỬA NẾN 4
      const open0 = parseFloat(candles5m[0][1]);
      const open4 = parseFloat(candles5m[4][1]);
      let bd5 = 0;
      if (open4 > 0) {
        bd5 = ((open0 - open4) / open4) * 100;
      }

      // ĐIỀU KIỆN BD5 > 2.5%
      if (bd5 <= 2.5) {
        await sleep(60);
        continue;
      }
      shortStats.passedBD5++;

      // 2. TÍNH TOÁN RSI 5M
      const chronological5m = [...closedCandles].reverse();
      const closes5m = chronological5m.map((c) => parseFloat(c[4]));

      const rsiSeries5m = calculateRSIArray(closes5m, 20);
      if (rsiSeries5m.length < 10) {
        await sleep(60);
        continue;
      }

      const currentRsi5m = rsiSeries5m[rsiSeries5m.length - 1];
      const rsiStr = currentRsi5m.toFixed(2);

      // Lưu watchlist 24h nếu RSI > 75
      if (currentRsi5m > 75) {
        newRsiSymbols.push({
          symbol,
          rsi: parseFloat(rsiStr)
        });
        shortStats.newRsi75Detected++;
      } 
      
      // ĐIỀU KIỆN SHORT: BD5 > 2.5% (đã lọc ở trên) VÀ RSI < 60%
      if (currentRsi5m < 60) {
        shortStats.passedPreShortCondition++;

        // TÍNH TOÁN ATR% (14, 5m) VÀ KIỂM TRA ĐIỀU KIỆN ATR% > 1%
        const atrData = calculateATR(chronological5m, 14);
        const atrPct = atrData ? atrData.atrPct : 0;

        if (atrPct > 1.0) {
          shortStats.passedATR1Pct++;

          // TÍNH TỈ SỐ x = BD5 / ATR% VÀ KIỂM TRA ĐIỀU KIỆN x > 1.2
          const x = bd5 / atrPct;

          if (x > 1.2) {
            shortStats.passedRatioX++;

            // TÍNH DIFFEMA10 CỦA NẾN 5M (Dùng EMA20)
            const emaArray5m = calculateEMA(closes5m, 20);
            let diffema10 = null;

            if (emaArray5m.length >= 10) {
              const ema1Val = emaArray5m[emaArray5m.length - 1];
              const ema10Val = emaArray5m[emaArray5m.length - 10];
              if (ema10Val !== 0) {
                diffema10 = ((ema1Val - ema10Val) / ema10Val) * 100;
              }
            }

            // ĐIỀU KIỆN SHORT: diffema10 < -1%
            if (diffema10 !== null && diffema10 < -1.0) {
              shortStats.passedDiffEMA10++;

              const shortKey = `${symbol}_SHORT`;
              sentLog[shortKey] = currentTime;
              saveSentLog(sentLog);

              const bd5Str = `+${bd5.toFixed(2)}`;
              const atrText = `${atrData.atr.toFixed(4)} (~${atrData.atrPct.toFixed(2)}%)`;
              const xStr = x.toFixed(2);
              const diffema10Str = diffema10.toFixed(4);

              console.log(`[SHORT SIGNAL] ${symbol} | BD5: ${bd5Str}% | RSI: ${rsiStr}% | ATR%: ${atrPct.toFixed(2)}% | Tỉ số x: ${xStr} | DiffEMA10: ${diffema10Str}%`);

              const shortMsg =
                `<b>⚠️ TÍN HIỆU SHORT</b>\n` +
                `Coin: <b>${coinName}</b> (5m)\n` +
                `Chiến lược: <b>BD5 &gt; 2.5% &amp; RSI &lt; 60% &amp; ATR &gt; 1% &amp; x &gt; 1.2 &amp; DiffEMA10 &lt; -1%</b>\n` +
                `Tỉ số x (BD5/ATR): <b>${xStr}</b>\n` +
                `BD5 (5m): <b>${bd5Str}%</b>\n` +
                `RSI (5m): <b>${rsiStr}%</b>\n` +
                `ATR (14, 5m): <b>${atrText}</b>\n` +
                `DiffEMA10 (5m): <b>${diffema10Str}%</b>\n` +
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

    // Cập nhật lại 24h.json (chỉ đè nếu RSI mới > RSI cũ)
    list24h = updateAndSave24hList(list24h, newRsiSymbols);

    // ==================================================================
    // PHẦN 2: LUỒNG LONG ĐỘC LẬP (RSI 24h > 80 VÀ ATR > 1%)
    // ==================================================================
    console.log('--- ĐANG QUÉT LUỒNG LONG ĐỘC LẬP (TỪ 24H.JSON) ---');
    const symbolsIn24h = Object.keys(list24h);

    const longStats = {
      totalIn24hList: symbolsIn24h.length,
      skippedCooldown: 0,
      candidatesAfterCooldown: 0,
      passedRsi80: 0,
      candlesValid: 0,
      passedATR1Pct: 0,
      passedCandlePattern: 0,
      passedBBD: 0,
      called1H: 0,
      success1H: 0,
      passedDiffEMA16: 0,
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

      const record24h = list24h[symbol];
      const rsi24hVal = (typeof record24h === 'object' && record24h.rsi !== undefined) 
        ? record24h.rsi 
        : (typeof record24h === 'number' ? record24h : 0);

      // ĐIỀU KIỆN LONG: RSI trong 24h.json > 80
      if (rsi24hVal <= 80) {
        continue;
      }
      longStats.passedRsi80++;

      const savedRsi = `${rsi24hVal}%`;

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

      longStats.candlesValid++;

      const chronological5m = [...closedCandles].reverse();
      const atrData = calculateATR(chronological5m, 14);

      // ĐIỀU KIỆN LONG: ATR(%) > 1%
      if (!atrData || atrData.atrPct <= 1.0) {
        await sleep(60);
        continue;
      }
      longStats.passedATR1Pct++;

      const open1 = parseFloat(closedCandles[0][1]);
      const close1 = parseFloat(closedCandles[0][4]);

      const open2 = parseFloat(closedCandles[1][1]);
      const low2 = parseFloat(closedCandles[1][3]);
      const close2 = parseFloat(closedCandles[1][4]);

      const isCandle1Green = close1 > open1;
      const isCandle2Red = close2 < open2;

      if (!isCandle1Green || !isCandle2Red) {
        await sleep(60);
        continue;
      }
      longStats.passedCandlePattern++;

      // Tính Bollinger Bands 20, 2
      const closesBB1 = closedCandles.slice(0, 20).map((c) => parseFloat(c[4])).reverse();
      const bb1 = calculateBollingerBands(closesBB1, 20, 2);

      let conditionPassedBBD = false;
      let bbd = 0;

      if (bb1 && bb1.lower > 0) {
        bbd = ((low2 - bb1.lower) / bb1.lower) * 100;
        if (bbd < MAX_BBD) {
          conditionPassedBBD = true;
        }
      }

      if (!conditionPassedBBD) {
        await sleep(60);
        continue;
      }
      longStats.passedBBD++;

      longStats.called1H++;
      const candles1H = await getCandles(symbol, '1H', 100);
      let diffema16Pct = -999;

      if (candles1H && candles1H.length >= MIN_CANDLES_1H_WARMUP) {
        longStats.success1H++;
        const closed1H = candles1H.slice(1);
        const chronological1H = [...closed1H].reverse();
        const closes1H = chronological1H.map((c) => parseFloat(c[4]));

        const emaArray1H = calculateEMA(closes1H, 20);
        if (emaArray1H.length >= 16) {
          const ema1Val = emaArray1H[emaArray1H.length - 1];
          const ema16Val = emaArray1H[emaArray1H.length - 16];
          diffema16Pct = ((ema1Val - ema16Val) / ema16Val) * 100;
        }
      }

      // ĐIỀU KIỆN LONG: diffema16Pct > -1.0%
      if (diffema16Pct > -1.0) {
        longStats.passedDiffEMA16++;

        const longKey = `${symbol}_LONG`;
        sentLog[longKey] = currentTime;
        saveSentLog(sentLog);

        const atrText = `${atrData.atr.toFixed(4)} (~${atrData.atrPct.toFixed(2)}%)`;
        const bbdSign = bbd >= 0 ? `+${bbd.toFixed(2)}` : bbd.toFixed(2);
        const diffEmaSign = diffema16Pct > 0 ? `+${diffema16Pct.toFixed(4)}` : diffema16Pct.toFixed(4);
        
        console.log(`[LONG SIGNAL] ${symbol} | RSI 24h: ${savedRsi} | ATR%: ${atrData.atrPct.toFixed(2)}%`);

        const longMsg =
          `<b>🚀 TÍN HIỆU LONG</b>\n` +
          `Coin: <b>${coinName}</b> (5m/1H)\n` +
          `RSI (24h Watchlist > 80): <b>${savedRsi}</b>\n` +
          `ATR (14, 5m > 1%): <b>${atrText}</b>\n` +
          `Pattern: <b>Nến 1 Xanh | Nến 2 Đỏ</b>\n` +
          `BBD (5m): ${bbdSign}%\n` +
          `DiffEMA16 (1H): ${diffEmaSign}%\n` +
          `<a href="${link}">🔗 Giao dịch OKX</a>`;

        const isLongSent = await sendTelegramMessage(longMsg);
        if (isLongSent) {
          longStats.longSentSuccess++;
        }
      }

      await sleep(100);
    }

    // ------------------- BÁO CÁO THỐNG KÊ -------------------
    console.log('\n================ BÁO CÁO THỐNG KÊ CHI TIẾT TỪNG BƯỚC ================');
    console.log(`1. Tổng số cặp SWAP quét được từ OKX         : ${shortStats.allSwaps} coin`);
    console.log(`2. Số coin qua lọc Volume (> 5M USDT)         : ${shortStats.passedVol} coin`);
    console.log('------------------------------------------------------------------');
    console.log('--- LUỒNG SHORT & WATCHLIST 24H ---');
    console.log(`- Bị loại ngay do đang Cooldown ở sent_ema    : ${shortStats.skippedCooldown} coin`);
    console.log(`- Còn lại đi tiếp vào bước tải nến            : ${shortStats.candidatesAfterCooldown} coin`);
    console.log(`- Tải đủ nến 5m hợp lệ                        : ${shortStats.candlesValid} coin`);
    console.log(`- Thỏa mãn BD5 > 2.5%                         : ${shortStats.passedBD5} coin`);
    console.log(`- Đạt RSI > 75% (lưu vào 24h.json)            : ${shortStats.newRsi75Detected} coin`);
    console.log(`- Khớp điều kiện BD5 > 2.5% & RSI < 60        : ${shortStats.passedPreShortCondition} coin`);
    console.log(`- Thỏa mãn ATR% (5m) > 1%                     : ${shortStats.passedATR1Pct} coin`);
    console.log(`- Khớp tỉ số x = BD5/ATR% > 1.2               : ${shortStats.passedRatioX} coin`);
    console.log(`- Thỏa mãn DiffEMA10 (5m) < -1%               : ${shortStats.passedDiffEMA10} coin`);
    console.log(`- Gửi tin SHORT thành công                    : ${shortStats.shortSentSuccess} tin`);
    console.log('------------------------------------------------------------------');
    console.log('--- LUỒNG LONG ĐỘC LẬP (TỪ 24H.JSON) ---');
    console.log(`- Tổng số coin lấy ra từ 24h.json             : ${longStats.totalIn24hList} coin`);
    console.log(`- Bị loại do đang Cooldown Long               : ${longStats.skippedCooldown} coin`);
    console.log(`- Còn lại đi tiếp                             : ${longStats.candidatesAfterCooldown} coin`);
    console.log(`- Thỏa mãn RSI trong 24h.json > 80            : ${longStats.passedRsi80} coin`);
    console.log(`- Tải đủ nến 5m hợp lệ                        : ${longStats.candlesValid} coin`);
    console.log(`- Thỏa mãn ATR(5m) > 1%                       : ${longStats.passedATR1Pct} coin`);
    console.log(`- Thỏa nến 1 Xanh & nến 2 Đỏ                  : ${longStats.passedCandlePattern} coin`);
    console.log(`- Thỏa mãn BBD < 0.5%                         : ${longStats.passedBBD} coin`);
    console.log(`- Gọi nến 1H thành công (>= ${MIN_CANDLES_1H_WARMUP} nến)            : ${longStats.success1H} coin`);
    console.log(`- Thỏa mãn DiffEMA16 (1H) > -1.0%             : ${longStats.passedDiffEMA16} coin`);
    console.log(`- Gửi tin LONG thành công                     : ${longStats.longSentSuccess} tin`);
    console.log('==================================================================\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
