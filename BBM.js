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
const RESULTS_FILE = path.join(__dirname, 'results.json');

// Cấu hình Cooldown: 12 tiếng riêng biệt cho Long và Short
const COOLDOWN_TIME = 12 * 60 * 60 * 1000;
const MIN_VOL_CCY24H = 10_000_000; // Lọc volume > 10 triệu USD

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
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2), 'utf8');
  } catch (e) {
    console.error('Lỗi khi lưu kết quả:', e.message);
  }
}

// ------------------- HÀM TÍNH TOÁN KĨ THUẬT -------------------

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

// ------------------- LỌC THỊ TRƯỜNG BASE -------------------

async function getFilteredMarkets() {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') return { allSwapsCount: 0, volPassedCoins: [] };

    const tickers = res.data.data.filter((item) => item.instId.endsWith('-USDT-SWAP'));
    // Lọc volume 24h > 10 triệu USD (volCcy24h trên cặp USDT-SWAP được tính bằng USDT/USD)
    const volFiltered = tickers.filter((item) => parseFloat(item.volCcy24h || 0) > MIN_VOL_CCY24H);

    const volPassedCoins = volFiltered.map((item) => ({
      instId: item.instId,
      vol24h: parseFloat(item.volCcy24h || 0)
    }));

    return {
      allSwapsCount: tickers.length,
      volPassedCoins
    };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { allSwapsCount: 0, volPassedCoins: [] };
  }
}

// ------------------- LẤY DỮ LIỆU NẾN -------------------

