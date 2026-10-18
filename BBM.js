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
const COOLDOWN_TIME_LONG = 24 * 60 * 60 * 1000;      // 24 giờ cho Long
const COOLDOWN_TIME_SHORT = 24 * 60 * 60 * 1000;     // 24 giờ cho Short
const CLEANUP_TIME_24H_FILE = 24 * 60 * 60 * 1000;  // Tự động xóa coin trong 24h.json sau 24 giờ
const MIN_VOL_CCY24H = 5_000_000;                   // Volume 24h > 5 triệu USDT
const MIN_BD5 = 2;                                  // Biến động 5 nến gần nhất > 2% (Cho Short)
const MAX_BBM = 0.5;                                // BBM < 0.5% cho Long

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------- HÀM TIỆN ÍCH TRÁNH LỖI HTML TELEGRAM -------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '')
    .replace(/>/g, '');
}

// ------------------- QUẢN LÝ DỮ LIỆU FILE -------------------

function loadSentLog() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return data.trim() ? JSON.parse(data) : {};
    }
  } catch (e) {}
  return {};
}

function saveSentLog(logData) {
  try {
    const now = Date.now();
    const cleanedLog = {};
    for (const [key, timestamp] of Object.entries(logData)) {
      if (now - timestamp < COOLDOWN_TIME_LONG) {
        cleanedLog[key] = timestamp;
      }
    }
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

function updateAndSave24hList(list24h, newRsiSymbols) {
  try {
    const now = Date.now();
    
    for (const symbol of newRsiSymbols) {
      list24h[symbol] = now;
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
    console.log('=== BẮT ĐẦU QUÉT THỊ TRƯỜNG (5m) ===\n');

    const sentLog = loadSentLog();
    let list24h = load24hList();
    const currentTime = Date.now();

    const { allSwaps, passedVol, targetCoins } = await getFilteredMarkets();

    const stats = {
      allSwaps,
      passedVol,
      candlesValid: 0,
      
      newRsi70Detected: 0,
      totalIn24hList: 0,

      shortPassedBasic: 0,
      shortCalled1H: 0,
      shortSuccess1H: 0,
      shortPassedDiffEMA10: 0,
      shortSentSuccess: 0,

      longIn24hList: 0,
      longPassedBBM: 0,
      longCalled1H: 0,
      longSuccess1H: 0,
      longPassedDiffEMA10: 0,
      longSavedSuccess: 0,
      longSentSuccess: 0
    };

    const newRsiSymbols = [];

    for (const coin of targetCoins) {
      const symbol = coin.instId;
      const coinName = escapeHtml(symbol.replace('-USDT-SWAP', ''));
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      // Lấy nến 5m
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

      const chronological5m = [...closedCandles].reverse();
      const closes5m = chronological5m.map((c) => parseFloat(c[4]));

      const rsiSeries5m = calculateRSIArray(closes5m, 20);
      if (rsiSeries5m.length < 10) {
        await sleep(60);
        continue;
      }

      const currentRsi5m = rsiSeries5m[rsiSeries5m.length - 1];
      const rsiStr = currentRsi5m.toFixed(2);

      const close0 = parseFloat(closedCandles[0][4]);
      const open4 = parseFloat(closedCandles[4][1]);
      let bd5 = 0;
      if (open4 > 0) {
        bd5 = ((close0 - open4) / open4) * 100;
      }
      const bd5Str = `+${bd5.toFixed(2)}`;

      // --- 1. XỬ LÝ SHORT ---
      if (currentRsi5m > 70) {
        newRsiSymbols.push(symbol);
        stats.newRsi70Detected++;
      } else {
        if (!list24h[symbol] && bd5 > MIN_BD5) {
          stats.shortPassedBasic++;

          stats.shortCalled1H++;
          const candles1H = await getCandles(symbol, '1H', 100);
          let diffema10 = 999;

          if (candles1H && candles1H.length >= 25) {
            stats.shortSuccess1H++;
            const closed1H = candles1H.slice(1);
            const chronological1H = [...closed1H].reverse();
            const closes1H = chronological1H.map((c) => parseFloat(c[4]));

            const emaArray1H = calculateEMA(closes1H, 20);
            if (emaArray1H.length >= 10) {
              const ema1Val = emaArray1H[emaArray1H.length - 1];
              const ema10Val = emaArray1H[emaArray1H.length - 10];
              diffema10 = ema1Val - ema10Val;
            }
          }

          if (diffema10 < 0) {
            stats.shortPassedDiffEMA10++;

            const shortKey = `${symbol}_SHORT`;
            const lastSentShort = sentLog[shortKey] || 0;

            if (currentTime - lastSentShort >= COOLDOWN_TIME_SHORT) {
              const shortMsg =
                `<b>🔻 CẢNH BÁO SHORT</b>\n` +
                `Coin: <b>${coinName}</b> (5m/1H)\n` +
                `RSI (5m): ${rsiStr}%\n` +
                `BD5: ${bd5Str}%\n` +
                `DiffEMA10 (1H): ${diffema10.toFixed(4)}\n` +
                `<a href="${link}">🔗 Giao dịch OKX</a>`;

              const isSent = await sendTelegramMessage(shortMsg);
              if (isSent) {
                stats.shortSentSuccess++;
                sentLog[shortKey] = currentTime;
                saveSentLog(sentLog);
              }
            }
          }
        }
      }

      // --- 2. XỬ LÝ LONG ---
      const entryData = list24h[symbol];

      if (entryData) {
        stats.longIn24hList++;

        const candle1 = closedCandles[0];
        const low1 = parseFloat(candle1[3]);

        const closesBB1 = closedCandles.slice(0, 20).map((c) => parseFloat(c[4])).reverse();
        const bb1 = calculateBollingerBands(closesBB1, 20, 2);

        let conditionPassedBBM = false;
        let bbm = 0;

        if (bb1 && bb1.mid > 0) {
          bbm = ((low1 - bb1.mid) / bb1.mid) * 100;
          if (bbm < MAX_BBM) {
            conditionPassedBBM = true;
          }
        }

        if (conditionPassedBBM) {
          stats.longPassedBBM++;

          stats.longCalled1H++;
          const candles1H = await getCandles(symbol, '1H', 100);
          let diffema10 = -999;

          if (candles1H && candles1H.length >= 25) {
            stats.longSuccess1H++;
            const closed1H = candles1H.slice(1);
            const chronological1H = [...closed1H].reverse();
            const closes1H = chronological1H.map((c) => parseFloat(c[4]));

            const emaArray1H = calculateEMA(closes1H, 20);
            if (emaArray1H.length >= 10) {
              const ema1Val = emaArray1H[emaArray1H.length - 1];
              const ema10Val = emaArray1H[emaArray1H.length - 10];
              diffema10 = ema1Val - ema10Val;
            }
          }

          if (diffema10 > 0) {
            stats.longPassedDiffEMA10++;

            const longKey = `${symbol}_LONG`;
            const lastSentLong = sentLog[longKey] || 0;

            if (currentTime - lastSentLong >= COOLDOWN_TIME_LONG) {
              sentLog[longKey] = currentTime;
              saveSentLog(sentLog);
              stats.longSavedSuccess++;

              const bbmSign = bbm >= 0 ? `+${bbm.toFixed(2)}` : bbm.toFixed(2);
              const longMsg =
                `<b>🚀 TÍN HIỆU LONG</b>\n` +
                `Coin: <b>${coinName}</b> (5m/1H)\n` +
                `RSI (5m): ${rsiStr}%\n` +
                `BBM: ${bbmSign}%\n` +
                `DiffEMA10 (1H): +${diffema10.toFixed(4)}\n` +
                `<a href="${link}">🔗 Giao dịch OKX</a>`;

              const isLongSent = await sendTelegramMessage(longMsg);
              if (isLongSent) {
                stats.longSentSuccess++;
              }
            }
          }
        }
      }

      await sleep(100);
    }

    list24h = updateAndSave24hList(list24h, newRsiSymbols);
    stats.totalIn24hList = Object.keys(list24h).length;

    console.log('\n================ BÁO CÁO THỐNG KÊ CHI TIẾT TỪNG BƯỚC ================');
    console.log(`1. Tổng số cặp SWAP quét được từ OKX : ${stats.allSwaps} coin`);
    console.log(`2. Số coin qua lọc Volume (> 5M USDT) : ${stats.passedVol} coin`);
    console.log(`3. Số coin tải đủ dữ liệu nến 5m hợp lệ : ${stats.candlesValid} coin`);
    console.log(`4. Số coin đạt RSI > 70 (vào 24h.json)   : ${stats.newRsi70Detected} coin`);
    console.log(`5. Tổng số coin đang lưu trong 24h.json : ${stats.totalIn24hList} coin`);
    console.log('------------------------------------------------------------------');
    console.log('--- LUỒNG XÉT SHORT ---');
    console.log(`- Thỏa mãn điều kiện cơ bản (RSI<70, BD5>2%): ${stats.shortPassedBasic} coin`);
    console.log(`- Gọi nến 1H (Short)                     : ${stats.shortCalled1H} coin`);
    console.log(`- Gọi nến 1H thành công & đủ dữ liệu     : ${stats.shortSuccess1H} coin`);
    console.log(`- Thỏa mãn thêm DiffEMA10 (1H) < 0        : ${stats.shortPassedDiffEMA10} coin`);
    console.log(`- Gửi tin SHORT thành công               : ${stats.shortSentSuccess} tin`);
    console.log('------------------------------------------------------------------');
    console.log('--- LUỒNG XÉT LONG ---');
    console.log(`- Số coin lấy ra từ 24h.json để xét Long  : ${stats.longIn24hList} coin`);
    console.log(`- Thỏa mãn điều kiện BBM < 0.5% (5m)      : ${stats.longPassedBBM} coin`);
    console.log(`- Gọi nến 1H (Long)                      : ${stats.longCalled1H} coin`);
    console.log(`- Gọi nến 1H thành công & đủ dữ liệu     : ${stats.longSuccess1H} coin`);
    console.log(`- Thỏa mãn thêm DiffEMA10 > 0 (1H)       : ${stats.longPassedDiffEMA10} coin`);
    console.log(`- Lưu file sent_ema.json thành công       : ${stats.longSavedSuccess} coin`);
    console.log(`- Gửi tin LONG thành công                : ${stats.longSentSuccess} tin`);
    console.log('==================================================================\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
