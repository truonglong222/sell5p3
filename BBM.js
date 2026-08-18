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
const TOP_GAINERS_LIMIT = 20; // Top 20 coin tăng mạnh nhất

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
      if (timeData._short15m && now - timeData._short15m < COOLDOWN_TIME) {
        temp._short15m = timeData._short15m;
      }
      if (timeData._shortFast15m && now - timeData._shortFast15m < COOLDOWN_TIME) {
        temp._shortFast15m = timeData._shortFast15m;
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

// ------------------- HÀM TÍNH BOLLINGER BANDS -------------------
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

// ------------------- HÀM TÍNH CHUỖI EMA -------------------
// prices: mảng giá theo thứ tự thời gian tăng dần [cũ nhất -> mới nhất]
function calculateEMAArray(prices, period = 20) {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const emaArray = [];

  // Tính SMA cho chu kỳ đầu tiên
  let initialSum = 0;
  for (let i = 0; i < period; i++) {
    initialSum += prices[i];
  }
  let prevEMA = initialSum / period;
  emaArray.push(prevEMA);

  // Tính EMA cho các nến tiếp theo
  for (let i = period; i < prices.length; i++) {
    const currentEMA = (prices[i] * k) + (prevEMA * (1 - k));
    emaArray.push(currentEMA);
    prevEMA = currentEMA;
  }

  return emaArray;
}

// ------------------- LẤY TOP 20 COIN TĂNG MẠNH NHẤT 24H -------------------
async function getTopGainers() {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') return [];

    const tickers = res.data.data;
    
    const swapTickers = tickers.filter(item => item.instId.endsWith('-USDT-SWAP'))
      .map(item => {
        const last = parseFloat(item.last || 0);
        const open24h = parseFloat(item.open24h || 0);
        const change24h = open24h > 0 ? ((last - open24h) / open24h) * 100 : 0;
        return {
          instId: item.instId,
          lastPrice: last,
          change24h: change24h,
          volCcy24h: parseFloat(item.volCcy24h || 0)
        };
      });

    swapTickers.sort((a, b) => b.change24h - a.change24h);
    return swapTickers.slice(0, TOP_GAINERS_LIMIT);
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return [];
  }
}

