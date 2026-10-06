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

// Cấu hình Cooldown: 12 tiếng
const COOLDOWN_TIME = 12 * 60 * 60 * 1000;
const MIN_VOL_CCY24H = 5_000_000; // Volume 24h > 5 triệu USDT

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
      ud4h: results.ud4h,
      targetCoinsCount: results.targetCoins.length,
      targetCoinsList: results.targetCoins,
      matchedCount: results.matched.length,
      matchedList: results.matched
    };
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(outputData, null, 2), 'utf8');
  } catch (e) {
    console.error('Lỗi khi lưu 24h.json:', e.message);
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
    const volFiltered = tickers.filter((item) => parseFloat(item.volCcy24h || 0) > MIN_VOL_CCY24H);

    const volPassedCoins = [];
    for (const item of volFiltered) {
      const open24h = parseFloat(item.open24h || 0);
      const lastPrice = parseFloat(item.last || 0);
      if (open24h <= 0) continue;

      const change24hVal = ((lastPrice - open24h) / open24h) * 100;

      volPassedCoins.push({
        instId: item.instId,
        open24h,
        last: lastPrice,
        change24hVal: parseFloat(change24hVal.toFixed(2))
      });
    }

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

    // Lấy toàn bộ thị trường thỏa Volume > 5M USDT
    const { allSwapsCount, volPassedCoins } = await getFilteredMarkets();

    // BƯỚC 1: LỌC BD24H SỚM (3% < bd24h < 15% HOẶC -8% < bd24h < -3%)
    const bd24hPassedCoins = volPassedCoins.filter((coin) => {
      const isLongPotential = coin.change24hVal > 3 && coin.change24hVal < 15;
      const isShortPotential = coin.change24hVal > -8 && coin.change24hVal < -3;
      return isLongPotential || isShortPotential;
    });

    const pipelineStats = {
      step0_allSwaps: allSwapsCount,
      step1_volPassed: volPassedCoins.length,
      step2_bd24hPassed: bd24hPassedCoins.length,
      step3_cooldownPassed: 0,
      step4_diffema25Passed: 0,
      step5_diffema50Passed: 0,
      step6_signalMatched: 0
    };

    const diffemaPassedList = [];

    // BƯỚC 2: TÍNH UD (4H) ĐỂ THAM KHẢO VẪN GIỮ TRÊN DANH SÁCH BD24H
    console.log(`⏳ Đang tính chỉ số market UD (4H) trên ${bd24hPassedCoins.length} coin thỏa bd24h...`);
    let totalUp4hCoins = 0;
    let totalDown4hCoins = 0;

    for (const coin of bd24hPassedCoins) {
      const candles4h = await getCandles(coin.instId, '4H', 2);
      if (candles4h && candles4h.length >= 2) {
        const closedCandle = candles4h[1];
        const openPrice = parseFloat(closedCandle[1]);
        const closePrice = parseFloat(closedCandle[4]);

        if (closePrice > openPrice) totalUp4hCoins++;
        else if (closePrice < openPrice) totalDown4hCoins++;
      }
      await sleep(50);
    }

    const marketUD = totalUp4hCoins - totalDown4hCoins;
    const marketUDStr = marketUD > 0 ? `+${marketUD}` : `${marketUD}`;
    console.log(`📈 UD (4H): ${marketUDStr} (Tăng: ${totalUp4hCoins} | Giảm: ${totalDown4hCoins})\n`);

    // --- QUÉT CHI TIẾT TÍN HIỆU THEO TỪNG BƯỚC LỌC ---
    console.log(`⏳ Đang chạy phễu lọc tín hiệu kỹ thuật (Khung 5m) cho ${bd24hPassedCoins.length} coin khả thi...\n`);

    const scanResults = {
      ud4h: marketUDStr,
      targetCoins: bd24hPassedCoins,
      matched: []
    };

    let countMatchedLong = 0;
    let countMatchedShort = 0;

    for (const coin of bd24hPassedCoins) {
      const symbol = coin.instId;
      const potentialType = (coin.change24hVal > 3 && coin.change24hVal < 15) ? 'LONG' : 'SHORT';

      // BƯỚC 3: KIỂM TRA COOLDOWN
      if (!sentLog[symbol]) sentLog[symbol] = {};
      const alertKey = potentialType === 'LONG' ? 'longAlert' : 'shortAlert';
      const lastSentTime = sentLog[symbol][alertKey];
      const isCooldown = currentTime - (lastSentTime || 0) < COOLDOWN_TIME;

      if (isCooldown) {
        continue;
      }
      pipelineStats.step3_cooldownPassed++;

      // BƯỚC 4: LẤY NẾN 5M & LỌC DIFFEMA25 (-1% < diffema25 < 1%)
      const candles5m = await
