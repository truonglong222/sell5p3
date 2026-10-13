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

// Cấu hình Cooldown & Ngưỡng lọc tối ưu
const COOLDOWN_TIME_LONG = 24 * 60 * 60 * 1000;      // 24 giờ cho Long
const CLEANUP_TIME_24H_FILE = 24 * 60 * 60 * 1000;  // Tự động xóa coin trong 24h.json sau 24 giờ
const MIN_VOL_CCY24H = 5_000_000;                   // 1. Lọc Volume 24h > 5 triệu USDT
const MIN_BD5 = 3;                                  // 2. Lọc BD5 > +3%
const MIN_RSI = 60;                                 // 3. Lọc RSI > 60

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
  } catch (e) {}
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
    
    // Thêm hoặc cập nhật mốc thời gian cho coin mới đạt RSI > 60 & BD5 > 3%
    for (const symbol of newRsiSymbols) {
      list24h[symbol] = now;
    }

    // Tự động dọn dẹp coin đã lưu quá thời gian quy định
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

      // Bước 1: Lọc Volume > 5 triệu USDT
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
    const res = await axios.get(url, { timeout: 6000 });
    if (!res.data || res.data.code !== '0' || !Array.isArray(res.data.data)) return null;
    return res.data.data;
  } catch (error) {
    console.error(`Lỗi lấy nến ${bar} (${symbol}):`, error.message);
    return null;
  }
}

