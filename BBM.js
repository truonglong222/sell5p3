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

function calculateEMAArray(prices, period = 10) {
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

// ------------------- LỌC THỊ TRƯỜNG BASE -------------------

async function getFilteredMarkets() {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') return { allSwapsCount: 0, volPassedCoins: [] };

    const tickers = res.data.data.filter((item) => item.instId.endsWith('-USDT-SWAP'));
    const volFiltered = tickers.filter((item) => parseFloat(item.volCcy24h || 0) > MIN_VOL_CCY24H);

    const volPassedCoins = [];
    for (const item of volFiltered) {
      const open24h = parseFloat(item.open24h || 0);
      const lastPrice = parseFloat(item.last || 0);
      if (open24h <= 0) continue;

      const change24hVal = ((lastPrice - open24h) / open24h) * 100;

      volPassedCoins.push({
        instId: item.instId,
        open24h,
        last: lastPrice,
        change24hVal: parseFloat(change24hVal.toFixed(2))
      });
    }

    return {
      allSwapsCount: tickers.length,
      volPassedCoins
    };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { allSwapsCount: 0, volPassedCoins: [] };
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
    console.log('=== BẮT ĐẦU QUÉT THỊ TRƯỜNG OKX ===\n');

    const sentLog = loadSentLog();
    const currentTime = Date.now();
    let hasNewAlert = false;

    // Lấy toàn bộ thị trường thỏa Volume
    const { allSwapsCount, volPassedCoins } = await getFilteredMarkets();

    // BƯỚC 1: LỌC BD24H SỚM (Long > 3%, Short < -3%)
    const bd24hPassedCoins = volPassedCoins.filter((coin) => {
      const isLongPotential = coin.change24hVal > 3;
      const isShortPotential = coin.change24hVal < -3;
      return isLongPotential || isShortPotential;
    });

    const pipelineStats = {
      step0_allSwaps: allSwapsCount,
      step1_volPassed: volPassedCoins.length,
      step2_bd24hPassed: bd24hPassedCoins.length,
      step3_cooldownPassed: 0,
      step4_diffemaPassed: 0,
      step5_signalMatched: 0
    };

    // BƯỚC 2: TÍNH UD (4H) CHỈ TRÊN DANH SÁCH COIN ĐÃ QUA LỌC BD24H
    console.log(`⏳ Đang tính chỉ số market UD (4H) trên ${bd24hPassedCoins.length} coin thỏa bd24h...`);
    let totalUp4hCoins = 0;
    let totalDown4hCoins = 0;

    for (const coin of bd24hPassedCoins) {
      const candles4h = await getCandles(coin.instId, '4H', 2);
      if (candles4h && candles4h.length >= 2) {
        const closedCandle = candles4h[1];
        const openPrice = parseFloat(closedCandle[1]);
        const closePrice = parseFloat(closedCandle[4]);

        if (closePrice > openPrice) totalUp4hCoins++;
        else if (closePrice < openPrice) totalDown4hCoins++;
      }
      await sleep(50);
    }

    const marketUD = totalUp4hCoins - totalDown4hCoins;
    const marketUDStr = marketUD > 0 ? `+${marketUD}` : `${marketUD}`;
    console.log(`📈 UD (4H): ${marketUDStr} (Tăng: ${totalUp4hCoins} | Giảm: ${totalDown4hCoins})\n`);

    // --- QUÉT CHI TIẾT TÍN HIỆU THEO TỪNG BƯỚC LỌC ---
    console.log(`⏳ Đang chạy phễu lọc tín hiệu kỹ thuật cho ${bd24hPassedCoins.length} coin khả thi...\n`);

    const scanResults = {
      ud4h: marketUDStr,
      targetCoins: bd24hPassedCoins,
      matched: []
    };

    let countMatchedLong = 0;
    let countMatchedShort = 0;

    for (const coin of bd24hPassedCoins) {
      const symbol = coin.instId;
      const potentialType = coin.change24hVal > 3 ? 'LONG' : 'SHORT';

      // BƯỚC 3: KIỂM TRA COOLDOWN
      if (!sentLog[symbol]) sentLog[symbol] = {};
      const alertKey = potentialType === 'LONG' ? 'longAlert' : 'shortAlert';
      const lastSentTime = sentLog[symbol][alertKey];
      const isCooldown = currentTime - (lastSentTime || 0) < COOLDOWN_TIME;

      if (isCooldown) {
        continue;
      }
      pipelineStats.step3_cooldownPassed++;

      // BƯỚC 4: LỌC DIFFEMA10 TRÊN KHUNG 15M (Long > 2%, Short < -2%)
      const candles15m = await getCandles(symbol, '15m', 100);
      if (!candles15m || candles15m.length < 35) {
        await sleep(60);
        continue;
      }

      // Nến index 0 là nến đang chạy -> lấy từ index 1 trở đi và đảo lại theo thứ tự thời gian tăng dần
      const closed15m = candles15m.slice(1).reverse();
      const closedPrices15m = closed15m.map((c) => parseFloat(c[4]));
      const emaSeries15m = calculateEMAArray(closedPrices15m, 10);

      if (emaSeries15m.length < 10) {
        await sleep(60);
        continue;
      }

      const ema10_15m_n1 = emaSeries15m[emaSeries15m.length - 1];
      const ema10_15m_n10 = emaSeries15m[emaSeries15m.length - 10];

      if (ema10_15m_n10 <= 0) {
        await sleep(60);
        continue;
      }

      const diffema10_15m = ((ema10_15m_n1 - ema10_15m_n10) / ema10_15m_n10) * 100;

      if (potentialType === 'LONG' && diffema10_15m <= 2) {
        await sleep(60);
        continue;
      }
      if (potentialType === 'SHORT' && diffema10_15m >= -2) {
        await sleep(60);
        continue;
      }
      pipelineStats.step4_diffemaPassed++;

      // BƯỚC 5: KIỂM TRA BOLLINGER BANDS VÀ NẾN TRÊN KHUNG 5M
      const candles5m = await getCandles(symbol, '5m', 100);
      if (!candles5m || candles5m.length < 25) {
        await sleep(60);
        continue;
      }

      const candle1 = candles5m[1];
      const open1 = parseFloat(candle1[1]);
      const close1 = parseFloat(candle1[4]);
      const isCandle1Bullish = close1 > open1;
      const isCandle1Bearish = close1 < open1;

      const candle2 = candles5m[2];
      const high2 = parseFloat(candle2[2]);
      const low2 = parseFloat(candle2[3]);

      // BB cho 20 nến tính từ nến 2
      const closesBB2 = candles5m.slice(2, 22).map((c) => parseFloat(c[4])).reverse();
      const bb2 = calculateBollingerBands(closesBB2, 20);

      if (!bb2 || bb2.lower <= 0 || bb2.upper <= 0) {
        await sleep(60);
        continue;
      }

      const bbd = low2 - bb2.lower;
      const bbt = high2 - bb2.upper;

      let isLong = false;
      let isShort = false;

      if (potentialType === 'LONG' && bbd < 0 && isCandle1Bullish) {
        isLong = true;
      } else if (potentialType === 'SHORT' && bbt > 0 && isCandle1Bearish) {
        isShort = true;
      }

      if (!isLong && !isShort) {
        await sleep(60);
        continue;
      }

      pipelineStats.step5_signalMatched++;

      // TÍNH HBB KHUNG 5M CỦA NẾN VỪA ĐÓNG ([1])
      let hbbStr = 'N/A';
      const closesBB5m = candles5m.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
      const bb5m = calculateBollingerBands(closesBB5m, 20);

      if (bb5m && bb5m.lower > 0 && bb5m.upper > 0) {
        const hbbVal = ((bb5m.upper - bb5m.lower) / bb5m.lower) * 100;
        hbbStr = `${hbbVal.toFixed(2)}%`;
      }

      const signalType = isLong ? 'LONG' : 'SHORT';
      const change24hStr = `${coin.change24hVal > 0 ? '+' : ''}${coin.change24hVal.toFixed(2)}%`;
      const diffema10_15mStr = `${diffema10_15m > 0 ? '+' : ''}${diffema10_15m.toFixed(2)}%`;
      const coinName = symbol.replace('-USDT-SWAP', '');
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      // GỬI TELEGRAM
      const icon = isLong ? '🟢' : '🔴';
      const message =
        `${icon} <b>${signalType}: ${coinName}</b>\n` +
        `• <b>Hbb (5m):</b> ${hbbStr}\n` +
        `• <b>diffema10 (15m):</b> ${diffema10_15mStr}\n` +
        `• <b>ud (4H):</b> ${marketUDStr}\n` +
        `• <b>bd24h:</b> ${change24hStr}\n` +
        `• <a href="${link}">Link OKX</a>`;

      console.log(`🚀 [${signalType}] Gửi Telegram cho ${symbol}...`);

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
        console.error('Lỗi gửi Telegram:', err.message);
      }

      if (isSentSuccess) {
        if (isLong) countMatchedLong++;
        if (isShort) countMatchedShort++;

        scanResults.matched.push({
          symbol,
          type: signalType,
          hbb5m: hbbStr,
          diffema10_15m: diffema10_15mStr,
          ud4h: marketUDStr,
          bd24h: change24hStr,
          link,
          teleSent: true
        });

        sentLog[symbol][alertKey] = currentTime;
        hasNewAlert = true;
      }

      await sleep(60);
    }

    if (hasNewAlert) saveSentLog(sentLog);
    saveScanResults(scanResults);

    // --- LOG THỐNG KÊ PHỄU LỌC ---
    console.log('\n📊 ================= BÁO CÁO PHỄU LỌC (FILTER PIPELINE) =================');
    console.log(`1. Tổng USDT Swap trên OKX               : ${pipelineStats.step0_allSwaps} coin`);
    console.log(`2. Thỏa điều kiện Vol 24h (> 5M USDT)     : ${pipelineStats.step1_volPassed} coin`);
    console.log(`3. Thỏa biên độ bd24h (Long>3% / Short<-3%): ${pipelineStats.step2_bd24hPassed} coin`);
    console.log(`4. Qua kiểm tra Cooldown (12h)            : ${pipelineStats.step3_cooldownPassed} coin`);
    console.log(`5. Thỏa diffema10 15m (>2% hoặc <-2%)     : ${pipelineStats.step4_diffemaPassed} coin`);
    console.log(`6. Khớp Bollinger Bands & Nến 5m          : ${pipelineStats.step5_signalMatched} coin`);
    console.log('=========================================================================\n');

    console.log('=============== KẾT QUẢ TÍN HIỆU GỬI ĐI ===============');
    console.log(`• Chỉ số ud (4H)        : ${marketUDStr}`);
    console.log(`• Tín hiệu LONG đã gửi  : ${countMatchedLong} coin`);
    console.log(`• Tín hiệu SHORT đã gửi : ${countMatchedShort} coin`);
    console.log('=======================================================\n');

    if (scanResults.matched.length > 0) {
      console.log('--- DANH SÁCH COIN ĐÃ GỬI TÍN HIỆU ---');
      scanResults.matched.forEach((item, index) => {
        console.log(
          `${index + 1}. [${item.type}] ${item.symbol} | Hbb(5m): ${item.hbb5m} | diffema10(15m): ${item.diffema10_15m} | bd24h: ${item.bd24h}`
        );
      });
      console.log('');
    } else {
      console.log('❌ Không có coin nào thỏa mãn tất cả điều kiện lọc.\n');
    }

    console.log(`📁 Kết quả lưu tại: ${RESULTS_FILE}`);
    console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---\n');
  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
