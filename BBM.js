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

// Cấu hình Cooldown: 4 tiếng
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

// ------------------- LỌC THỊ TRƯỜNG (VOL > 5M & THỎA ĐIỀU KIỆN 24H) -------------------

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

      // Long cần > 10%, Short cần trong khoảng (-5%, 10%)
      const isEligibleLong = change24hVal > 10;
      const isEligibleShort = change24hVal > -5 && change24hVal < 10;

      if (isEligibleLong || isEligibleShort) {
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

async function getCandles(symbol, bar = '5m', limit = 100) {
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
      `📊 Tổng USDT Swap: ${allSwapsCount} | Vol > 5M: ${volPassedCount} | Thỏa điều kiện bd24h: ${targetCoins.length} coin`
    );

    const scanResults = {
      targetCoins,
      matched: []
    };

    let countValidCandles = 0;

    // Đếm độc lập từng điều kiện
    let countHbbFilter = 0;

    let countBd24Long = 0;
    let countDiffEma40Long = 0;
    let countBbdLong = 0;
    let countBd5Long = 0;

    let countBd24Short = 0;
    let countDiffEma40Short = 0;
    let countBbtShort = 0;
    let countBd5Short = 0;

    let countMatchedLong = 0;
    let countMatchedShort = 0;

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      const candles5m = await getCandles(symbol, '5m', 100);
      if (!candles5m || candles5m.length < 65) {
        await sleep(80);
        continue;
      }
      countValidCandles++;

      // Dữ liệu nến số 1 vừa đóng [ts, open, high, low, close, ...]
      const candle1 = candles5m[1];
      const open1 = parseFloat(candle1[1]);
      const high1 = parseFloat(candle1[2]);
      const low1 = parseFloat(candle1[3]);
      const close1 = parseFloat(candle1[4]);

      // Biến động nến 5m vừa đóng (bd5)
      const bd5 = open1 > 0 ? ((close1 - open1) / open1) * 100 : 0;

      // --- 1. BOLLINGER BANDS (20) TRÊN NẾN 5m SỐ 1 VỪA ĐÓNG (candles5m[1..20]) ---
      const closesBB5m = candles5m.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
      const bb5m = calculateBollingerBands(closesBB5m, 20);

      if (!bb5m || bb5m.lower <= 0 || bb5m.upper <= 0 || bb5m.middle <= 0) {
        await sleep(80);
        continue;
      }

      // bbd: % chênh lệch giá thấp nhất của NẾN SỐ 1 VỪA ĐÓNG với BB dưới
      const bbd = ((low1 - bb5m.lower) / bb5m.lower) * 100;
      // bbt: % chênh lệch giá cao nhất của NẾN SỐ 1 VỪA ĐÓNG với BB trên
      const bbt = ((high1 - bb5m.upper) / bb5m.upper) * 100;

      // Hbb: Độ rộng dải Bollinger Band nến số 1 tính theo %
      const hbbPercent = ((bb5m.upper - bb5m.lower) / bb5m.middle) * 100;

      // --- 2. EMA20 VÀ diffema40 TRÊN NẾN 5m ---
      const allClosedCandles = candles5m.slice(1).reverse();
      const closedPrices = allClosedCandles.map((c) => parseFloat(c[4]));
      const emaSeries5m = calculateEMAArray(closedPrices, 20);

      if (emaSeries5m.length < 40) {
        await sleep(80);
        continue;
      }

      const ema20_n1 = emaSeries5m[emaSeries5m.length - 1];
      const ema20_n40 = emaSeries5m[emaSeries5m.length - 40];

      if (!ema20_n40 || ema20_n40 <= 0) {
        await sleep(80);
        continue;
      }

      const diffema40 = ((ema20_n1 - ema20_n40) / ema20_n40) * 100;

      // Điều kiện lọc chung Hbb > 3%
      const passHbb = hbbPercent > 3;
      if (passHbb) countHbbFilter++;

      // Đánh giá từng điều kiện
      const passBd24Long = coin.change24hVal > 10;
      const passDiffEma40Long = diffema40 > 3;
      const passBbdLong = bbd < 0;
      const passBd5Long = bd5 > -1;

      const passBd24Short = coin.change24hVal > -5 && coin.change24hVal < 10;
      const passDiffEma40Short = diffema40 < -2;
      const passBbtShort = bbt > 0;
      const passBd5Short = bd5 < 1;

      if (passBd24Long) countBd24Long++;
      if (passDiffEma40Long) countDiffEma40Long++;
      if (passBbdLong) countBbdLong++;
      if (passBd5Long) countBd5Long++;

      if (passBd24Short) countBd24Short++;
      if (passDiffEma40Short) countDiffEma40Short++;
      if (passBbtShort) countBbtShort++;
      if (passBd5Short) countBd5Short++;

      // Tín hiệu kết hợp
      const isLong = passHbb && passBd24Long && passDiffEma40Long && passBbdLong && passBd5Long;
      const isShort = passHbb && passBd24Short && passDiffEma40Short && passBbtShort && passBd5Short;

      if (!isLong && !isShort) {
        await sleep(80);
        continue;
      }

      const signalType = isLong ? 'LONG' : 'SHORT';
      const change24hStr = `${coin.change24hVal > 0 ? '+' : ''}${coin.change24hVal.toFixed(2)}%`;
      const diffema40Str = `${diffema40 > 0 ? '+' : ''}${diffema40.toFixed(2)}%`;
      const hbbStr = `${hbbPercent.toFixed(2)}%`;
      const bd5Str = `${bd5 > 0 ? '+' : ''}${bd5.toFixed(2)}%`;

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
        Hbb: hbbStr,
        diffema40: diffema40Str,
        bd24h: change24hStr,
        bd5: bd5Str,
        link,
        teleSent: !isCooldown
      });

      // Gửi Telegram
      if (!isCooldown) {
        const icon = isLong ? '🟢' : '🔴';
        const message =
          `${icon} <b>TÍN HIỆU ${signalType}: ${coinName}</b>\n` +
          `• <b>Hbb (5m):</b> ${hbbStr}\n` +
          `• <b>bd5 (nến vừa đóng):</b> ${bd5Str}\n` +
          `• <b>diffema40:</b> ${diffema40Str}\n` +
          `• <b>bd24h:</b> ${change24hStr}\n` +
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

    // Bảng thống kê chi tiết
    console.log('\n--- THỐNG KÊ SỐ LƯỢNG COIN THỎA ĐIỀU KIỆN ---');
    console.log(`Số coin tải nến 5m thành công: ${countValidCandles}/${targetCoins.length}`);
    console.table([
      { 'Điều kiện': 'Hbb > 3% (Bộ lọc chung)', 'Số lượng': countHbbFilter },
      { 'Điều kiện': 'bd24h > 10% (Long)', 'Số lượng': countBd24Long },
      { 'Điều kiện': 'diffema40 > 3% (Long)', 'Số lượng': countDiffEma40Long },
      { 'Điều kiện': 'bbd < 0 (Long)', 'Số lượng': countBbdLong },
      { 'Điều kiện': 'bd5 > -1% (Long)', 'Số lượng': countBd5Long },
      { 'Điều kiện': '-5% < bd24h < 10% (Short)', 'Số lượng': countBd24Short },
      { 'Điều kiện': 'diffema40 < -2% (Short)', 'Số lượng': countDiffEma40Short },
      { 'Điều kiện': 'bbt > 0 (Short)', 'Số lượng': countBbtShort },
      { 'Điều kiện': 'bd5 < 1% (Short)', 'Số lượng': countBd5Short },
      { 'Điều kiện': 'KHỚP TẤT CẢ LONG', 'Số lượng': countMatchedLong },
      { 'Điều kiện': 'KHỚP TẤT CẢ SHORT', 'Số lượng': countMatchedShort }
    ]);

    if (scanResults.matched.length > 0) {
      console.table(scanResults.matched);
    } else {
      console.log('Không có coin nào thỏa mãn tất cả tiêu chí.');
    }

    console.log(`📁 File kết quả đã lưu: ${RESULTS_FILE}`);
    console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---\n');
  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