async function getCandles(symbol, bar = '5m', limit = 150) {
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
    console.log('=== BẮT ĐẦU QUÉT THỊ TRƯỜNG OKX ===\n');

    const sentLog = loadSentLog();
    const currentTime = Date.now();
    let hasNewAlert = false;

    // Lọc Volume > 10 triệu USD (Đã bỏ tính UD và bỏ lọc BD24)
    const { allSwapsCount, volPassedCoins } = await getFilteredMarkets();

    let countLongCase1 = 0;
    let countLongCase2 = 0;
    let countShortCase1 = 0;
    let countShortCase2 = 0;

    let countSentLong = 0;
    let countSentShort = 0;

    const matchedList = [];

    console.log(`Số coin ban đầu: ${allSwapsCount}`);
    console.log(`Số coin đạt Volume > 10M USD: ${volPassedCoins.length}\n`);
    console.log('Đang quét kỹ thuật nến 15m và 5m...\n');

    for (const coin of volPassedCoins) {
      const symbol = coin.instId;

      if (!sentLog[symbol]) sentLog[symbol] = {};
      const lastLongSent = sentLog[symbol].longAlert || 0;
      const lastShortSent = sentLog[symbol].shortAlert || 0;

      // Cooldown riêng biệt 12h cho Long và Short
      const isLongCooldown = currentTime - lastLongSent < COOLDOWN_TIME;
      const isShortCooldown = currentTime - lastShortSent < COOLDOWN_TIME;

      // Bỏ qua nếu cả 2 hướng đều đang trong cooldown
      if (isLongCooldown && isShortCooldown) {
        continue;
      }

      // 1. LẤY NẾN 15M (TÍNH DIFFEMA40 VÀ DIFFEMA15)
      const candles15m = await getCandles(symbol, '15m', 150);
      if (!candles15m || candles15m.length < 80) {
        await sleep(50);
        continue;
      }

      const closed15m = candles15m.slice(1).reverse();
      const closedPrices15m = closed15m.map((c) => parseFloat(c[4]));

      // EMA40 trên 15m
      const ema40Series15m = calculateEMAArray(closedPrices15m, 40);
      if (ema40Series15m.length < 40) {
        await sleep(50);
        continue;
      }
      const ema40_n1 = ema40Series15m[ema40Series15m.length - 1];
      const ema40_n40 = ema40Series15m[ema40Series15m.length - 40];
      if (ema40_n40 <= 0) {
        await sleep(50);
        continue;
      }
      const diffema40_15m = ((ema40_n1 - ema40_n40) / ema40_n40) * 100;

      // EMA15 trên 15m
      const ema15Series15m = calculateEMAArray(closedPrices15m, 15);
      if (ema15Series15m.length < 15) {
        await sleep(50);
        continue;
      }
      const ema15_n1 = ema15Series15m[ema15Series15m.length - 1];
      const ema15_n15 = ema15Series15m[ema15Series15m.length - 15];
      if (ema15_n15 <= 0) {
        await sleep(50);
        continue;
      }
      const diffema15_15m = ((ema15_n1 - ema15_n15) / ema15_n15) * 100;

      // 2. LẤY NẾN 5M (XÉT NẾN SỐ 1 VÀ BOLLINGER BANDS)
      const candles5m = await getCandles(symbol, '5m', 60);
      if (!candles5m || candles5m.length < 30) {
        await sleep(50);
        continue;
      }

      // Nến số 1 là nến đã đóng gần nhất (index 1)
      const candle1 = candles5m[1];
      const open1 = parseFloat(candle1[1]);
      const high1 = parseFloat(candle1[2]);
      const low1 = parseFloat(candle1[3]);
      const close1 = parseFloat(candle1[4]);

      const isCandle1Bullish = close1 > open1; // Nến tăng
      const isCandle1Bearish = close1 < open1; // Nến giảm

      // Bollinger Bands tính từ nến [1] về trước 20 nến
      const closesBB = candles5m.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
      const bb = calculateBollingerBands(closesBB, 20);

      if (!bb || bb.lower <= 0 || bb.upper <= 0) {
        await sleep(50);
        continue;
      }

      // Chỉ số Bollinger Bands trên nến 5m
      const bbm = ((low1 - bb.middle) / bb.middle) * 100; // Độ lệch đáy nến so với Middle Band
      const bbd = ((low1 - bb.lower) / bb.lower) * 100;   // Độ lệch đáy nến so với Lower Band
      const bbt = ((high1 - bb.upper) / bb.upper) * 100;  // Độ lệch đỉnh nến so với Upper Band

      let passLongCase1 = false;
      let passLongCase2 = false;
      let passShortCase1 = false;
      let passShortCase2 = false;

      // Kiểm tra Long Trường Hợp 1: 2% < diffema40 < 6%, diffema15 > 3%, bbm < 0%, nến 1 tăng
      if (diffema40_15m > 2 && diffema40_15m < 6 && diffema15_15m > 3 && bbm < 0 && isCandle1Bullish) {
        passLongCase1 = true;
        countLongCase1++;
      }

      // Kiểm tra Long Trường Hợp 2: 2% < diffema40 < 6%, diffema15 < 3%, bbd < 0%, nến 1 tăng
      if (diffema40_15m > 2 && diffema40_15m < 6 && diffema15_15m < 3 && bbd < 0 && isCandle1Bullish) {
        passLongCase2 = true;
        countLongCase2++;
      }

      // Kiểm tra Short Trường Hợp 1: -4% < diffema40 < -1%, diffema15 < -2%, bbm > 0%, nến 1 giảm
      if (diffema40_15m > -4 && diffema40_15m < -1 && diffema15_15m < -2 && bbm > 0 && isCandle1Bearish) {
        passShortCase1 = true;
        countShortCase1++;
      }

      // Kiểm tra Short Trường Hợp 2: -4% < diffema40 < -1%, diffema15 > -2%, bbt > 0%, nến 1 giảm
      if (diffema40_15m > -4 && diffema40_15m < -1 && diffema15_15m > -2 && bbt > 0 && isCandle1Bearish) {
        passShortCase2 = true;
        countShortCase2++;
      }

      let signalType = null;
      let alertKey = null;

      if ((passLongCase1 || passLongCase2) && !isLongCooldown) {
        signalType = 'LONG';
        alertKey = 'longAlert';
      } else if ((passShortCase1 || passShortCase2) && !isShortCooldown) {
        signalType = 'SHORT';
        alertKey = 'shortAlert';
      }

      // Gửi tín hiệu nếu thỏa điều kiện và không bị cooldown
      if (signalType) {
        const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
        const diffema40Str = `${diffema40_15m > 0 ? '+' : ''}${diffema40_15m.toFixed(2)}%`;
        const diffema15Str = `${diffema15_15m > 0 ? '+' : ''}${diffema15_15m.toFixed(2)}%`;

        // Nội dung theo đúng thứ tự: diffema40, diffema15, link
        const message =
          `diffema40 (15m): ${diffema40Str}\n` +
          `diffema15 (15m): ${diffema15Str}\n` +
          `link: ${link}`;

        let isSentSuccess = false;
        try {
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            disable_web_page_preview: true
          });
          isSentSuccess = true;
        } catch (err) {
          console.error(`Lỗi gửi Telegram cho ${symbol}:`, err.message);
        }

        if (isSentSuccess) {
          if (signalType === 'LONG') countSentLong++;
          if (signalType === 'SHORT') countSentShort++;

          sentLog[symbol][alertKey] = currentTime;
          hasNewAlert = true;

          matchedList.push({
            symbol,
            type: signalType,
            diffema40: diffema40Str,
            diffema15: diffema15Str,
            link
          });
        }
      }

      await sleep(50);
    }

    if (hasNewAlert) saveSentLog(sentLog);

    saveScanResults({
      scannedAt: new Date().toISOString(),
      counts: {
        longCase1: countLongCase1,
        longCase2: countLongCase2,
        shortCase1: countShortCase1,
        shortCase2: countShortCase2,
        sentLong: countSentLong,
        sentShort: countSentShort
      },
      matchedList
    });

    // Log số lượng coin thỏa mãn từng điều kiện ra dạng văn bản thuần
    console.log('--- THỐNG KÊ KẾT QUẢ QUÉT ---');
    console.log(`Số coin thỏa mãn điều kiện Long Trường hợp 1: ${countLongCase1} coin.`);
    console.log(`Số coin thỏa mãn điều kiện Long Trường hợp 2: ${countLongCase2} coin.`);
    console.log(`Số coin thỏa mãn điều kiện Short Trường hợp 1: ${countShortCase1} coin.`);
    console.log(`Số coin thỏa mãn điều kiện Short Trường hợp 2: ${countShortCase2} coin.`);
    console.log(`Số tín hiệu Long đã gửi thành công (sau khi trừ Cooldown 12h): ${countSentLong} coin.`);
    console.log(`Số tín hiệu Short đã gửi thành công (sau khi trừ Cooldown 12h): ${countSentShort} coin.`);
    console.log('\n=== HOÀN TẤT TIẾN TRÌNH QUÉT ===');
  } catch (err) {
    console.error('Lỗi trong tiến trình quét:', err.message);
  }
}

main();
