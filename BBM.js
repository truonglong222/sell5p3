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

// Cấu hình Cooldown: 2 tiếng
const COOLDOWN_TIME = 2 * 60 * 60 * 1000;
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

// ------------------- LỌC THỊ TRƯỜNG (VOL > 5M & bd24h > +2%) -------------------

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
      
      // Chỉ lấy coin có bd24h > +2% cho cả Long và Short
      if (change24hVal > 2) {
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
      `📊 Tổng USDT Swap: ${allSwapsCount} | Vol > 5M: ${volPassedCount} | Thỏa bd24h > +2%: ${targetCoins.length} coin`
    );

    // --- TÍNH CHỈ SỐ UD TOÀN TẬP COIN ĐÃ LỌC ---
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

    // --- LỌC BƯỚC 2: TÍNH diffema40 TRÊN NẾN 15m ---
    console.log(`⏳ Đang kiểm tra diffema40 (15m) cho ${targetCoins.length} coin...`);
    const coinsPassing15m = [];

    for (const coin of targetCoins) {
      const candles15m = await getCandles(coin.instId, '15m', 100);
      if (!candles15m || candles15m.length < 65) {
        await sleep(80);
        continue;
      }

      const closed15m = candles15m.slice(1).reverse();
      const closedPrices15m = closed15m.map((c) => parseFloat(c[4]));
      const emaSeries15m = calculateEMAArray(closedPrices15m, 20);

      if (emaSeries15m.length >= 40) {
        const ema20_15m_n1 = emaSeries15m[emaSeries15m.length - 1];
        const ema20_15m_n40 = emaSeries15m[emaSeries15m.length - 40];

        if (ema20_15m_n40 > 0) {
          const diffema40_15m = ((ema20_15m_n1 - ema20_15m_n40) / ema20_15m_n40) * 100;

          // Cả LONG và SHORT đều yêu cầu bd24h > 2%
          if (coin.change24hVal > 2 && diffema40_15m > 2) {
            coinsPassing15m.push({
              ...coin,
              expectedSignal: 'LONG',
              diffema40_15m
            });
          } else if (coin.change24hVal > 2 && diffema40_15m < -2) {
            coinsPassing15m.push({
              ...coin,
              expectedSignal: 'SHORT',
              diffema40_15m
            });
          }
        }
      }
      await sleep(80);
    }

    console.log(`🔍 Số coin thỏa diffema40 (15m): ${coinsPassing15m.length} coin\n`);

    const scanResults = {
      ud4h: marketUDStr,
      targetCoins,
      matched: []
    };

    let countMatchedLong = 0;
    let countMatchedShort = 0;

    // --- LỌC BƯỚC 3: KIỂM TRA NẾN 5m ---
    for (const coin of coinsPassing15m) {
      const symbol = coin.instId;
      const candles5m = await getCandles(symbol, '5m', 100);
      if (!candles5m || candles5m.length < 30) {
        await sleep(80);
        continue;
      }

      // Nến số 1: nến vừa đóng (index 1)
      const candle1 = candles5m[1];
      const open1 = parseFloat(candle1[1]);
      const close1 = parseFloat(candle1[4]);
      const isCandle1Bullish = close1 > open1;
      const isCandle1Bearish = close1 < open1;

      // Nến số 2: nến trước đó (index 2)
      const candle2 = candles5m[2];
      const high2 = parseFloat(candle2[2]);
      const low2 = parseFloat(candle2[3]);

      // Tính Bollinger Bands nến số 2: lấy 20 nến từ nến số 2 trở về trước (index 2 đến 21)
      const closesBB2 = candles5m.slice(2, 22).map((c) => parseFloat(c[4])).reverse();
      const bb2 = calculateBollingerBands(closesBB2, 20);

      if (!bb2 || bb2.lower <= 0 || bb2.upper <= 0) {
        await sleep(80);
        continue;
      }

      // bbd = low nến 2 - BB lower nến 2
      // bbt = high nến 2 - BB upper nến 2
      const bbd = low2 - bb2.lower;
      const bbt = high2 - bb2.upper;

      let isLong = false;
      let isShort = false;

      if (coin.expectedSignal === 'LONG' && bbd < 0 && isCandle1Bullish) {
        isLong = true;
      } else if (coin.expectedSignal === 'SHORT' && bbt > 0 && isCandle1Bearish) {
        isShort = true;
      }

      if (!isLong && !isShort) {
        await sleep(80);
        continue;
      }

      const signalType = isLong ? 'LONG' : 'SHORT';
      const change24hStr = `${coin.change24hVal > 0 ? '+' : ''}${coin.change24hVal.toFixed(2)}%`;
      const diffema40_15mStr = `${coin.diffema40_15m > 0 ? '+' : ''}${coin.diffema40_15m.toFixed(2)}%`;
      const bandMetricStr = isLong ? `bbd: ${bbd.toFixed(4)} (< 0)` : `bbt: +${bbt.toFixed(4)} (> 0)`;

      if (isLong) countMatchedLong++;
      if (isShort) countMatchedShort++;

      const coinName = symbol.replace('-USDT-SWAP', '');
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      if (!sentLog[symbol]) sentLog[symbol] = {};
      const alertKey = isLong ? 'longAlert' : 'shortAlert';
      const lastSentTime = sentLog[symbol][alertKey];
      const isCooldown = currentTime - (lastSentTime || 0) < COOLDOWN_TIME;

      const matchedItem = {
        symbol,
        type: signalType,
        diffema40_15m: diffema40_15mStr,
        bandMetric: bandMetricStr,
        bd24h: change24hStr,
        link,
        teleSent: !isCooldown
      };

      scanResults.matched.push(matchedItem);

      if (!isCooldown) {
        const icon = isLong ? '🟢' : '🔴';
        const candle1Desc = isLong ? 'Nến 1: TĂNG' : 'Nến 1: GIẢM';

        const message =
          `<b>ud (4H): ${marketUDStr}</b>\n` +
          `${icon} <b>TÍN HIỆU ${signalType}: ${coinName}</b>\n` +
          `• <b>bd24h:</b> ${change24hStr}\n` +
          `• <b>diffema40 (15m):</b> ${diffema40_15mStr}\n` +
          `• <b>${bandMetricStr}</b>\n` +
          `• <b>Trạng thái:</b> ${candle1Desc}\n` +
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

    // --- LOG KẾT QUẢ ---
    console.log('\n================ THỐNG KÊ CHI TIẾT ================');
    console.log(`• Chỉ số ud (4H): ${marketUDStr}`);
    console.log(`• Khớp tín hiệu LONG: ${countMatchedLong} coin`);
    console.log(`• Khớp tín hiệu SHORT: ${countMatchedShort} coin`);
    console.log('===================================================\n');

    if (scanResults.matched.length > 0) {
      console.log('--- DANH SÁCH COIN KHỚP TÍN HIỆU ---');
      scanResults.matched.forEach((item, index) => {
        const status = item.teleSent ? 'Đã gửi Tele' : 'Đang Cooldown';
        console.log(
          `${index + 1}. [${item.type}] ${item.symbol} | bd24h: ${item.bd24h} | diffema40(15m): ${item.diffema40_15m} | ${item.bandMetric} | ${status}`
        );
      });
      console.log('');
    } else {
      console.log('❌ Không có coin nào thỏa mãn tất cả tiêu chí.\n');
    }

    console.log(`📁 File kết quả đã lưu: ${RESULTS_FILE}`);
    console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---\n');
  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
