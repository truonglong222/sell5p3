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
const RESULTS_FILE = path.join(__dirname, '24h.json');

// Cấu hình
const COOLDOWN_TIME = 4 * 60 * 60 * 1000; // 4 tiếng
const MIN_VOL_CCY24H = 10_000_000; // Volume 24h > 10 triệu USD

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    for (const [coin, timeData] of Object.entries(logData)) {
      const temp = {};
      if (timeData.longAlert && now - timeData.longAlert < COOLDOWN_TIME) {
        temp.longAlert = timeData.longAlert;
      }
      if (timeData.shortAlert && now - timeData.shortAlert < COOLDOWN_TIME) {
        temp.shortAlert = timeData.shortAlert;
      }
      if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
  } catch (e) {}
}

function saveScanResults(results) {
  try {
    const outputData = {
      lastScanAt: new Date().toISOString(),
      matchedCoinsCount: results.length,
      matchedCoins: results
    };
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(outputData, null, 2), 'utf8');
  } catch (e) {
    console.error('Lỗi khi lưu 24h.json:', e.message);
  }
}

// ------------------- HÀM TÍNH TOÁN KỸ THUẬT -------------------

// Tính Bollinger Bands cơ bản (chu kỳ 20, độ lệch chuẩn 2)
function calculateBollingerBands(prices, period = 20, stdDevMultiplier = 2) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    middle: mean,
    upper: mean + stdDevMultiplier * stdDev,
    lower: mean - stdDevMultiplier * stdDev
  };
}

// Tính mảng EMA (mặc định period = 20)
function calculateEMAArray(prices, period = 20) {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const emaArray = [];

  let initialSma = 0;
  for (let i = 0; i < period; i++) {
    initialSma += prices[i];
  }
  let prevEma = initialSma / period;
  emaArray.push(prevEma);

  for (let i = period; i < prices.length; i++) {
    const currentEma = prices[i] * k + prevEma * (1 - k);
    emaArray.push(currentEma);
    prevEma = currentEma;
  }
  return emaArray;
}

// ------------------- LỌC THỊ TRƯỜNG (VOLUME > 10M) -------------------

async function getFilteredMarkets() {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') return { allSwapsCount: 0, filteredCoins: [] };

    const tickers = res.data.data.filter((item) => item.instId.endsWith('-USDT-SWAP'));
    const volFiltered = tickers.filter((item) => parseFloat(item.volCcy24h || 0) > MIN_VOL_CCY24H);

    const filteredCoins = volFiltered.map((item) => ({
      instId: item.instId,
      volCcy24h: parseFloat(item.volCcy24h || 0),
      last: parseFloat(item.last || 0)
    }));

    return {
      allSwapsCount: tickers.length,
      filteredCoins
    };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { allSwapsCount: 0, filteredCoins: [] };
  }
}

// ------------------- LẤY DỮ LIỆU NẾN -------------------

async function getCandles(symbol, bar = '15m', limit = 100) {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 6000 });
    if (!res.data || res.data.code !== '0' || !Array.isArray(res.data.data)) return null;
    return res.data.data;
  } catch (error) {
    console.error(`Lỗi lấy dữ liệu nến ${bar} (${symbol}):`, error.message);
    return null;
  }
}

// ------------------- TIẾN TRÌNH CHÍNH -------------------

