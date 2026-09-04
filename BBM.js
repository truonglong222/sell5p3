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

// Cấu hình Cooldown & Tối ưu luồng
const COOLDOWN_TIME = 8 * 60 * 60 * 1000;
const MIN_VOL_CCY24H = 10_000_000; // Volume 24h > 10M USDT
const CONCURRENCY_LIMIT = 8;        // Quét song song 8 coin cùng lúc (an toàn rate limit OKX)
const BATCH_DELAY = 120;            // Nghỉ 120ms giữa mỗi đợt quét

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
  for (let i = 0; i < period; i++) initialSma += prices[i];
  let prevEma = initialSma / period;
  emaArray.push(prevEma);

  for (let i = period; i < prices.length; i++) {
    const currentEma = prices[i] * k + prevEma * (1 - k);
    emaArray.push(currentEma);
    prevEma = currentEma;
  }
  return emaArray;
}

// ------------------- API CALLS -------------------

async function getVolumeFilteredMarkets() {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 8000 });
    if (!res.data || res.data.code !== '0') return [];

    return res.data.data
      .filter((item) => item.instId.endsWith('-USDT-SWAP'))
      .map((item) => ({
        instId: item.instId,
        volCcy24h: parseFloat(item.volCcy24h || 0)
      }))
      .filter((c) => c.volCcy24h > MIN_VOL_CCY24H);
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return [];
  }
}

async function getCandles(symbol, bar = '1H', limit = 100) {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 4000 }); // Rút timeout xuống 4s để tránh bị treo
    if (!res.data || res.data.code !== '0' || res.data.data.length < 50) return null;
    return res.data.data;
  } catch {
    return null;
  }
}

// ------------------- PHÂN TÍCH TỪNG COIN -------------------

async function analyzeCoin(coin, sentLog, currentTime) {
  const symbol = coin.instId;
  const candles1h = await getCandles(symbol, '1H', 100);
  if (!candles1h || candles1h.length < 60) return null;

  // 1. Bollinger Bands
  const closesBB = candles1h.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
  const bbCurrent = calculateBollingerBands(closesBB, 20);
  if (!bbCurrent || !bbCurrent.upper || bbCurrent.lower <= 0) return null;

  const Hbb = ((bbCurrent.upper - bbCurrent.lower) / bbCurrent.lower) * 100;

  // 2. EMA20 & diffema20
  const closedCandles = candles1h.slice(1).reverse();
  const closedPrices = closedCandles.map((c) => parseFloat(c[4]));
  const emaSeries = calculateEMAArray(closedPrices, 20);
  if (emaSeries.length < 20) return null;

  const ema1 = emaSeries[emaSeries.length - 1];
  const ema20 = emaSeries[emaSeries.length - 20];
  if (!ema20 || ema20 <= 0) return null;

  const diffema20 = ((ema1 - ema20) / ema20) * 100;

  // Điều kiện lọc EMA: -6% < diffema20 < -3%
  if (diffema20 <= -6 || diffema20 >= -3) return null;

  // 3. Điều kiện bbt1h: 0% < bbt1h < 3%
  const high0 = parseFloat(candles1h[0][2]);
  const bbt1h = ((high0 - bbCurrent.upper) / bbCurrent.upper) * 100;

  if (bbt1h <= 0 || bbt1h >= 3) return null;

  const coinName = symbol.replace('-USDT-SWAP', '');
  const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
  const lastSentTime = sentLog[symbol]?.shortAlert;
  const isCooldown = currentTime - (lastSentTime || 0) < COOLDOWN_TIME;

  const matchData = {
    symbol,
    type: 'SHORT',
    Hbb: Hbb.toFixed(2) + '%',
    bbt1h: bbt1h.toFixed(2) + '%',
    diffema20: diffema20.toFixed(2) + '%',
    link,
    teleSent: !isCooldown
  };

  // Gửi Telegram nếu hết cooldown
  if (!isCooldown) {
    const message =
      `🔴 <b>TÍN HIỆU SHORT: ${coinName}</b>\n` +
      `• <b>Hbb:</b> ${Hbb.toFixed(2)}%\n` +
      `• <b>bbt1h:</b> +${bbt1h.toFixed(2)}%\n` +
      `• <b>diffema:</b> ${diffema20.toFixed(2)}%\n` +
      `• <a href="${link}">Link OKX</a>`;

    try {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
      matchData.justSent = true;
    } catch (err) {
      console.error(`Lỗi gửi Telegram cho ${symbol}:`, err.message);
    }
  }

  return matchData;
}

// ------------------- TIẾN TRÌNH CHÍNH -------------------

async function main() {
  const startTime = Date.now();
  console.log('--- BẮT ĐẦU QUÉT THỊ TRƯỜNG OKX ---');

  try {
    const sentLog = loadSentLog();
    const currentTime = Date.now();
    let hasNewAlert = false;

    // Lọc volume
    const targetCoins = await getVolumeFilteredMarkets();
    console.log(`📊 Khối lượng > 10M USDT: ${targetCoins.length} coin. Đang quét song song...`);

    const matchedList = [];

    // Chạy song song theo Batch (mỗi đợt 8 coin)
    for (let i = 0; i < targetCoins.length; i += CONCURRENCY_LIMIT) {
      const batch = targetCoins.slice(i, i + CONCURRENCY_LIMIT);
      const results = await Promise.all(batch.map((coin) => analyzeCoin(coin, sentLog, currentTime)));

      for (const res of results) {
        if (res) {
          matchedList.push(res);
          if (res.justSent) {
            if (!sentLog[res.symbol]) sentLog[res.symbol] = {};
            sentLog[res.symbol].shortAlert = currentTime;
            hasNewAlert = true;
          }
        }
      }

      await sleep(BATCH_DELAY);
    }

    if (hasNewAlert) saveSentLog(sentLog);

    saveScanResults({
      totalScanned: targetCoins.length,
      matched: matchedList
    });

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n================== KẾT QUẢ QUÉT ==================');
    console.log(`⏱ Thời gian hoàn thành: ${totalSeconds}s`);
    console.log(`🔹 Tín hiệu Short khớp: ${matchedList.length}`);

    if (matchedList.length > 0) {
      console.table(matchedList);
    } else {
      console.log('Không có coin nào thỏa mãn điều kiện Short.');
    }
    console.log(`📁 File kết quả đã lưu: ${RESULTS_FILE}`);
    console.log('--- HOÀN THÀNH ---\n');
  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
