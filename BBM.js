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

// Cấu hình Cooldown: 4 TIẾNG
const COOLDOWN_TIME = 4 * 60 * 60 * 1000;
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

// ------------------- HÀM TÍNH TOÁN KỸ THUẬT -------------------

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

function calculateEMAArray(prices, period = 10) {
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

// ------------------- LỌC THỊ TRƯỜNG (VOLUME > 5M & bd24h > 10%) -------------------

async function getFilteredMarkets() {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') return { allSwapsCount: 0, volPassedCount: 0, filteredCoins: [] };

    const tickers = res.data.data.filter((item) => item.instId.endsWith('-USDT-SWAP'));
    const volFiltered = tickers.filter((item) => parseFloat(item.volCcy24h || 0) > MIN_VOL_CCY24H);

    const filteredCoins = [];
    for (const item of volFiltered) {
      const open24h = parseFloat(item.open24h || 0);
      const lastPrice = parseFloat(item.last || 0);
      if (open24h <= 0) continue;

      const change24hVal = ((lastPrice - open24h) / open24h) * 100;
      if (change24hVal > 10) {
        filteredCoins.push({
          instId: item.instId,
          open24h,
          last: lastPrice,
          change24hVal: parseFloat(change24hVal.toFixed(2))
        });
      }
    }

    return {
      allSwapsCount: tickers.length,
      volPassedCount: volFiltered.length,
      filteredCoins
    };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { allSwapsCount: 0, volPassedCount: 0, filteredCoins: [] };
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
    console.log('--- BẮT ĐẦU QUÉT THỊ TRƯỜNG OKX ---');

    const sentLog = loadSentLog();
    const currentTime = Date.now();
    let hasNewAlert = false;

    const { allSwapsCount, volPassedCount, filteredCoins: targetCoins } = await getFilteredMarkets();
    console.log(
      `📊 [Lọc 24h] Tổng USDT Swap: ${allSwapsCount} | Vol > 5M: ${volPassedCount} | Thỏa bd24h > 10%: ${targetCoins.length} coin`
    );

    const scanResults = {
      targetCoins,
      matched: []
    };

    let countValidCandles = 0;

    // Biến đếm thống kê từng điều kiện độc lập
    let countDiffEma10 = 0;
    let countDiffEma30Long = 0;
    let countDiffEma30Short = 0;
    let countHbb = 0;
    let countBbd = 0;
    let countBbt = 0;

    let countMatchedLong = 0;
    let countMatchedShort = 0;

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // 1. Lấy nến 15m
      const candles15m = await getCandles(symbol, '15m', 100);
      if (!candles15m || candles15m.length < 30) {
        await sleep(80);
        continue;
      }

      // 2. Lấy nến 5m
      const candles5m = await getCandles(symbol, '5m', 120);
      if (!candles5m || candles5m.length < 60) {
        await sleep(80);
        continue;
      }
      countValidCandles++;

      // --- TÍNH TOÁN DIFFEMA TRÊN NẾN 5m ---
      const closedCandles5m = candles5m.slice(1).reverse();
      const closedPrices5m = closedCandles5m.map((c) => parseFloat(c[4]));
      const emaSeries5m = calculateEMAArray(closedPrices5m, 10);

      if (emaSeries5m.length < 30) {
        await sleep(80);
        continue;
      }

      const ema1_5m = emaSeries5m[emaSeries5m.length - 1];
      const ema10_5m = emaSeries5m[emaSeries5m.length - 10];
      const ema30_5m = emaSeries5m[emaSeries5m.length - 30];

      if (!ema10_5m || ema10_5m <= 0 || !ema30_5m || ema30_5m <= 0) {
        await sleep(80);
        continue;
      }

      const diffema10_5m = ((ema1_5m - ema10_5m) / ema10_5m) * 100;
      const diffema30_5m = ((ema1_5m - ema30_5m) / ema30_5m) * 100;

      // --- TÍNH TOÁN BOLLINGER BANDS 15m ---
      const closesBB15m = candles15m.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
      const bb15m = calculateBollingerBands(closesBB15m, 20);

      if (!bb15m || bb15m.middle <= 0) {
        await sleep(80);
        continue;
      }

      const hbb15m = bb15m.upper - bb15m.lower;
      const hbb15mPercent = (hbb15m / bb15m.middle) * 100;

      const candle0_15m = candles15m[0];
      const low0 = parseFloat(candle0_15m[3]);
      const high0 = parseFloat(candle0_15m[2]);

      let bbd = 0;
      let bbt = 0;
      if (bb15m.lower > 0) {
        bbd = ((low0 - bb15m.lower) / bb15m.lower) * 100;
      }
      if (bb15m.upper > 0) {
        bbt = ((high0 - bb15m.upper) / bb15m.upper) * 100;
      }

      // --- ĐÁNH GIÁ VÀ ĐẾM TỪNG ĐIỀU KIỆN ĐỘC LẬP ---
      const passDiffEma10 = diffema10_5m > -0.5 && diffema10_5m < 0.5;
      const passDiffEma30Long = diffema30_5m < -2.5;
      const passDiffEma30Short = diffema30_5m > 2.5;
      const passHbb = hbb15mPercent > 3;
      const passBbd = bbd > -2 && bbd < -0.5;
      const passBbt = bbt > 0.5 && bbt < 2;

      if (passDiffEma10) countDiffEma10++;
      if (passDiffEma30Long) countDiffEma30Long++;
      if (passDiffEma30Short) countDiffEma30Short++;
      if (passHbb) countHbb++;
      if (passBbd) countBbd++;
      if (passBbt) countBbt++;

      // --- TÍN HIỆU TỔNG HỢP ---
      const isLong = passDiffEma10 && passDiffEma30Long && passHbb && passBbd;
      const isShort = passDiffEma10 && passDiffEma30Short && passHbb && passBbt;

      if (!isLong && !isShort) {
        await sleep(80);
        continue;
      }

      const signalType = isLong ? 'LONG' : 'SHORT';
      const diffema10Str = diffema10_5m.toFixed(2) + '%';
      const diffema30Str = diffema30_5m.toFixed(2) + '%';
      const change24hStr = `+${coin.change24hVal.toFixed(2)}%`;

      console.log(
        `🎯 [Khớp ENTRY ${signalType}] ${symbol} | diffema10: ${diffema10Str} | diffema30: ${diffema30Str} | Hbb: ${hbb15mPercent.toFixed(2)}% | ${isLong ? `bbd: ${bbd.toFixed(2)}%` : `bbt: ${bbt.toFixed(2)}%`}`
      );

      if (isLong) countMatchedLong++;
      if (isShort) countMatchedShort++;

      const coinName = symbol.replace('-USDT-SWAP', '');
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      if (!sentLog[symbol]) sentLog[symbol] = {};
      const alertKey = isLong ? 'longAlert' : 'shortAlert';
      const lastSentTime = sentLog[symbol][alertKey];
      const isCooldown = currentTime - (lastSentTime || 0) < COOLDOWN_TIME;

      scanResults.matched.push({
        symbol,
        type: signalType,
        change24h: change24hStr,
        diffema10_5m: diffema10Str,
        diffema30_5m: diffema30Str,
        bbd: isLong ? bbd.toFixed(2) + '%' : '-',
        bbt: isShort ? bbt.toFixed(2) + '%' : '-',
        hbb15m: hbb15m.toFixed(4),
        hbb15mPercent: hbb15mPercent.toFixed(2) + '%',
        link,
        teleSent: !isCooldown
      });

      // Gửi cảnh báo Telegram
      if (!isCooldown) {
        const icon = isLong ? '🟢' : '🔴';
        const entryDetail = isLong
          ? `• <b>bbd (15m):</b> ${bbd.toFixed(2)}% (so với Lower BB)`
          : `• <b>bbt (15m):</b> ${bbt.toFixed(2)}% (so với Upper BB)`;

        const message =
          `${icon} <b>TÍN HIỆU ${signalType}: ${coinName}</b>\n` +
          `• <b>Biến động 24h:</b> ${change24hStr}\n` +
          `• <b>diffema10 (5m):</b> ${diffema10Str}\n` +
          `• <b>diffema30 (5m):</b> ${diffema30Str}\n` +
          `${entryDetail}\n` +
          `• <b>Hbb (15m):</b> ${hbb15m.toFixed(4)} (${hbb15mPercent.toFixed(2)}%)\n` +
          `• <a href="${link}">Link OKX</a>`;

        console.log(`🚀 [${signalType}] Gửi Telegram cho ${symbol}...`);
        await axios
          .post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          })
          .catch((err) => console.error('Lỗi gửi Telegram:', err.message));

        sentLog[symbol][alertKey] = currentTime;
        hasNewAlert = true;
      }

      await sleep(80);
    }

    if (hasNewAlert) saveSentLog(sentLog);

    saveScanResults(scanResults);

    console.log('\n================== THỐNG KÊ CHI TIẾT TỪNG ĐIỀU KIỆN ==================');
    console.log(`1️⃣ Tổng nến tải thành công: ${countValidCandles}/${targetCoins.length} coin`);
    console.log('----------------------------------------------------------------------');
    console.table([
      { 'Điều kiện': 'diffema10 (-0.5% ~ 0.5%)', 'Số coin thoả': countDiffEma10 },
      { 'Điều kiện': 'diffema30 < -2.5% (Long)', 'Số coin thoả': countDiffEma30Long },
      { 'Điều kiện': 'diffema30 > 2.5% (Short)', 'Số coin thoả': countDiffEma30Short },
      { 'Điều kiện': 'Hbb 15m > 3%', 'Số coin thoả': countHbb },
      { 'Điều kiện': 'bbd (-2% ~ -0.5%) [Long]', 'Số coin thoả': countBbd },
      { 'Điều kiện': 'bbt (0.5% ~ 2%) [Short]', 'Số coin thoả': countBbt }
    ]);
    console.log('----------------------------------------------------------------------');
    console.log(`🎯 TÍN HIỆU ĐỦ TẤT CẢ ĐIỀU KIỆN: LONG = ${countMatchedLong} coin | SHORT = ${countMatchedShort} coin`);

    console.log('\n================== KẾT QUẢ KHỚP TOÀN BỘ ==================');
    if (scanResults.matched.length > 0) {
      console.table(scanResults.matched);
    } else {
      console.log('Không có coin nào khớp toàn bộ điều kiện vào lệnh.');
    }
    console.log(`📁 File kết quả đã lưu: ${RESULTS_FILE}`);
    console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---\n');
  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
