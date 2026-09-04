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
const MIN_HBB = 4; // Điều kiện mới: Hbb > 4%

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
      .map((item) => ({
        instId: item.instId,
        volCcy24h: parseFloat(item.volCcy24h || 0)
      }))
      .filter((c) => c.volCcy24h > MIN_VOL_CCY24H);

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

    // Các biến đếm từng bước lọc
    let countValidCandles = 0;
    let countValidBB = 0;
    let countMatchedHbb = 0;
    let countValidEMA = 0;
    let countMatchedDiffEma = 0;
    let countMatchedShort = 0;

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // 2. Lấy dữ liệu nến 1H
      const candles1h = await getCandles(symbol, '1H', 100);
      if (!candles1h || candles1h.length < 60) {
        await sleep(80);
        continue;
      }
      countValidCandles++;

      // ================= BƯỚC 2: TÍNH BOLLINGER BANDS (20 nến: 1 đến 20) =================
      const closesBB = candles1h.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
      const bbCurrent = calculateBollingerBands(closesBB, 20);

      if (!bbCurrent || !bbCurrent.upper || bbCurrent.lower <= 0) {
        await sleep(80);
        continue;
      }
      countValidBB++;

      // Độ rộng dải Bollinger Bands (%)
      const Hbb = ((bbCurrent.upper - bbCurrent.lower) / bbCurrent.lower) * 100;

      // Điều kiện lọc Hbb: Hbb > 4%
      if (Hbb <= MIN_HBB) {
        await sleep(80);
        continue;
      }
      countMatchedHbb++;

      // ================= BƯỚC 3: TÍNH EMA20 VÀ diffema20 =================
      const closedCandles = candles1h.slice(1).reverse();
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
      countValidEMA++;

      // diffema20: % chênh lệch giữa EMA nến 1 và EMA nến 20
      const diffema20 = ((ema1 - ema20) / ema20) * 100;

      // Điều kiện lọc EMA: -4% < diffema20 < 0%
      if (diffema20 <= -4 || diffema20 >= 0) {
        await sleep(80);
        continue;
      }
      countMatchedDiffEma++;

      // ================= BƯỚC 4: TÍNH bbt1h VÀ XÉT ĐIỀU KIỆN SHORT =================
      const currentCandle0 = candles1h[0];
      const high0 = parseFloat(currentCandle0[2]); // High nến 0
      const bbt1h = ((high0 - bbCurrent.upper) / bbCurrent.upper) * 100;

      // Điều kiện Short: 0% < bbt1h < 3%
      const isShort = bbt1h > 0 && bbt1h < 3;

      if (isShort) {
        countMatchedShort++;
        const coinName = symbol.replace('-USDT-SWAP', '');
        const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

        if (!sentLog[symbol]) sentLog[symbol] = {};
        const lastSentTime = sentLog[symbol].shortAlert;
        const isCooldown = currentTime - (lastSentTime || 0) < COOLDOWN_TIME;

        scanResults.matched.push({
          symbol,
          type: 'SHORT',
          Hbb: Hbb.toFixed(2) + '%',
          bbt1h: bbt1h.toFixed(2) + '%',
          diffema20: diffema20.toFixed(2) + '%',
          link,
          teleSent: !isCooldown
        });

        if (!isCooldown) {
          const message =
            `🔴 <b>TÍN HIỆU SHORT: ${coinName}</b>\n` +
            `• <b>Hbb:</b> ${Hbb.toFixed(2)}%\n` +
            `• <b>bbt1h:</b> +${bbt1h.toFixed(2)}%\n` +
            `• <b>diffema:</b> ${diffema20.toFixed(2)}%\n` +
            `• <a href="${link}">Link OKX</a>`;

          console.log(`🚀 [SHORT] Gửi Telegram cho ${symbol}...`);
          await axios
            .post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
              chat_id: TELEGRAM_CHAT_ID,
              text: message,
              parse_mode: 'HTML',
              disable_web_page_preview: true
            })
            .catch((err) => console.error('Lỗi gửi Telegram:', err.message));

          sentLog[symbol].shortAlert = currentTime;
          hasNewAlert = true;
        }
      }

      await sleep(80);
    }

    if (hasNewAlert) saveSentLog(sentLog);

    saveScanResults(scanResults);

    console.log('\n================== THỐNG KÊ CHI TIẾT TỪNG BỘ LỌC ==================');
    console.log(`1️⃣  Thị trường: Tổng Swap = ${allSwapsCount} | Đạt Vol > 10M = ${targetCoins.length}`);
    console.log(`2️⃣  Dữ liệu nến 1H: Đủ nến tải về = ${countValidCandles}/${targetCoins.length}`);
    console.log(`3️⃣  Bollinger Bands: Tính toán thành công = ${countValidBB}`);
    console.log(`4️⃣  Lọc Biên độ BB: Hbb > 4% = ${countMatchedHbb} coin`);
    console.log(`5️⃣  EMA20: Tính toán thành công = ${countValidEMA}`);
    console.log(`6️⃣  Lọc Trend: -4% < diffema20 < 0% = ${countMatchedDiffEma} coin`);
    console.log(`7️⃣  Lọc Entry: 0% < bbt1h < 3% (Khớp Short) = ${countMatchedShort} coin`);

    console.log('\n================== KẾT QUẢ QUÉT ==================');
    if (scanResults.matched.length > 0) {
      console.table(scanResults.matched);
    } else {
      console.log('Không có coin nào thỏa mãn điều kiện Short.');
    }
    console.log(`📁 File kết quả đã lưu: ${RESULTS_FILE}`);
    console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---\n');
  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
