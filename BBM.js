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

// Tính mảng EMA theo thứ tự thời gian cũ -> mới
function calculateEMAArray(prices, period = 20) {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const emaArray = [];

  // Khởi tạo SMA ban đầu
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
    if (!res.data || res.data.code !== '0') return [];

    const tickers = res.data.data.filter((item) => item.instId.endsWith('-USDT-SWAP'));

    return tickers
      .map((item) => {
        const last = parseFloat(item.last || 0);
        const open24h = parseFloat(item.open24h || 0);
        const change24h = open24h > 0 ? ((last - open24h) / open24h) * 100 : 0;
        return {
          instId: item.instId,
          lastPrice: last,
          change24h: change24h,
          volCcy24h: parseFloat(item.volCcy24h || 0)
        };
      })
      .filter((c) => c.volCcy24h > MIN_VOL_CCY24H);
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return [];
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
    const targetCoins = await getVolumeFilteredMarkets();
    console.log(`📊 [Bước 1] Thỏa điều kiện Vol > 10M USDT: ${targetCoins.length} coin`);

    const scanResults = {
      totalScanned: targetCoins.length,
      matched: []
    };

    let validCandlesCount = 0;
    let shortCount = 0;

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // Lấy dữ liệu nến 1H (limit 100 nến để tính EMA mượt)
      const candles1h = await getCandles(symbol, '1H', 100);
      if (!candles1h || candles1h.length < 60) {
        await sleep(80);
        continue;
      }
      validCandlesCount++;

      // ================= BƯỚC 2: TÍNH BOLLINGER BANDS (20 nến đóng gần nhất: index 1 đến 20) =================
      const closesBB = candles1h.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
      const bbCurrent = calculateBollingerBands(closesBB, 20);

      if (!bbCurrent || bbCurrent.lower <= 0 || !bbCurrent.upper) {
        await sleep(80);
        continue;
      }

      // ================= BƯỚC 3: TÍNH EMA20 VÀ diffema20 =================
      // Lấy toàn bộ nến đã đóng từ index 1 trở về trước, đảo ngược thứ tự thành [cũ -> mới]
      const closedCandles = candles1h.slice(1).reverse();
      const closedPrices = closedCandles.map((c) => parseFloat(c[4]));

      const emaSeries = calculateEMAArray(closedPrices, 20);
      if (emaSeries.length < 20) {
        await sleep(80);
        continue;
      }

      // Nến 1 (vừa đóng) là phần tử cuối cùng
      const ema1 = emaSeries[emaSeries.length - 1];
      // Nến 20 lùi lại 19 bước so với nến 1
      const ema20 = emaSeries[emaSeries.length - 20];

      if (!ema20 || ema20 <= 0) {
        await sleep(80);
        continue;
      }

      // diffema20: % chênh lệch giữa EMA nến 1 so với EMA nến 20
      const diffema20 = ((ema1 - ema20) / ema20) * 100;

      // Điều kiện lọc EMA: -3% < diffema20 < -1%
      if (diffema20 <= -3 || diffema20 >= -1) {
        await sleep(80);
        continue;
      }

      // ================= BƯỚC 4: TÍNH bbt1h VÀ XÉT ĐIỀU KIỆN SHORT =================
      const currentCandle0 = candles1h[0];
      const high0 = parseFloat(currentCandle0[2]); // Giá cao nhất nến 0

      // % chênh lệch High nến 0 so với Upper Band
      const bbt1h = ((high0 - bbCurrent.upper) / bbCurrent.upper) * 100;

      // Điều kiện kích hoạt Short: 0% < bbt1h < 3%
      const isShort = bbt1h > 0 && bbt1h < 3;

      if (isShort) {
        shortCount++;
        const coinName = symbol.replace('-USDT-SWAP', '');
        const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

        if (!sentLog[symbol]) sentLog[symbol] = {};
        const lastSentTime = sentLog[symbol].shortAlert;
        const isCooldown = currentTime - (lastSentTime || 0) < COOLDOWN_TIME;

        scanResults.matched.push({
          symbol,
          type: 'SHORT',
          high0,
          ema1: ema1.toFixed(4),
          ema20: ema20.toFixed(4),
          diffema20: diffema20.toFixed(2) + '%',
          bbt1h: bbt1h.toFixed(2) + '%',
          change24h: coin.change24h.toFixed(2) + '%',
          teleSent: !isCooldown
        });

        if (!isCooldown) {
          const message =
            `🔴 <b>TÍN HIỆU SHORT (1H): ${coinName}</b>\n` +
            `• <b>High nến 0:</b> ${high0}\n` +
            `• <b>EMA20 (Nến 1):</b> ${ema1.toFixed(4)}\n` +
            `• <b>EMA20 (Nến 20):</b> ${ema20.toFixed(4)}\n` +
            `• <b>diffema20:</b> ${diffema20.toFixed(2)}%\n` +
            `• <b>bbt1h (High vs Upper):</b> +${bbt1h.toFixed(2)}%\n` +
            `• <b>Biến động 24h:</b> ${coin.change24h >= 0 ? '+' : ''}${coin.change24h.toFixed(2)}%\n` +
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

    console.log('\n================== TIẾN TRÌNH LỌC CHI TIẾT ==================');
    console.log(`🔹 [Bước 1] Nến 1H tải thành công: ${validCandlesCount}/${targetCoins.length} coin`);
    console.log(`🔹 [Bước 2] Tín hiệu Short khớp: ${scanResults.matched.length}`);

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
