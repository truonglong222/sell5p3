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
      if (timeData._short1m && now - timeData._short1m < COOLDOWN_TIME) {
        temp._short1m = timeData._short1m;
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

  let initialSum = 0;
  for (let i = 0; i < period; i++) {
    initialSum += prices[i];
  }
  let prevEMA = initialSum / period;
  emaArray.push(prevEMA);

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

// ------------------- LẤY DỮ LIỆU NẾN 1M -------------------
async function getCandleData1m(symbol) {
  try {
    // Lấy 80 nến 1m để đảm bảo đủ dữ liệu tính chuỗi EMA20 và phân tích 30 nến gần nhất
    const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1m&limit=80`;
    const res = await axios.get(url, { timeout: 5000 });

    if (!res.data || res.data.code !== '0' || res.data.data.length < 50) return null;
    return res.data.data; // Mảng nến theo thứ tự [nến 0 (mới nhất), nến 1, nến 2, ...]
  } catch (error) {
    console.error(`Lỗi lấy dữ liệu nến 1m (${symbol}):`, error.message);
    return null;
  }
}

// ------------------- KIỂM TRA ĐIỀU KIỆN SHORT 1M -------------------
function evaluateShort1m(raw1m) {
  if (!raw1m || raw1m.length < 50) return null;

  const currentCandle = raw1m[0];
  const high0 = parseFloat(currentCandle[2]);
  const lastPrice0 = parseFloat(currentCandle[4]);

  // Chuẩn bị mảng giá đóng cửa từ cũ -> mới để tính EMA và BB
  const closedAsc = raw1m.slice().reverse().map(c => parseFloat(c[4]));

  // 1. Tính Bollinger Bands cho nến hiện tại
  const bb0 = calculateBollingerBands(closedAsc, 20);
  if (!bb0 || bb0.upper <= 0 || lastPrice0 <= 0) return null;

  // diffbbu = (High hiện tại - BB Upper hiện tại) / Giá hiện tại
  const diffbbu = ((high0 - bb0.upper) / lastPrice0) * 100;

  // 2. Tính chuỗi EMA20 và diffema20
  const emaSeries = calculateEMAArray(closedAsc, 20);
  if (emaSeries.length < 21) return null;

  // emaSeries phần tử cuối là nến hiện tại (idx 0), lùi lại 20 nến là nến thứ 20
  const currentEMA20 = emaSeries[emaSeries.length - 1];
  const ema20Candle20 = emaSeries[emaSeries.length - 1 - 20];

  if (currentEMA20 <= 0) return null;

  // diffema20 = (EMA20 hiện tại - EMA20 nến thứ 20) / EMA20 hiện tại
  const diffema20 = ((currentEMA20 - ema20Candle20) / currentEMA20) * 100;

  // 3. Tính hệ số x
  // Mức giảm lớn nhất trong 30 nến gần nhất: (Low - Open) / Open * 100 (mang giá trị âm)
  const last30Candles = raw1m.slice(0, 30);
  const dropPercentages = last30Candles.map(c => {
    const o = parseFloat(c[1]);
    const l = parseFloat(c[3]);
    return o > 0 ? ((l - o) / o) * 100 : 0;
  });
  const maxDrop = Math.min(...dropPercentages); // Giá trị âm lớn nhất

  // Trung bình trị tuyệt đối biến động thân nến (|Close - Open| / Open * 100) của 10 nến gần nhất
  const last10Candles = raw1m.slice(0, 10);
  const totalAbsRange = last10Candles.reduce((acc, c) => {
    const o = parseFloat(c[1]);
    const cl = parseFloat(c[4]);
    return acc + (o > 0 ? (Math.abs(cl - o) / o) * 100 : 0);
  }, 0);
  const avgAbsRange10 = totalAbsRange / 10;

  const x = avgAbsRange10 > 0 ? maxDrop / avgAbsRange10 : 0;

  // 4. Kiểm tra các điều kiện:
  // - diffema20 < -2%
  // - x < -3
  // - -2% < diffbbu < 2%
  const isMatchDiffEMA20 = diffema20 < -2;
  const isMatchX = x < -3;
  const isMatchDiffbbu = diffbbu > -2 && diffbbu < 2;

  if (isMatchDiffEMA20 && isMatchX && isMatchDiffbbu) {
    return { diffema20, x, diffbbu };
  }

  return null;
}

// ------------------- TIẾN TRÌNH CHÍNH -------------------
async function main() {
  try {
    console.log('--- BẮT ĐẦU QUÉT TOP 20 COIN TĂNG TRƯỞNG CHO TÍN HIỆU SHORT 1M ---');

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

    // BƯỚC 2: Quét tín hiệu trên khung 1m
    for (let i = 0; i < topCoins.length; i++) {
      const coin = topCoins[i];
      const rank = i + 1; // Thứ tự Top
      const raw1m = await getCandleData1m(coin.instId);
      if (!raw1m) {
        await sleep(80);
        continue;
      }

      const signal = evaluateShort1m(raw1m);
      const symbol = coin.instId;
      const coinName = symbol.replace('-USDT-SWAP', '');
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      if (!sentLog[symbol]) sentLog[symbol] = {};

      if (signal) {
        const lastSent = sentLog[symbol]._short1m || 0;
        const isCooldown = currentTime - lastSent < COOLDOWN_TIME;

        scanResults.matched.push({
          rank,
          symbol,
          change24h: coin.change24h,
          diffema20: signal.diffema20.toFixed(2) + '%',
          x: signal.x.toFixed(2),
          diffbbu: signal.diffbbu.toFixed(2) + '%',
          teleSent: !isCooldown
        });

        if (!isCooldown) {
          const message = `🔴 <b>TÍN HIỆU SHORT 1M: ${coinName}</b>\n` +
            `• Xếp hạng: <b>Top #${rank} Gainer</b>\n` +
            `• Tăng 24h: <b>+${coin.change24h.toFixed(2)}%</b>\n` +
            `• DiffEMA20: <b>${signal.diffema20.toFixed(2)}%</b>\n` +
            `• Giá trị X: <b>${signal.x.toFixed(2)}</b>\n` +
            `• DiffBBU: <b>${signal.diffbbu.toFixed(2)}%</b>\n` +
            `• <a href="${link}">Trade trên OKX</a>`;

          console.log(`🚀 [SHORT 1M] Gửi Telegram cho ${symbol} (Top #${rank})...`);
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

          sentLog[symbol]._short1m = currentTime;
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
        'Top': `#${item.rank}`,
        'Symbol': item.symbol,
        'Tăng 24h (%)': '+' + item.change24h.toFixed(2) + '%',
        'DiffEMA20': item.diffema20,
        'Hệ số X': item.x,
        'DiffBBU': item.diffbbu,
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