async function main() {
  try {
    console.log('--- BẮT ĐẦU QUÉT THỊ TRƯỜNG OKX (EMA TREND & HBB STRATEGY) ---');

    const sentLog = loadSentLog();
    const currentTime = Date.now();
    let hasNewAlert = false;

    // 1. Lọc Volume > 10M USD
    const { allSwapsCount, filteredCoins: targetCoins } = await getFilteredMarkets();
    console.log(`📊 [Lọc 24h] Tổng USDT Swap: ${allSwapsCount} | Vol > 10M USDT: ${targetCoins.length} coin`);

    const passedDiffConditions = [];

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // Cần tối thiểu 20 nến tính SMA ban đầu + 20 nến lùi = 40+ nến
      const candles15m = await getCandles(symbol, '15m', 100);
      if (!candles15m || candles15m.length < 50) {
        await sleep(80);
        continue;
      }

      // OKX trả về nến mới nhất tại index 0 (nến đang chạy).
      // slice(1) loại bỏ nến đang chạy:
      // index 0 của closedCandles = Nến số 1 (đã đóng gần nhất)
      const closedCandles = candles15m.slice(1);
      const candle1 = closedCandles[0];
      const open1 = parseFloat(candle1[1]);
      const close1 = parseFloat(candle1[4]);

      if (open1 <= 0) {
        await sleep(80);
        continue;
      }

      // Đảo chiều mảng giá đóng cửa theo thứ tự thời gian cũ -> mới
      const closedPricesAsc = closedCandles.map((c) => parseFloat(c[4])).reverse();

      // Tính chuỗi EMA 20
      const emaSeries = calculateEMAArray(closedPricesAsc, 20);
      if (emaSeries.length < 20) {
        await sleep(80);
        continue;
      }

      // Nến số 1 là giá trị cuối cùng trong mảng EMA
      // Nến số 10 lùi 9 bước, nến số 20 lùi 19 bước
      const ema1 = emaSeries[emaSeries.length - 1];
      const ema10 = emaSeries[emaSeries.length - 10];
      const ema20 = emaSeries[emaSeries.length - 20];

      if (!ema1 || !ema10 || !ema20 || ema10 <= 0 || ema20 <= 0) {
        await sleep(80);
        continue;
      }

      // Tính chênh lệch % EMA
      const diffema10 = ((ema1 - ema10) / ema10) * 100;
      const diffema20 = ((ema1 - ema20) / ema20) * 100;

      // Điều kiện lọc: -1% < diffema10 < 1% VÀ -1% < diffema20 < 1%
      const isSatisfiedDiff = diffema10 > -1 && diffema10 < 1 && diffema20 > -1 && diffema20 < 1;

      if (!isSatisfiedDiff) {
        await sleep(80);
        continue;
      }

      // Tính Hbb nến số 1 = ((Upper - Lower) / Middle) * 100 (chu kỳ 20 nến đóng gần nhất)
      const closesForBb1 = closedPricesAsc.slice(-20);
      const bb1 = calculateBollingerBands(closesForBb1, 20);
      if (!bb1 || bb1.middle <= 0) {
        await sleep(80);
        continue;
      }

      const hbb1 = ((bb1.upper - bb1.lower) / bb1.middle) * 100;
      if (hbb1 <= 0) {
        await sleep(80);
        continue;
      }

      // Biến động nến 15m số 1 (%)
      const changeCandle1 = ((close1 - open1) / open1) * 100;

      // y = Biến động nến 1 / Hbb nến 1
      const y = changeCandle1 / hbb1;

      const coinName = symbol.replace('-USDT-SWAP', '');
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      const coinResult = {
        symbol,
        volCcy24h: coin.volCcy24h,
        hbb1: parseFloat(hbb1.toFixed(4)),
        diffema10: parseFloat(diffema10.toFixed(4)),
        diffema20: parseFloat(diffema20.toFixed(4)),
        changeCandle1: parseFloat(changeCandle1.toFixed(2)),
        y: parseFloat(y.toFixed(4)),
        link
      };

      // Thêm vào danh sách thoả mãn điều kiện lưu 24h.json
      passedDiffConditions.push(coinResult);
      console.log(
        `✅ [Thỏa diffema] ${symbol.padEnd(16)} | diffema10: ${diffema10.toFixed(2)}% | diffema20: ${diffema20.toFixed(2)}% | y: ${y.toFixed(2)} | Hbb1: ${hbb1.toFixed(2)}%`
      );

      // Xét điều kiện gửi tín hiệu: y > 0.5 (LONG) hoặc y < -0.5 (SHORT)
      const isLong = y > 0.5;
      const isShort = y < -0.5;

      if (isLong || isShort) {
        const signalType = isLong ? 'LONG' : 'SHORT';
        const alertKey = isLong ? 'longAlert' : 'shortAlert';

        if (!sentLog[symbol]) sentLog[symbol] = {};
        const lastSentTime = sentLog[symbol][alertKey];
        const isCooldown = currentTime - (lastSentTime || 0) < COOLDOWN_TIME;

        if (!isCooldown) {
          const icon = isLong ? '🟢' : '🔴';
          const message =
            `${icon} <b>TÍN HIỆU ${signalType} (15m): ${coinName}</b>\n\n` +
            `• <b>Hbb nến 1:</b> ${hbb1.toFixed(2)}%\n` +
            `• <b>diffema10:</b> ${diffema10.toFixed(2)}%\n` +
            `• <b>diffema20:</b> ${diffema20.toFixed(2)}%\n` +
            `• <b>y:</b> ${y.toFixed(2)}\n` +
            `• <b>Biến động nến 1:</b> ${changeCandle1 > 0 ? '+' : ''}${changeCandle1.toFixed(2)}%\n` +
            `• <a href="${link}">Link OKX</a>`;

          console.log(`🚀 [${signalType}] Gửi Telegram cho ${symbol}...`);
          await axios
            .post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
              chat_id: TELEGRAM_CHAT_ID,
              text: message,
              parse_mode: 'HTML',
              disable_web_page_preview: true
            })
            .catch((err) => console.error(`Lỗi gửi Telegram (${symbol}):`, err.message));

          sentLog[symbol][alertKey] = currentTime;
          hasNewAlert = true;
        } else {
          console.log(`⏳ ${symbol} khớp ${signalType} nhưng đang trong thời gian Cooldown.`);
        }
      }

      await sleep(80);
    }

    // 2. Lưu danh sách vào file 24h.json
    saveScanResults(passedDiffConditions);
    if (hasNewAlert) saveSentLog(sentLog);

    console.log('\n================== KẾT QUẢ QUÉT ==================');
    console.log(`📁 Đã lưu ${passedDiffConditions.length} coin thỏa điều kiện vào ${RESULTS_FILE}`);
    if (passedDiffConditions.length > 0) {
      console.table(passedDiffConditions);
    }
    console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---\n');
  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
