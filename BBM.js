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

// Cấu hình Cooldown: 8 TIẾNG
const COOLDOWN_TIME = 8 * 60 * 60 * 1000;
const MIN_VOL_CCY24H = 10_000_000; // Volume 24h > 10 triệu USDT
const MIN_DIFF_HBB = 2; // Điều kiện diffhbb tối thiểu 2%
const MAX_DIFF_HBB = 10; // Điều kiện diffhbb tối đa 10%

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

// ------------------- LỌC THỊ TRƯỜNG (VOLUME > 10M) -------------------

async function getVolumeFilteredMarkets() {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') return { allSwapsCount: 0, filteredCoins: [] };

    const tickers = res.data.data.filter((item) => item.instId.endsWith('-USDT-SWAP'));

    const filteredCoins = tickers
      .filter((item) => parseFloat(item.volCcy24h || 0) > MIN_VOL_CCY24H)
      .map((item) => ({
        instId: item.instId,
        open24h: item.open24h,
        last: item.last
      }));

    return { allSwapsCount: tickers.length, filteredCoins };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { allSwapsCount: 0, filteredCoins: [] };
  }
}

// ------------------- LẤY DỮ LIỆU NẾN -------------------

async function getCandles(symbol, bar = '1H', limit = 100) {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 6000 });
    if (!res.data || res.data.code !== '0' || res.data.data.length < 50) return null;
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

    // 1. Lọc Volume > 10M USDT
    const { allSwapsCount, filteredCoins: targetCoins } = await getVolumeFilteredMarkets();
    console.log(`📊 [Lọc 1 - Volume] Tổng USDT Swap: ${allSwapsCount} | Đạt Vol > 10M USDT: ${targetCoins.length} coin`);

    const scanResults = {
      totalScanned: targetCoins.length,
      matched: []
    };

    let countValidCandles = 0;
    let countMatchedDiffHbb = 0;
    let countMatchedLong = 0;
    let countMatchedShort = 0;

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // Cần tối thiểu 70 nến đóng (nến 50 cần 20 nến trước đó: 50 + 19 = nến 69)
      const candles1h = await getCandles(symbol, '1H', 100);
      if (!candles1h || candles1h.length < 75) {
        await sleep(80);
        continue;
      }
      countValidCandles++;

      // ================= BƯỚC 2: TÍNH TOÁN DIFFHBB (NẾN 1 VÀ NẾN 50) =================
      // BB nến 1: dùng 20 nến đóng gần nhất (từ index 1 đến 20)
      const closesBB1 = candles1h.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
      const bb1 = calculateBollingerBands(closesBB1, 20);

      // BB nến 50: dùng 20 nến đóng tính từ nến 50 (từ index 50 đến 69)
      const closesBB50 = candles1h.slice(50, 70).map((c) => parseFloat(c[4])).reverse();
      const bb50 = calculateBollingerBands(closesBB50, 20);

      if (!bb1 || !bb50 || bb1.lower <= 0 || bb50.lower <= 0) {
        await sleep(80);
        continue;
      }

      const hbb1 = ((bb1.upper - bb1.lower) / bb1.lower) * 100;
      const hbb50 = ((bb50.upper - bb50.lower) / bb50.lower) * 100;
      const diffhbb = hbb1 - hbb50;

      // Lọc điều kiện: diffhbb nằm trong khoảng [2%, 10%]
      if (diffhbb < MIN_DIFF_HBB || diffhbb > MAX_DIFF_HBB) {
        await sleep(80);
        continue;
      }
      countMatchedDiffHbb++;

      // ================= BƯỚC 3: TÍNH DIFFEMA15 =================
      const closedCandles = candles1h.slice(1).reverse();
      const closedPrices = closedCandles.map((c) => parseFloat(c[4]));

      const emaSeries = calculateEMAArray(closedPrices, 20);
      if (emaSeries.length < 15) {
        await sleep(80);
        continue;
      }

      const ema1 = emaSeries[emaSeries.length - 1];
      const ema15 = emaSeries[emaSeries.length - 15];

      if (!ema15 || ema15 <= 0) {
        await sleep(80);
        continue;
      }

      const diffema15 = ((ema1 - ema15) / ema15) * 100;

      // ================= BƯỚC 4: TÍNH BBD, BBT VÀ XÉT ĐIỀU KIỆN =================
      const candle0 = candles1h[0];
      const high0 = parseFloat(candle0[2]);
      const low0 = parseFloat(candle0[3]);

      // bbd: % chênh lệch giữa giá thấp nhất nến 0 và dải dưới BB nến 1
      const bbd = ((low0 - bb1.lower) / bb1.lower) * 100;

      // bbt: % chênh lệch giữa giá cao nhất nến 0 và dải trên BB nến 1
      const bbt = ((high0 - bb1.upper) / bb1.upper) * 100;

      // LONG: bbd trong khoảng [-3%, -1%] và diffema15 trong khoảng [-1%, 3%]
      const isLong = diffema15 >= -1 && diffema15 <= 3 && bbd >= -3 && bbd <= -1;

      // SHORT: bbt trong khoảng [1%, 3%] và diffema15 trong khoảng [-3%, 1%]
      const isShort = diffema15 >= -3 && diffema15 <= 1 && bbt >= 1 && bbt <= 3;

      // Nếu không thoả Long hoặc Short thì bỏ qua
      if (!isLong && !isShort) {
        await sleep(80);
        continue;
      }

      // ================= BƯỚC 5: TÍNH BIẾN ĐỘNG 24H (CHỈ CHO COIN ĐÃ THOẢ MÃN) =================
      const open24h = parseFloat(coin.open24h || 0);
      const lastPrice = parseFloat(coin.last || 0);
      const change24hVal = open24h > 0 ? ((lastPrice - open24h) / open24h) * 100 : 0;
      const change24hStr = (change24hVal >= 0 ? '+' : '') + change24hVal.toFixed(2) + '%';

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
        diffhbb: diffhbb.toFixed(2) + '%',
        diffema15: diffema15.toFixed(2) + '%',
        bbd: bbd.toFixed(2) + '%',
        bbt: bbt.toFixed(2) + '%',
        link,
        teleSent: !isCooldown
      });

      if (!isCooldown) {
        const icon = isLong ? '🟢' : '🔴';
        const entryDetail = isLong
          ? `• <b>bbd:</b> ${bbd.toFixed(2)}% (so với Lower BB)`
          : `• <b>bbt:</b> ${bbt.toFixed(2)}% (so với Upper BB)`;

        const message =
          `${icon} <b>TÍN HIỆU ${signalType}: ${coinName}</b>\n` +
          `• <b>Biến động 24h:</b> ${change24hStr}\n` +
          `• <b>diffhbb:</b> +${diffhbb.toFixed(2)}%\n` +
          `• <b>diffema15:</b> ${diffema15.toFixed(2)}%\n` +
          `${entryDetail}\n` +
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

    console.log('\n================== THỐNG KÊ CHI TIẾT ==================');
    console.log(`1️⃣ Thị trường: Tổng Swap = ${allSwapsCount} | Đạt Vol > 10M = ${targetCoins.length}`);
    console.log(`2️⃣ Dữ liệu nến: Tải thành công = ${countValidCandles}/${targetCoins.length}`);
    console.log(`3️⃣ Lọc diffhbb trong [2%, 10%]: Đạt = ${countMatchedDiffHbb} coin`);
    console.log(`4️⃣ Tín hiệu LONG khớp: ${countMatchedLong} coin`);
    console.log(`5️⃣ Tín hiệu SHORT khớp: ${countMatchedShort} coin`);

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