// ------------------- LẤY DỮ LIỆU NẾN 15M -------------------
async function getCandleData15m(symbol) {
  try {
    // Lấy 60 nến để tính EMA20 chính xác cho 20 nến gần nhất
    const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=60`;
    const res = await axios.get(url, { timeout: 5000 });

    if (!res.data || res.data.code !== '0' || res.data.data.length < 40) return null;
    return res.data.data;
  } catch (error) {
    console.error(`Lỗi lấy dữ liệu nến 15m (${symbol}):`, error.message);
    return null;
  }
}

// ------------------- KIỂM TRA CÁC ĐIỀU KIỆN SHORT -------------------
function evaluateSignals(raw15m) {
  if (!raw15m || raw15m.length < 40) return { normalShort: null, fastShort: null };

  const openPrice0 = parseFloat(raw15m[0][1]); // Giá mở nến 15m hiện tại
  const highPrice0 = parseFloat(raw15m[0][2]); // Giá cao nhất nến 15m hiện tại

  // Chuẩn bị mảng giá đóng cửa từ cũ -> mới
  const closedAsc = raw15m.slice().reverse().map(c => parseFloat(c[4]));
  
  // 1. Tính Bollinger Bands nến hiện tại (phục vụ Short Nhanh)
  const closedForBB0 = raw15m.slice(0, 20).reverse().map(c => parseFloat(c[4]));
  const bb0 = calculateBollingerBands(closedForBB0, 20);

  let normalShort = null;
  let fastShort = null;

  // NHÁNH 1: Short nhanh (diffbbo > 1%)
  if (bb0 && bb0.upper > 0) {
    const diffbbo = ((openPrice0 - bb0.upper) / bb0.upper) * 100;
    if (diffbbo > 1) {
      fastShort = { diffbbo };
    }
  }

  // NHÁNH 2: Short EMA
  const emaSeries = calculateEMAArray(closedAsc, 20);
  if (emaSeries.length >= 20) {
    // 20 giá trị EMA20 gần nhất kết thúc ở nến hiện tại
    const last20EMA = emaSeries.slice(-20);
    const currentEMA20 = last20EMA[last20EMA.length - 1];
    const maxEMA20 = Math.max(...last20EMA);

    if (currentEMA20 > 0) {
      // diffema20: chênh lệch giữa EMA hiện tại và EMA max trong 20 nến
      const diffema20 = ((currentEMA20 - maxEMA20) / currentEMA20) * 100;
      
      // diffema15m: chênh lệch % giữa High nến hiện tại và EMA20 hiện tại
      const diffema15m = ((highPrice0 - currentEMA20) / currentEMA20) * 100;

      const isMatchDiffEMA20 = diffema20 < -4;
      const isMatchDiffEMA15m = diffema15m > -0.5 && diffema15m < 1;

      if (isMatchDiffEMA20 && isMatchDiffEMA15m) {
        normalShort = {
          diffema20,
          diffema15m
        };
      }
    }
  }

  return { normalShort, fastShort };
}

// ------------------- TIẾN TRÌNH CHÍNH -------------------
async function main() {
  try {
    console.log('--- BẮT ĐẦU QUÉT TOP 20 COIN TĂNG TRƯỞNG CHO TÍN HIỆU SHORT ---');

    const sentLog = loadSentLog();
    const currentTime = Date.now();
    let hasNewAlert = false;

    const scanResults = {
      totalScanned: 0,
      matched: []
    };

    // BƯỚC 1: Lấy Top 20 coin tăng mạnh nhất 24h
    const topCoins = await getTopGainers();
    scanResults.totalScanned = topCoins.length;
    console.log(`📋 Đã lấy Top ${topCoins.length} coin tăng mạnh nhất 24h...`);

    // BƯỚC 2: Quét tín hiệu trên khung 15m
    for (const coin of topCoins) {
      const raw15m = await getCandleData15m(coin.instId);
      if (!raw15m) {
        await sleep(80);
        continue;
      }

      const { normalShort, fastShort } = evaluateSignals(raw15m);
      const symbol = coin.instId;
      const coinName = symbol.replace('-USDT-SWAP', '');
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      if (!sentLog[symbol]) sentLog[symbol] = {};

      // Xử lý tín hiệu Short EMA
      if (normalShort) {
        const lastSent = sentLog[symbol]._short15m || 0;
        const isCooldown = currentTime - lastSent < COOLDOWN_TIME;

        scanResults.matched.push({
          symbol,
          type: 'SHORT EMA',
          change24h: coin.change24h,
          diffVal: `diffema20: ${normalShort.diffema20.toFixed(2)}% | diffema15m: ${normalShort.diffema15m.toFixed(2)}%`,
          teleSent: !isCooldown
        });

        if (!isCooldown) {
          const message = `🔴 <b>Short ema ${coinName}</b>\n` +
            `• Tăng 24h: <b>+${coin.change24h.toFixed(2)}%</b>\n` +
            `• DiffEMA20: <b>${normalShort.diffema20.toFixed(2)}%</b>\n` +
            `• DiffEMA15m: <b>${normalShort.diffema15m.toFixed(2)}%</b>\n` +
            `• <a href="${link}">Trade trên OKX</a>`;

          console.log(`🚀 [SHORT EMA] Gửi Telegram cho ${symbol}...`);
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

          sentLog[symbol]._short15m = currentTime;
          hasNewAlert = true;
        }
      }

      // Xử lý tín hiệu Short Nhanh
      if (fastShort) {
        const lastSentFast = sentLog[symbol]._shortFast15m || 0;
        const isCooldownFast = currentTime - lastSentFast < COOLDOWN_TIME;

        scanResults.matched.push({
          symbol,
          type: 'SHORT NHANH',
          change24h: coin.change24h,
          diffVal: `diffbbo: ${fastShort.diffbbo.toFixed(2)}%`,
          teleSent: !isCooldownFast
        });

        if (!isCooldownFast) {
          const message = `⚡ <b>Short nhanh ${coinName}</b>\n` +
            `• DiffBBo: <b>${fastShort.diffbbo.toFixed(2)}%</b>\n` +
            `• <a href="${link}">Trade trên OKX</a>`;

          console.log(`⚡ [SHORT NHANH] Gửi Telegram cho ${symbol}...`);
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

          sentLog[symbol]._shortFast15m = currentTime;
          hasNewAlert = true;
        }
      }

      await sleep(80);
    }

    if (hasNewAlert) saveSentLog(sentLog);

    // BƯỚC 3: Lưu và hiển thị bảng kết quả
    saveScanResults(scanResults);

    console.log('\n================== KẾT QUẢ QUÉT ==================');
    console.log(`Tổng số coin đã quét: ${scanResults.totalScanned}`);
    console.log(`Số tín hiệu thỏa mãn: ${scanResults.matched.length}`);
    if (scanResults.matched.length > 0) {
      console.table(scanResults.matched.map(item => ({
        'Symbol': item.symbol,
        'Loại': item.type,
        'Tăng 24h (%)': '+' + item.change24h.toFixed(2) + '%',
        'Chi tiết chỉ số': item.diffVal,
        'Đã gửi Tele': item.teleSent ? 'Có' : 'Bỏ qua (Cooldown)'
      })));
    }
    console.log(`📁 File kết quả đã lưu: ${RESULTS_FILE}`);
    console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---\n');

  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