async function sendTelegramMessage(message) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
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
    let hasNewAlert = false;

    const { allSwaps, passedVol, targetCoins } = await getFilteredMarkets();

    const stats = {
      allSwaps,
      passedVol,
      passedBd5: 0,
      passedRsi60: 0,
      candlesValid: 0,
      
      newRsiDetected: 0,
      rsiSentSuccess: 0,
      totalIn24hList: 0,

      longIn24hList: 0,
      longCandlePattern: 0,
      longConditionMatched: 0,
      longSentSuccess: 0
    };

    const newRsiSymbols = [];

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // Lấy khung nến 5m
      const candles5m = await getCandles(symbol, '5m', 80);
      if (!candles5m || candles5m.length < 35) {
        await sleep(60);
        continue;
      }

      const closedCandles = candles5m.slice(1);
      if (closedCandles.length < 5) {
        await sleep(60);
        continue;
      }

      // Bước 2: Tính BD5 (Chênh lệch % giữa giá đóng cửa nến vừa đóng và giá mở cửa nến số 5)
      const candle1 = closedCandles[0]; // Nến vừa đóng
      const candle5 = closedCandles[4]; // Nến số 5 tính từ nến vừa đóng trở về trước
      
      const close1Val = parseFloat(candle1[4]);
      const open5Val = parseFloat(candle5[1]);
      
      let bd5 = 0;
      if (open5Val > 0) {
        bd5 = ((close1Val - open5Val) / open5Val) * 100;
      }

      if (bd5 <= MIN_BD5) {
        await sleep(60);
        continue;
      }
      stats.passedBd5++;
      const bd5ValStr = `+${bd5.toFixed(2)}`;

      const chronological5m = [...closedCandles].reverse();
      const closes5m = chronological5m.map((c) => parseFloat(c[4]));

      const rsiSeries5m = calculateRSIArray(closes5m, 20);
      if (rsiSeries5m.length < 10) {
        await sleep(60);
        continue;
      }

      stats.candlesValid++;

      const currentRsi5m = rsiSeries5m[rsiSeries5m.length - 1];
      
      // Bước 3: Lọc RSI > 60
      if (currentRsi5m <= MIN_RSI) {
        await sleep(60);
        continue;
      }
      stats.passedRsi60++;

      const coinName = escapeHtml(symbol.replace('-USDT-SWAP', ''));
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
      const rsiStr = currentRsi5m.toFixed(2);

      // --- XỬ LÝ LƯU FILE 24H.JSON & GỬI TELEGRAM KHI ĐẠT ĐIỀU KIỆN ---
      newRsiSymbols.push(symbol);
      stats.newRsiDetected++;

      const rsiKey = `${symbol}_RSI60`;
      const lastSentRsi = sentLog[rsiKey] || 0;

      if (currentTime - lastSentRsi >= CLEANUP_TIME_24H_FILE) {
        const rsiMsg =
          `<b>⚡ CẢNH BÁO RSI > 60</b>\n` +
          `Coin: <b>${coinName}</b> (5m)\n` +
          `RSI: ${rsiStr}%\n` +
          `BD5: ${bd5ValStr}%\n` +
          `<a href="${link}">🔗 Giao dịch OKX</a>`;

        console.log(`⚡ [RSI > 60] Phát hiện ${symbol} (RSI: ${rsiStr}%, BD5: ${bd5ValStr}%). Đang gửi Telegram...`);
        const isSent = await sendTelegramMessage(rsiMsg);
        if (isSent) {
          stats.rsiSentSuccess++;
          sentLog[rsiKey] = currentTime;
          hasNewAlert = true;
        }
      }

      // ---------------- KIỂM TRA ĐIỀU KIỆN LONG ----------------
      const longKey = `${symbol}_LONG`;
      const lastSentLong = sentLog[longKey] || 0;

      // Kiểm tra xem coin có nằm trong danh sách 24h.json hoặc vừa đạt điều kiện
      const entryData = list24h[symbol] || (currentRsi5m > MIN_RSI ? currentTime : null);

      if (entryData) {
        stats.longIn24hList++;

        const candle1Pattern = closedCandles[0]; // Nến vừa đóng
        const candle2Pattern = closedCandles[1]; // Nến trước nến vừa đóng

        const open1 = parseFloat(candle1Pattern[1]);
        const close1 = parseFloat(candle1Pattern[4]);
        const isGreenCandle1 = close1 > open1; // Nến vừa đóng là nến xanh

        const open2 = parseFloat(candle2Pattern[1]);
        const close2 = parseFloat(candle2Pattern[4]);
        const low2 = parseFloat(candle2Pattern[3]);
        const isRedCandle2 = close2 < open2; // Nến trước nến vừa đóng là nến đỏ

        if (isGreenCandle1 && isRedCandle2) {
          stats.longCandlePattern++;

          const closesBB2 = closedCandles.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
          const bb2 = calculateBollingerBands(closesBB2, 20, 2);

          let conditionPassed = false;

          if (bb2) {
            // Nến đỏ trước đó có giá thấp nhất < Bollinger band mid
            if (low2 < bb2.mid) {
              conditionPassed = true;
            }
          }

          if (conditionPassed) {
            stats.longConditionMatched++;

            if (currentTime - lastSentLong >= COOLDOWN_TIME_LONG) {
              stats.longSentSuccess++;

              const longMsg =
                `<b>🚀 TÍN HIỆU LONG</b>\n` +
                `Coin: <b>${coinName}</b> (5m)\n` +
                `RSI: ${rsiStr}%\n` +
                `BD5: ${bd5ValStr}%\n` +
                `<a href="${link}">🔗 Giao dịch OKX</a>`;

              console.log(`🚀 [LONG] Đạt điều kiện! Đang gửi Telegram cho ${symbol}...`);

              const isLongSent = await sendTelegramMessage(longMsg);
              if (isLongSent) {
                sentLog[longKey] = currentTime;
                hasNewAlert = true;
              }
            }
          }
        }
      }

      await sleep(100);
    }

    list24h = updateAndSave24hList(list24h, newRsiSymbols);
    stats.totalIn24hList = Object.keys(list24h).length;

    if (hasNewAlert) saveSentLog(sentLog);

    console.log('\n================ BÁO CÁO THỐNG KÊ QUÉT THỊ TRƯỜNG (5m) ================');
    console.log(`- Tổng số cặp SWAP quét được từ OKX: ${stats.allSwaps} coin`);
    console.log(`- Số coin thỏa mãn Volume 24h > 5M USDT: ${stats.passedVol} coin`);
    console.log(`- Số coin thỏa mãn BD5 > +3%: ${stats.passedBd5} coin`);
    console.log(`- Số coin thỏa mãn RSI > 60: ${stats.passedRsi60} coin`);
    console.log(`- Tổng số coin lưu trong 24h.json: ${stats.totalIn24hList} coin`);
    console.log(`- Số tín hiệu LONG gửi thành công: ${stats.longSentSuccess} tin`);
    console.log('======================================================================\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
