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
      totalScanned: results.totalScanned,
      passedEmaCount: results.passedEma.length,
      passedEmaList: results.passedEma,
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

// ------------------- LỌC THỊ TRƯỜNG (VOLUME > 5M) -------------------

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
      filteredCoins.push({
        instId: item.instId,
        open24h,
        last: lastPrice,
        change24hVal
      });
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
    if (!res.data || res.data.code !== '0' || res.data.data.length < 60) return null;
    return res.data.data;
  } catch (error) {
    console.error(`Lỗi lấy dữ liệu nến ${bar} (${symbol}):`, error.message);
    return null;
  }
}

// ------------------- TIẾN TRÌNH CHÍNH -------------------

async function main() {
  try {
    console.log('--- BẮT ĐẦU QUÉT THỊ TRƯỜNG OKX (TOÀN BỘ KHUNG 15M) ---');

    const sentLog = loadSentLog();
    const currentTime = Date.now();
    let hasNewAlert = false;

    const { allSwapsCount, volPassedCount, filteredCoins: targetCoins } = await getFilteredMarkets();
    console.log(
      `📊 [Lọc] Tổng USDT Swap: ${allSwapsCount} | Vol > 5M: ${volPassedCount} | Quét: ${targetCoins.length} coin`
    );

    const scanResults = {
      totalScanned: targetCoins.length,
      passedEma: [],
      matched: []
    };

    let countValidCandles = 0;
    let countMatchedEmaLong = 0;
    let countMatchedEmaShort = 0;
    let countMatchedLong = 0;
    let countMatchedShort = 0;

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // 1. Lấy nến 15m
      const candles15m = await getCandles(symbol, '15m', 100);
      if (!candles15m || candles15m.length < 60) {
        await sleep(80);
        continue;
      }
      countValidCandles++;

      // ================= BƯỚC 2: TÍNH DIFFEMA20 TRÊN NẾN 15M =================
      const closedCandles = candles15m.slice(1).reverse();
      const closedPrices = closedCandles.map((c) => parseFloat(c[4]));

      const emaSeries = calculateEMAArray(closedPrices, 20);
      if (emaSeries.length < 20) {
        await sleep(80);
        continue;
      }

      const ema1 = emaSeries[emaSeries.length - 1];
      const ema20 = emaSeries[emaSeries.length - 20];

      if (!ema20 || ema20 <= 0) {
        await sleep(80);
        continue;
      }

      const diffema20 = ((ema1 - ema20) / ema20) * 100;

      // SHORT: -7% < bd24 < -2% VÀ diffema20 > 0.5%
      const isTrendValidShort = coin.change24hVal > -7 && coin.change24hVal < -2 && diffema20 > 0.5;

      // LONG: 2% < bd24 < 7% VÀ diffema20 < -0.5%
      const isTrendValidLong = coin.change24hVal > 2 && coin.change24hVal < 7 && diffema20 < -0.5;

      if (!isTrendValidLong && !isTrendValidShort) {
        await sleep(80);
        continue;
      }

      if (isTrendValidLong) countMatchedEmaLong++;
      if (isTrendValidShort) countMatchedEmaShort++;

      scanResults.passedEma.push({
        symbol,
        change24h: coin.change24hVal.toFixed(2) + '%',
        diffema20: diffema20.toFixed(2) + '%',
        validFor: isTrendValidLong ? 'LONG' : 'SHORT'
      });

      // ================= BƯỚC 3: TÍNH BOLLINGER BANDS NẾN 1 TRÊN 15M =================
      const closesBB1 = candles15m.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
      const bb1 = calculateBollingerBands(closesBB1, 20);

      if (!bb1 || bb1.lower <= 0 || bb1.upper <= 0) {
        await sleep(80);
        continue;
      }

      const candle0 = candles15m[0];
      const high0 = parseFloat(candle0[2]);
      const low0 = parseFloat(candle0[3]);

      // bbd: % chênh lệch giữa giá thấp nhất nến 0 và dải dưới BB nến 1 (15m)
      const bbd = ((low0 - bb1.lower) / bb1.lower) * 100;

      // bbt: % chênh lệch giữa giá cao nhất nến 0 và dải trên BB nến 1 (15m)
      const bbt = ((high0 - bb1.upper) / bb1.upper) * 100;

      // Điều kiện Entry kết hợp
      const isLong = isTrendValidLong && bbd > -2 && bbd < 0.5;
      const isShort = isTrendValidShort && bbt > -0.5 && bbt < 2;

      if (!isLong && !isShort) {
        await sleep(80);
        continue;
      }

      // ================= BƯỚC 4: TÍNH HBB TRÊN 15M =================
      const hbb = bb1.upper - bb1.lower;
      const hbbPercent = bb1.middle > 0 ? (hbb / bb1.middle) * 100 : 0;

      const change24hStr = (coin.change24hVal >= 0 ? '+' : '') + coin.change24hVal.toFixed(2) + '%';
      const signalType = isLong ? 'LONG' : 'SHORT';
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
        diffema20: diffema20.toFixed(2) + '%',
        bbd: bbd.toFixed(2) + '%',
        bbt: bbt.toFixed(2) + '%',
        hbb15m: hbb.toFixed(4),
        hbbPercent15m: hbbPercent.toFixed(2) + '%',
        link,
        teleSent: !isCooldown
      });

      if (!isCooldown) {
        const icon = isLong ? '🟢' : '🔴';
        const entryDetail = isLong
          ? `• <b>bbd:</b> ${bbd.toFixed(2)}% (so với Lower BB 15m)`
          : `• <b>bbt:</b> ${bbt.toFixed(2)}% (so với Upper BB 15m)`;

        const message =
          `${icon} <b>TÍN HIỆU ${signalType} (15m): ${coinName}</b>\n` +
          `• <b>Biến động 24h:</b> ${change24hStr}\n` +
          `• <b>diffema20:</b> ${diffema20.toFixed(2)}%\n` +
          `${entryDetail}\n` +
          `• <b>Hbb 15m (Độ rộng BB):</b> ${hbb.toFixed(4)} (${hbbPercent.toFixed(2)}%)\n` +
          `• <a href="${link}">Link OKX</a>`;

        console.log(`🚀 [${signalType} 15m] Gửi Telegram cho ${symbol}...`);
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

    console.log('\n================== THỐNG KÊ CHI TIẾT (15M) ==================');
    console.log(`1️⃣ Thị trường: Tổng Swap = ${allSwapsCount} | Vol > 5M = ${volPassedCount}`);
    console.log(`2️⃣ Dữ liệu nến 15m: Tải thành công = ${countValidCandles}/${targetCoins.length}`);
    console.log(`3️⃣ Lọc Xu hướng Long (2% < bd24 < 7% & diffema20 < -0.5%): ${countMatchedEmaLong} coin`);
    console.log(`   Lọc Xu hướng Short (-7% < bd24 < -2% & diffema20 > 0.5%): ${countMatchedEmaShort} coin`);
    console.log(`4️⃣ Tín hiệu LONG khớp (-2% < bbd < 0.5%): ${countMatchedLong} coin`);
    console.log(`5️⃣ Tín hiệu SHORT khớp (-0.5% < bbt < 2%): ${countMatchedShort} coin`);

    console.log('\n================== KẾT QUẢ QUÉT ==================');
    if (scanResults.matched.length > 0) {
      console.table(scanResults.matched);
    } else {
      console.log('Không có coin nào thỏa mãn điều kiện.');
    }
    console.log(`📁 File kết quả đã lưu: ${RESULTS_FILE}`);
    console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---\n');
  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
