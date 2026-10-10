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
const CLEANUP_TIME_24H_FILE = 12 * 60 * 60 * 1000;  // Tự động xóa coin trong 24h.json sau 12 giờ
const MIN_VOL_CCY24H = 5_000_000;                   // Volume 24h > 5 triệu USDT
const MIN_BD24H = 5;                                // Biến động 24h > 5%

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function updateAndSave24hList(list24h, newRsiData) {
  try {
    const now = Date.now();
    
    // Thêm hoặc cập nhật mốc thời gian và giá trị x cho coin mới đạt RSI > 70
    for (const item of newRsiData) {
      list24h[item.symbol] = {
        timestamp: now,
        x: item.x
      };
    }

    // Tự động dọn dẹp coin đã lưu quá 12 giờ
    const cleaned24h = {};
    for (const [symbol, data] of Object.entries(list24h)) {
      // Hỗ trợ cả định dạng cũ (nếu có lưu kiểu số thuần túy) hoặc cấu trúc mới object
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

// Tính hệ số x theo yêu cầu
function calculateXFactor(closedCandles) {
  // Lấy 10 nến gần nhất (giả sử closedCandles đã sắp xếp từ mới nhất đến cũ hơn, hoặc lấy 10 nến đầu tiên tuỳ theo quy ước mảng)
  // Theo logic code trước: closedCandles[0] là nến mới nhất, closedCandles[9] là nến số 10 (cũ hơn).
  if (closedCandles.length < 10) return 1;

  const tenCandles = closedCandles.slice(0, 10);
  
  let maxGreenChange = 0;
  for (const c of tenCandles) {
    const open = parseFloat(c[1]);
    const close = parseFloat(c[4]);
    if (close > open) {
      const change = ((close - open) / open) * 100;
      if (change > maxGreenChange) {
        maxGreenChange = change;
      }
    }
  }

  // Nến số 10 (index 9 trong mảng 10 nến gần nhất)
  const candle10 = closedCandles[9];
  const open10 = parseFloat(candle10[1]);
  const close10 = parseFloat(candle10[4]);
  let change10 = open10 > 0 ? Math.abs((close10 - open10) / open10) * 100 : 0;
  if (change10 === 0) change10 = 0.01; // Tránh chia cho 0

  return maxGreenChange / change10;
}

// ------------------- LỌC THỊ TRƯỜNG & LẤY NẾN -------------------

async function getFilteredMarkets() {
  let allSwaps = 0;
  let passedVol = 0;
  let passedVolAndBd24h = 0;
  const targetCoins = [];

  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') {
      return { allSwaps, passedVol, passedVolAndBd24h, targetCoins };
    }

    const tickers = res.data.data.filter((item) => item.instId.endsWith('-USDT-SWAP'));
    allSwaps = tickers.length;

    for (const item of tickers) {
      const vol = parseFloat(item.volCcy24h || 0);
      const open24h = parseFloat(item.open24h || 0);
      const last = parseFloat(item.last || 0);

      let bd24h = 0;
      if (open24h > 0) {
        bd24h = Math.abs((last - open24h) / open24h) * 100;
      }

      if (vol > MIN_VOL_CCY24H) {
        passedVol++;
        if (bd24h > MIN_BD24H) {
          passedVolAndBd24h++;
          targetCoins.push({
            instId: item.instId,
            volCcy24h: vol
          });
        }
      }
    }

    return { allSwaps, passedVol, passedVolAndBd24h, targetCoins };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { allSwaps, passedVol, passedVolAndBd24h, targetCoins };
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

    const { allSwaps, passedVol, passedVolAndBd24h, targetCoins } = await getFilteredMarkets();

    const stats = {
      allSwaps,
      passedVol,
      passedVolAndBd24h,
      candlesValid: 0,
      
      newRsi70Detected: 0,
      rsi70SentSuccess: 0,
      totalIn24hList: 0,

      longIn24hList: 0,
      longCandlePattern: 0,
      longConditionMatched: 0,
      longSentSuccess: 0
    };

    const newRsiData = [];

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // Đổi sang khung nến 5m
      const candles5m = await getCandles(symbol, '5m', 80);
      if (!candles5m || candles5m.length < 35) {
        await sleep(60);
        continue;
      }

      const closedCandles = candles5m.slice(1);
      const chronological5m = [...closedCandles].reverse();
      const closes5m = chronological5m.map((c) => parseFloat(c[4]));

      const rsiSeries5m = calculateRSIArray(closes5m, 20);
      if (rsiSeries5m.length < 10) {
        await sleep(60);
        continue;
      }

      stats.candlesValid++;

      const currentRsi5m = rsiSeries5m[rsiSeries5m.length - 1];
      const coinName = symbol.replace('-USDT-SWAP', '');
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
      const rsiStr = currentRsi5m.toFixed(2);

      // Tính giá trị x
      const xVal = calculateXFactor(closedCandles);

      // --- BƯỚC 1: XỬ LÝ COIN CÓ RSI 5M HIỆN TẠI > 70 ---
      if (currentRsi5m > 70) {
        newRsiData.push({ symbol, x: xVal });
        stats.newRsi70Detected++;

        const rsi70Key = `${symbol}_RSI70`;
        const lastSentRsi70 = sentLog[rsi70Key] || 0;

        if (currentTime - lastSentRsi70 >= CLEANUP_TIME_24H_FILE) {
          const rsi70Msg =
            `🔥 <b>CẢNH BÁO RSI &gt; 70: ${coinName} (5m)</b>\n` +
            `• <b>RSI(20):</b> ${rsiStr}%\n` +
            `• <b>Hệ số x:</b> ${xVal.toFixed(2)}\n` +
            `• <a href="${link}">Link OKX</a>`;

          console.log(`⚡ [RSI > 70] Phát hiện ${symbol} (RSI: ${rsiStr}%, x: ${xVal.toFixed(2)}). Đang gửi Telegram...`);
          const isSent = await sendTelegramMessage(rsi70Msg);
          if (isSent) {
            stats.rsi70SentSuccess++;
            sentLog[rsi70Key] = currentTime;
            hasNewAlert = true;
          }
        }
      }

      // ---------------- KIỂM TRA ĐIỀU KIỆN LONG ----------------
      const longKey = `${symbol}_LONG`;
      const lastSentLong = sentLog[longKey] || 0;

      // Kiểm tra xem coin có nằm trong danh sách 24h.json hoặc vừa đạt RSI > 70
      const entryData = list24h[symbol] || (currentRsi5m > 70 ? { timestamp: currentTime, x: xVal } : null);

      if (entryData) {
        stats.longIn24hList++;

        const candle1 = closedCandles[0];
        const candle2 = closedCandles[1];

        const open1 = parseFloat(candle1[1]);
        const close1 = parseFloat(candle1[4]);
        const isGreenCandle1 = close1 > open1;

        const open2 = parseFloat(candle2[1]);
        const close2 = parseFloat(candle2[4]);
        const low2 = parseFloat(candle2[3]);
        const isRedCandle2 = close2 < open2;

        if (isGreenCandle1 && isRedCandle2) {
          stats.longCandlePattern++;

          const closesBB2 = closedCandles.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
          const bb2 = calculateBollingerBands(closesBB2, 20, 2);

          const storedX = typeof entryData === 'object' ? entryData.x : xVal;
          const storedRsi = rsiStr; // Lấy xấp xỉ từ phiên hiện tại hoặc lưu kèm nếu cần

          let conditionPassed = false;
          let indicatorName = '';
          let indicatorVal = 0;

          if (bb2) {
            if (storedX > 7) {
              // Trường hợp x > 7: kiểm tra bbd < 0.5%
              const bbd = bb2.lower > 0 ? (Math.abs(low2 - bb2.lower) / bb2.lower) * 100 : null;
              if (bbd !== null && bbd < 0.5) {
                conditionPassed = true;
                indicatorName = 'bbd';
                indicatorVal = bbd;
              }
            } else {
              // Trường hợp x < 7: kiểm tra bbm < 0.5%
              const bbm = bb2.mid > 0 ? (Math.abs(low2 - bb2.mid) / bb2.mid) * 100 : null;
              if (bbm !== null && bbm < 0.5) {
                conditionPassed = true;
                indicatorName = 'bbm';
                indicatorVal = bbm;
              }
            }
          }

          if (conditionPassed) {
            stats.longConditionMatched++;

            if (currentTime - lastSentLong >= COOLDOWN_TIME_LONG) {
              stats.longSentSuccess++;

              // Tin nhắn theo yêu cầu: tên coin, giá trị rsi trong file 24h.json, giá trị x trong file 24h.json, link.
              const longMsg =
                `🟢 <b>LONG: ${coinName} (5m)</b>\n` +
                `• <b>RSI (24h.json):</b> ${storedRsi}%\n` +
                `• <b>Hệ số x (24h.json):</b> ${storedX.toFixed(2)}\n` +
                `• <b>Điều kiện (${indicatorName}):</b> ${indicatorVal.toFixed(2)}% (&lt; 0.5%)\n` +
                `• <a href="${link}">Link OKX</a>`;

              console.log(`🚀 [LONG] Đạt điều kiện (${indicatorName})! Đang gửi Telegram cho ${symbol}...`);

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

    list24h = updateAndSave24hList(list24h, newRsiData);
    stats.totalIn24hList = Object.keys(list24h).length;

    if (hasNewAlert) saveSentLog(sentLog);

    console.log('\n================ BÁO CÁO THỐNG KÊ QUÉT THỊ TRƯỜNG (5m) ================');
    console.log(`- Tổng số cặp SWAP quét được từ OKX: ${stats.allSwaps} coin`);
    console.log(`- Số coin thỏa mãn Volume 24h > 5M USDT: ${stats.passedVol} coin`);
    console.log(`- Số coin thỏa mãn Biến động 24h > 5%: ${stats.passedVolAndBd24h} coin`);
    console.log(`- Số coin tải đủ dữ liệu nến 5m: ${stats.candlesValid} coin`);
    console.log(`- Số coin đạt RSI > 70 mới: ${stats.newRsi70Detected} coin`);
    console.log(`- Tổng số coin lưu trong 24h.json: ${stats.totalIn24hList} coin`);
    console.log(`- Số tín hiệu LONG gửi thành công: ${stats.longSentSuccess} tin`);
    console.log('======================================================================\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
