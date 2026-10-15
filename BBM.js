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
const MIN_BD5 = 3;                                  // 2. Lọc % tăng trưởng 5 nến gần nhất > +3%
const MAX_BBM = 0.5;                                // Điều kiện bbm < 0.5% (không lấy trị tuyệt đối)

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

    // Thêm hoặc cập nhật mốc thời gian cho coin mới đạt RSI > 70
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

    // Bước 1: Lọc Volume > 5 triệu USDT
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
    const res = await axios.get(url, { timeout: 6000 });
    if (!res.data || res.data.code !== '0' || !Array.isArray(res.data.data)) return null;
    return res.data.data;
  } catch (error) {
    console.error(`Lỗi lấy nến ${bar} (${symbol}):`, error.message);
    return null;
  }
}

// ------------------- GỬI TELEGRAM & BẮT LOG LỖI CHI TIẾT -------------------

async function sendTelegramMessage(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('\n❌ [TELEGRAM ERROR] Thiếu cấu hình BOT_TOKEN hoặc CHAT_ID:');
    console.error(`   - BOT_TOKEN: ${TELEGRAM_BOT_TOKEN ? 'Đã có' : 'CHƯA CÓ (undefined)'}`);
    console.error(`   - CHAT_ID: ${TELEGRAM_CHAT_ID ? TELEGRAM_CHAT_ID : 'CHƯA CÓ (undefined)'}\n`);
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
    console.error('\n❌ [TELEGRAM SEND ERROR]');
    if (err.response) {
      console.error(`- HTTP Status : ${err.response.status}`);
      console.error(`- Error Code  : ${err.response.data?.error_code}`);
      console.error(`- Description : ${err.response.data?.description}`);
      console.error(`- Raw Data    :`, JSON.stringify(err.response.data, null, 2));
    } else if (err.request) {
      console.error(`- Network Error: Không nhận được phản hồi từ api.telegram.org (${err.code || err.message})`);
    } else {
      console.error(`- General Error: ${err.message}`);
    }
    console.error('- Message Preview:\n', message);
    console.error('--------------------------------------------------\n');
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
      passedBd5: 0,
      candlesValid: 0,

      newRsi70Detected: 0,
      rsi70SentSuccess: 0,
      totalIn24hList: 0,

      longIn24hList: 0,
      longCandlePattern: 0,
      longConditionMatched: 0,
      longSavedSuccess: 0,
      longSentSuccess: 0
    };

    const newRsiSymbols = [];

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // Lấy nến 5m (cần ít nhất 35 nến để tính RSI 20 + 5 nến để tính bd5)
      const candles5m = await getCandles(symbol, '5m', 80);
      if (!candles5m || candles5m.length < 35) {
        await sleep(60);
        continue;
      }

      const closedCandles = candles5m.slice(1); // Bỏ nến chưa đóng hiện tại
      if (closedCandles.length < 21) {
        await sleep(60);
        continue;
      }

      // Tính bd5: chênh lệch % giữa giá đóng cửa nến vừa đóng (index 0) và giá mở cửa nến số 5 (index 4)
      const close0 = parseFloat(closedCandles[0][4]);
      const open4 = parseFloat(closedCandles[4][1]);

      let bd5 = 0;
      if (open4 > 0) {
        bd5 = ((close0 - open4) / open4) * 100;
      }

      // Bước 2: Lọc bd5 > 3%
      if (bd5 <= MIN_BD5) {
        await sleep(60);
        continue;
      }
      stats.passedBd5++;

      const chronological5m = [...closedCandles].reverse();
      const closes5m = chronological5m.map((c) => parseFloat(c[4]));

      const rsiSeries5m = calculateRSIArray(closes5m, 20);
      if (rsiSeries5m.length < 10) {
        await sleep(60);
        continue;
      }

      stats.candlesValid++;

      const currentRsi5m = rsiSeries5m[rsiSeries5m.length - 1];
      const coinName = escapeHtml(symbol.replace('-USDT-SWAP', ''));
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
      const rsiStr = currentRsi5m.toFixed(2);
      const bd5Str = `+${bd5.toFixed(2)}`;

      // Bước 3: Lọc RSI > 70
      if (currentRsi5m > 70) {
        newRsiSymbols.push(symbol);
        stats.newRsi70Detected++;

        const rsi70Key = `${symbol}_RSI70`;
        const lastSentRsi70 = sentLog[rsi70Key] || 0;

        if (currentTime - lastSentRsi70 >= CLEANUP_TIME_24H_FILE) {
          const rsi70Msg =
            `<b>⚡ CẢNH BÁO RSI > 70</b>\n` +
            `Coin: <b>${coinName}</b> (5m)\n` +
            `RSI: ${rsiStr}%\n` +
            `BD5: ${bd5Str}%\n` +
            `<a href="${link}">🔗 Giao dịch OKX</a>`;

          console.log(`⚡ [RSI > 70] Phát hiện ${symbol} (RSI: ${rsiStr}%, BD5: ${bd5Str}%). Đang gửi Telegram...`);
          const isSent = await sendTelegramMessage(rsi70Msg);
          if (isSent) {
            stats.rsi70SentSuccess++;
            sentLog[rsi70Key] = currentTime;
            saveSentLog(sentLog);
          }
        }
      }

      // ---------------- KIỂM TRA ĐIỀU KIỆN LONG ----------------
      const longKey = `${symbol}_LONG`;
      const lastSentLong = sentLog[longKey] || 0;

      // Bước 4: Kiểm tra coin nằm trong list 24h.json (hoặc vừa đạt RSI > 70)
      const entryData = list24h[symbol] || (currentRsi5m > 70 ? currentTime : null);

      if (entryData) {
        stats.longIn24hList++;

        const candle1 = closedCandles[0]; // Nến số 1: nến vừa đóng
        const candle2 = closedCandles[1]; // Nến số 2: nến trước nến vừa đóng

        const open1 = parseFloat(candle1[1]);
        const close1 = parseFloat(candle1[4]);
        const isGreenCandle1 = close1 > open1; // Nến 1 là nến xanh

        const open2 = parseFloat(candle2[1]);
        const close2 = parseFloat(candle2[4]);
        const low2 = parseFloat(candle2[3]);
        const isRedCandle2 = close2 < open2; // Nến 2 là nến đỏ

        // Điều kiện 1: Nến 1 xanh và Nến 2 đỏ
        if (isGreenCandle1 && isRedCandle2) {
          stats.longCandlePattern++;

          // Lấy 20 nến tính từ nến số 2 trở về trước để tính BB cho nến 2
          const closesBB2 = closedCandles.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
          const bb2 = calculateBollingerBands(closesBB2, 20, 2);

          let conditionPassed = false;
          let bbm = 0;

          if (bb2 && bb2.mid > 0) {
            // bbm = chênh lệch % giữa giá thấp nhất nến 2 so với bb2.mid (không dùng trị tuyệt đối)
            bbm = ((low2 - bb2.mid) / bb2.mid) * 100;

            // Điều kiện 2: bbm < 0.5%
            if (bbm < MAX_BBM) {
              conditionPassed = true;
            }
          }

          if (conditionPassed) {
            stats.longConditionMatched++;

            if (currentTime - lastSentLong >= COOLDOWN_TIME_LONG) {
              // 1. Cập nhật và lưu NGAY LẬP TỨC vào sent_ema.json trước khi gửi tin nhắn Telegram
              sentLog[longKey] = currentTime;
              saveSentLog(sentLog);
              stats.longSavedSuccess++;

              const bbmSign = bbm >= 0 ? `+${bbm.toFixed(2)}` : bbm.toFixed(2);
              const longMsg =
                `<b>🚀 TÍN HIỆU LONG</b>\n` +
                `Coin: <b>${coinName}</b> (5m)\n` +
                `RSI: ${rsiStr}%\n` +
                `BD5: ${bd5Str}%\n` +
                `BBM: ${bbmSign}%\n` +
                `<a href="${link}">🔗 Giao dịch OKX</a>`;

              console.log(`💾 [LONG] Đã lưu ${symbol} vào sent_ema.json! Đang gửi Telegram (BBM: ${bbmSign}%)...`);

              // 2. Gửi tin nhắn Telegram sau khi đã lưu
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

    // Cập nhật và lưu file 24h.json
    list24h = updateAndSave24hList(list24h, newRsiSymbols);
    stats.totalIn24hList = Object.keys(list24h).length;

    console.log('\n================ BÁO CÁO THỐNG KÊ QUÉT THỊ TRƯỜNG (5m) ================');
    console.log(`- Tổng số cặp SWAP quét được từ OKX: ${stats.allSwaps} coin`);
    console.log(`- Số coin thỏa mãn Volume 24h > 5M USDT: ${stats.passedVol} coin`);
    console.log(`- Số coin thỏa mãn BD5 > +3%: ${stats.passedBd5} coin`);
    console.log(`- Số coin thỏa mãn điều kiện nến/RSI hợp lệ: ${stats.candlesValid} coin`);
    console.log(`- Số coin đạt RSI > 70 mới: ${stats.newRsi70Detected} coin`);
    console.log(`- Tổng số coin lưu trong 24h.json: ${stats.totalIn24hList} coin`);
    console.log(`- Số tín hiệu LONG thỏa mãn & đã lưu file: ${stats.longSavedSuccess} coin`);
    console.log(`- Số tín hiệu LONG gửi Telegram thành công: ${stats.longSentSuccess} tin`);
    console.log('======================================================================\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
