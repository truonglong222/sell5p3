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
const COOLDOWN_TIME_LONG = 24 * 60 * 60 * 1000;   // 24 giờ cho Long
const COOLDOWN_TIME_SHORT = 24 * 60 * 60 * 1000;  // 24 giờ cho Short
const MIN_VOL_CCY24H = 5_000_000;                // Volume 24h > 5 triệu USDT

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------- HÀM TIỆN ÍCH TRÁNH LỖI HTML TELEGRAM -------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '')
    .replace(/>/g, '');
}

// ------------------- QUẢN LÝ DỮ LIỆU FILE SENT LOG -------------------

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
    const currentTime = Date.now();

    const { allSwaps, passedVol, targetCoins } = await getFilteredMarkets();

    const stats = {
      allSwaps,
      passedVol,
      candlesValid: 0,
      shortPassedBasic: 0,
      shortCalled1H: 0,
      shortSuccess1H: 0,
      shortPassedDiffEMA10: 0,
      shortSentSuccess: 0,

      longPassedBasic: 0,
      longCalled1H: 0,
      longSuccess1H: 0,
      longPassedDiffEMA10: 0,
      longSentSuccess: 0
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;
      const coinName = escapeHtml(symbol.replace('-USDT-SWAP', ''));
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      // Lấy nến 5m (cần ít nhất 5 nến để tính bd5)
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

      // --- 1. TÍNH BD5 TRƯỚC ---
      const close0 = parseFloat(closedCandles[0][4]);
      const open4 = parseFloat(closedCandles[4][1]);
      let bd5 = 0;
      if (open4 > 0) {
        bd5 = ((close0 - open4) / open4) * 100;
      }
      const bd5Str = bd5 >= 0 ? `+${bd5.toFixed(2)}` : bd5.toFixed(2);

      // Kiểm tra xem bd5 có thỏa mãn điều kiện Short hoặc Long không
      const isShortBd5 = bd5 > 2.5 && bd5 < 4;
      const isLongBd5 = bd5 > -4 && bd5 < -2;

      // Nếu không thỏa mãn bất kỳ điều kiện bd5 nào thì bỏ qua, không tính RSI
      if (!isShortBd5 && !isLongBd5) {
        await sleep(100);
        continue;
      }

      // --- 2. CHỈ TÍNH RSI KHI THỎA MÃN ĐIỀU KIỆN BD5 ---
      const chronological5m = [...closedCandles].reverse();
      const closes5m = chronological5m.map((c) => parseFloat(c[4]));

      const rsiSeries5m = calculateRSIArray(closes5m, 20);
      if (rsiSeries5m.length < 10) {
        await sleep(100);
        continue;
      }

      const currentRsi5m = rsiSeries5m[rsiSeries5m.length - 1];
      const rsiStr = currentRsi5m.toFixed(2);

      // --- 3. XÉT ĐIỀU KIỆN SHORT ---
      if (isShortBd5 && currentRsi5m < 65) {
        stats.shortPassedBasic++;
        stats.shortCalled1H++;

        const candles1H = await getCandles(symbol, '1H', 100);
        let diffema10 = 0;

        if (candles1H && candles1H.length >= 25) {
          stats.shortSuccess1H++;
          const closed1H = candles1H.slice(1);
          const chronological1H = [...closed1H].reverse();
          const closes1H = chronological1H.map((c) => parseFloat(c[4]));

          const emaArray1H = calculateEMA(closes1H, 20);
          if (emaArray1H.length >= 10) {
            const ema1Val = emaArray1H[emaArray1H.length - 1];
            const ema10Val = emaArray1H[emaArray1H.length - 10];
            diffema10 = ((ema1Val - ema10Val) / ema10Val) * 100;
          }
        }

        // Điều kiện: diffema10 < -0.5%
        if (diffema10 < -0.5) {
          stats.shortPassedDiffEMA10++;

          const shortKey = `${symbol}_SHORT`;
          const lastSentShort = sentLog[shortKey] || 0;

          if (currentTime - lastSentShort >= COOLDOWN_TIME_SHORT) {
            const shortMsg =
              `<b>🔻 CẢNH BÁO SHORT</b>\n` +
              `Coin: <b>${coinName}</b> (5m/1H)\n` +
              `RSI (5m): ${rsiStr}%\n` +
              `BD5: ${bd5Str}%\n` +
              `DiffEMA10 (1H): ${diffema10.toFixed(4)}%\n` +
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

      // --- 4. XÉT ĐIỀU KIỆN LONG ---
      if (isLongBd5 && currentRsi5m > 50) {
        stats.longPassedBasic++;
        stats.longCalled1H++;

        const candles1H = await getCandles(symbol, '1H', 100);
        let diffema10 = 0;

        if (candles1H && candles1H.length >= 25) {
          stats.longSuccess1H++;
          const closed1H = candles1H.slice(1);
          const chronological1H = [...closed1H].reverse();
          const closes1H = chronological1H.map((c) => parseFloat(c[4]));

          const emaArray1H = calculateEMA(closes1H, 20);
          if (emaArray1H.length >= 10) {
            const ema1Val = emaArray1H[emaArray1H.length - 1];
            const ema10Val = emaArray1H[emaArray1H.length - 10];
            diffema10 = ((ema1Val - ema10Val) / ema10Val) * 100;
          }
        }

        // Điều kiện: diffema10 > 0.5%
        if (diffema10 > 0.5) {
          stats.longPassedDiffEMA10++;

          const longKey = `${symbol}_LONG`;
          const lastSentLong = sentLog[longKey] || 0;

          if (currentTime - lastSentLong >= COOLDOWN_TIME_LONG) {
            const longMsg =
              `<b>🚀 TÍN HIỆU LONG</b>\n` +
              `Coin: <b>${coinName}</b> (5m/1H)\n` +
              `RSI (5m): ${rsiStr}%\n` +
              `BD5: ${bd5Str}%\n` +
              `DiffEMA10 (1H): +${diffema10.toFixed(4)}%\n` +
              `<a href="${link}">🔗 Giao dịch OKX</a>`;

            const isSent = await sendTelegramMessage(longMsg);
            if (isSent) {
              stats.longSentSuccess++;
              sentLog[longKey] = currentTime;
              saveSentLog(sentLog);
            }
          }
        }
      }

      await sleep(100);
    }

    console.log('\n================ BÁO CÁO THỐNG KÊ CHI TIẾT TỪNG BƯỚC ================');
    console.log(`1. Tổng số cặp SWAP quét được từ OKX : ${stats.allSwaps} coin`);
    console.log(`2. Số coin qua lọc Volume (> 5M USDT) : ${stats.passedVol} coin`);
    console.log(`3. Số coin tải đủ dữ liệu nến 5m hợp lệ : ${stats.candlesValid} coin`);
    console.log('------------------------------------------------------------------');
    console.log('--- LUỒNG XÉT SHORT ---');
    console.log(`- Thỏa mãn điều kiện cơ bản (RSI<65, 2.5%<BD5<4%): ${stats.shortPassedBasic} coin`);
    console.log(`- Gọi nến 1H (Short)                     : ${stats.shortCalled1H} coin`);
    console.log(`- Gọi nến 1H thành công & đủ dữ liệu     : ${stats.shortSuccess1H} coin`);
    console.log(`- Thỏa mãn thêm DiffEMA10 (1H) < -0.5%   : ${stats.shortPassedDiffEMA10} coin`);
    console.log(`- Gửi tin SHORT thành công               : ${stats.shortSentSuccess} tin`);
    console.log('------------------------------------------------------------------');
    console.log('--- LUỒNG XÉT LONG ---');
    console.log(`- Thỏa mãn điều kiện cơ bản (RSI>50, -4%<BD5<-2%): ${stats.longPassedBasic} coin`);
    console.log(`- Gọi nến 1H (Long)                      : ${stats.longCalled1H} coin`);
    console.log(`- Gọi nến 1H thành công & đủ dữ liệu     : ${stats.longSuccess1H} coin`);
    console.log(`- Thỏa mãn thêm DiffEMA10 > 0.5% (1H)    : ${stats.longPassedDiffEMA10} coin`);
    console.log(`- Gửi tin LONG thành công                : ${stats.longSentSuccess} tin`);
    console.log('==================================================================\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
