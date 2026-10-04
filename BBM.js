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

// ------------------- LỌC THỊ TRƯỜNG (VOL > 5M) -------------------

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
        change24hVal: parseFloat(change24hVal.toFixed(2))
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
      `📊 Tổng USDT Swap: ${allSwapsCount} | Thỏa Vol > 5M: ${volPassedCount} coin`
    );

    // --- TÍNH CHỈ SỐ UD TOÀN TẬP COIN ĐÃ LỌC (4H) ---
    console.log(`⏳ Đang tải nến 4H tính chỉ số ud cho ${targetCoins.length} coin...`);
    let totalUp4hCoins = 0;
    let totalDown4hCoins = 0;

    for (const coin of targetCoins) {
      const candles4h = await getCandles(coin.instId, '4H', 2);
      if (candles4h && candles4h.length >= 2) {
        const closedCandle = candles4h[1];
        const openPrice = parseFloat(closedCandle[1]);
        const closePrice = parseFloat(closedCandle[4]);

        if (closePrice > openPrice) {
          totalUp4hCoins++;
        } else if (closePrice < openPrice) {
          totalDown4hCoins++;
        }
      }
      await sleep(60);
    }

    const marketUD = totalUp4hCoins - totalDown4hCoins;
    const marketUDStr = marketUD > 0 ? `+${marketUD}` : `${marketUD}`;
    console.log(`📈 Kết quả ud (4H): ${marketUDStr} (Tăng: ${totalUp4hCoins} | Giảm: ${totalDown4hCoins})\n`);

    // --- QUÉT DỮ LIỆU NẾN VÀ KIỂM TRA TÍN HIỆU ---
    console.log(`⏳ Đang kiểm tra điều kiện tín hiệu cho ${targetCoins.length} coin...`);

    const scanResults = {
      ud4h: marketUDStr,
      targetCoins,
      matched: []
    };

    let countMatchedLong = 0;
    let countMatchedShort = 0;

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // 1. TÍNH diffema20 TRÊN KHUNG 5M
      const candles5m = await getCandles(symbol, '5m', 100);
      if (!candles5m || candles5m.length < 45) {
        await sleep(80);
        continue;
      }

      const closed5m = candles5m.slice(1).reverse();
      const closedPrices5m = closed5m.map((c) => parseFloat(c[4]));
      const emaSeries5m = calculateEMAArray(closedPrices5m, 20);

      if (emaSeries5m.length < 20) {
        await sleep(80);
        continue;
      }

      const ema20_5m_n1 = emaSeries5m[emaSeries5m.length - 1];
      const ema20_5m_n20 = emaSeries5m[emaSeries5m.length - 20];

      if (ema20_5m_n20 <= 0) {
        await sleep(80);
        continue;
      }

      const diffema20_5m = ((ema20_5m_n1 - ema20_5m_n20) / ema20_5m_n20) * 100;

      // Điều kiện chung mới: -0.5% < diffema20 < 0.5%
      if (diffema20_5m <= -0.5 || diffema20_5m >= 0.5) {
        await sleep(80);
        continue;
      }

      // 2. KIỂM TRA ĐIỀU KIỆN NẾN VÀ BOLLINGER BANDS (15m)
      const candles15m = await getCandles(symbol, '15m', 100);
      if (!candles15m || candles15m.length < 25) {
        await sleep(80);
        continue;
      }

      const candle1 = candles15m[1];
      const open1 = parseFloat(candle1[1]);
      const close1 = parseFloat(candle1[4]);
      const isCandle1Bullish = close1 > open1;
      const isCandle1Bearish = close1 < open1;

      const candle2 = candles15m[2];
      const high2 = parseFloat(candle2[2]);
      const low2 = parseFloat(candle2[3]);

      const closesBB2 = candles15m.slice(2, 22).map((c) => parseFloat(c[4])).reverse();
      const bb2 = calculateBollingerBands(closesBB2, 20);

      if (!bb2 || bb2.lower <= 0 || bb2.upper <= 0) {
        await sleep(80);
        continue;
      }

      const bbd = low2 - bb2.lower;
      const bbt = high2 - bb2.upper;

      let isLong = false;
      let isShort = false;

      // Điều kiện LONG: bd24h > 5%, bbd < 0, nến 1 là nến tăng
      if (coin.change24hVal > 5 && bbd < 0 && isCandle1Bullish) {
        isLong = true;
      } 
      // Điều kiện SHORT: -7% < bd24h < -2%, bbt > 0, nến 1 là nến giảm
      else if (coin.change24hVal > -7 && coin.change24hVal < -2 && bbt > 0 && isCandle1Bearish) {
        isShort = true;
      }

      if (!isLong && !isShort) {
        await sleep(80);
        continue;
      }

      // 3. KIỂM TRA COOLDOWN
      if (!sentLog[symbol]) sentLog[symbol] = {};
      const alertKey = isLong ? 'longAlert' : 'shortAlert';
      const lastSentTime = sentLog[symbol][alertKey];
      const isCooldown = currentTime - (lastSentTime || 0) < COOLDOWN_TIME;

      if (isCooldown) {
        await sleep(80);
        continue;
      }

      // 4. TÍNH TOÁN Hbb TRÊN KHUNG 15M
      let hbbStr = 'N/A';
      const closed15mLast = candles15m[1];
      const high15m = parseFloat(closed15mLast[2]);
      const low15m = parseFloat(closed15mLast[3]);

      const closesBB15m = candles15m.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
      const bb15m = calculateBollingerBands(closesBB15m, 20);

      if (bb15m && bb15m.lower > 0 && bb15m.upper > 0) {
        const bbt15m = ((high15m - bb15m.upper) / bb15m.upper) * 100;
        const bbd15m = ((low15m - bb15m.lower) / bb15m.lower) * 100;
        const hbbVal = bbt15m - bbd15m;

        hbbStr = `${hbbVal > 0 ? '+' : ''}${hbbVal.toFixed(2)}%`;
      }

      const signalType = isLong ? 'LONG' : 'SHORT';
      const change24hStr = `${coin.change24hVal > 0 ? '+' : ''}${coin.change24hVal.toFixed(2)}%`;
      const diffema20_5mStr = `${diffema20_5m > 0 ? '+' : ''}${diffema20_5m.toFixed(2)}%`;

      const coinName = symbol.replace('-USDT-SWAP', '');
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      // 5. GỬI TELEGRAM
      const icon = isLong ? '🟢' : '🔴';

      const message =
        `${icon} <b>${signalType}: ${coinName}</b>\n` +
        `• <b>Hbb (15m):</b> ${hbbStr}\n` +
        `• <b>diffema20 (5m):</b> ${diffema20_5mStr}\n` +
        `• <b>ud (4H):</b> ${marketUDStr}\n` +
        `• <b>bd24h:</b> ${change24hStr}\n` +
        `• <a href="${link}">Link OKX</a>`;

      console.log(`🚀 [${signalType}] Gửi Telegram tín hiệu cho ${symbol}...`);

      let isSentSuccess = false;
      try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
        isSentSuccess = true;
      } catch (err) {
        console.error('Lỗi gửi Telegram tín hiệu:', err.message);
      }

      // Lưu kết quả khi gửi thành công
      if (isSentSuccess) {
        if (isLong) countMatchedLong++;
        if (isShort) countMatchedShort++;

        scanResults.matched.push({
          symbol,
          type: signalType,
          hbb15m: hbbStr,
          diffema20_5m: diffema20_5mStr,
          ud4h: marketUDStr,
          bd24h: change24hStr,
          link,
          teleSent: true
        });

        sentLog[symbol][alertKey] = currentTime;
        hasNewAlert = true;
      }

      await sleep(80);
    }

    if (hasNewAlert) saveSentLog(sentLog);
    saveScanResults(scanResults);

    // --- LOG KẾT QUẢ ---
    console.log('\n================ THỐNG KÊ CHI TIẾT ================');
    console.log(`• Chỉ số ud (4H): ${marketUDStr}`);
    console.log(`• Tín hiệu LONG đã gửi: ${countMatchedLong} coin`);
    console.log(`• Tín hiệu SHORT đã gửi: ${countMatchedShort} coin`);
    console.log('===================================================\n');

    if (scanResults.matched.length > 0) {
      console.log('--- DANH SÁCH COIN ĐÃ GỬI TÍN HIỆU ---');
      scanResults.matched.forEach((item, index) => {
        console.log(
          `${index + 1}. [${item.type}] ${item.symbol} | Hbb(15m): ${item.hbb15m} | diffema20(5m): ${item.diffema20_5m} | bd24h: ${item.bd24h}`
        );
      });
      console.log('');
    } else {
      console.log('❌ Không có coin nào thỏa mãn gửi tín hiệu mới.\n');
    }

    console.log(`📁 File kết quả đã lưu: ${RESULTS_FILE}`);
    console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---\n');
  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
