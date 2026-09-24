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

// Cấu hình tham số lọc
const COOLDOWN_TIME = 2 * 60 * 60 * 1000; // 2 tiếng
const MIN_VOL_CCY24H = 5_000_000;         // Volume 24h > 5 triệu USDT
const MIN_CHANGE_24H = 5;                 // bd24h > 5%
const MIN_DIFF_EMA20_15M = 3;             // diffema20 (15m) > 3%

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

  let sum = 0;
  for (let i = 0; i < period; i++) sum += slice[i];
  const mean = sum / period;

  let varianceSum = 0;
  for (let i = 0; i < period; i++) {
    const diff = slice[i] - mean;
    varianceSum += diff * diff;
  }

  const stdDev = Math.sqrt(varianceSum / period);
  return {
    middle: mean,
    upper: mean + stdDevMultiplier * stdDev,
    lower: mean - stdDevMultiplier * stdDev
  };
}

function calculateEMAArray(prices, period = 20) {
  const len = prices.length;
  if (len < period) return [];

  const k = 2 / (period + 1);
  const emaArray = [];

  let initialSma = 0;
  for (let i = 0; i < period; i++) {
    initialSma += prices[i];
  }
  let prevEma = initialSma / period;
  emaArray.push(prevEma);

  for (let i = period; i < len; i++) {
    const currentEma = prices[i] * k + prevEma * (1 - k);
    emaArray.push(currentEma);
    prevEma = currentEma;
  }
  return emaArray;
}

const calcDiffPct = (curr, prev) => (prev > 0 ? ((curr - prev) / prev) * 100 : 0);

// ------------------- LỌC THỊ TRƯỜNG -------------------

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

      // Lọc bd24h > 5%
      if (change24hVal > MIN_CHANGE_24H) {
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

async function getCandles(symbol, bar = '15m', limit = 60) {
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
      `📊 Tổng USDT Swap: ${allSwapsCount} | Vol > 5M: ${volPassedCount} | Thỏa lọc bd24h > ${MIN_CHANGE_24H}%: ${targetCoins.length} coin`
    );

    const scanResults = {
      targetCoins,
      matched: []
    };

    let countValid15m = 0;
    let count15mQualified = 0;
    let countHbbFilter = 0;
    let countMatchedLong = 0;
    let countMatchedShort = 0;

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // ================= BƯỚC 1: LẤY VÀ KIỂM TRA NẾN 15M =================
      const candles15m = await getCandles(symbol, '15m', 60);
      if (!candles15m || candles15m.length < 45) {
        await sleep(80);
        continue;
      }
      countValid15m++;

      // Nến 0 đang chạy, lấy từ nến 1 đóng trở về trước theo thứ tự thời gian tăng dần
      const closed15m = candles15m.slice(1).reverse().map((c) => parseFloat(c[4]));
      const emaSeries15m = calculateEMAArray(closed15m, 20);

      if (emaSeries15m.length < 20) {
        await sleep(80);
        continue;
      }

      const ema15m_n1 = emaSeries15m[emaSeries15m.length - 1];
      const ema15m_n20 = emaSeries15m[emaSeries15m.length - 20];

      if (!ema15m_n20 || ema15m_n20 <= 0) {
        await sleep(80);
        continue;
      }

      const diff15mVal = calcDiffPct(ema15m_n1, ema15m_n20);

      // Cập nhật điều kiện lọc diffema20 nến 15m > 3%
      const isQualified15m = diff15mVal > MIN_DIFF_EMA20_15M;
      if (!isQualified15m) {
        await sleep(80);
        continue;
      }

      const isPotentialLong = true;
      const isPotentialShort = coin.change24hVal > MIN_CHANGE_24H;
      count15mQualified++;

      // ================= BƯỚC 2: GỌI NẾN 5M =================
      await sleep(60);
      const candles5m = await getCandles(symbol, '5m', 80);
      if (!candles5m || candles5m.length < 50) {
        await sleep(80);
        continue;
      }

      const closed5m = candles5m.slice(1).reverse().map((c) => parseFloat(c[4]));

      // 1. diffema20 trên khung 5m
      const emaSeries5m = calculateEMAArray(closed5m, 20);
      let diff5mVal = 0;
      if (emaSeries5m.length >= 20) {
        diff5mVal = calcDiffPct(emaSeries5m[emaSeries5m.length - 1], emaSeries5m[emaSeries5m.length - 20]);
      }

      // 2. diffema10 trên khung 5m
      const ema10Series5m = calculateEMAArray(closed5m, 10);
      let diff5mEma10Val = 0;
      let passEma10_5mForShort = false;

      if (ema10Series5m.length >= 10) {
        diff5mEma10Val = calcDiffPct(ema10Series5m[ema10Series5m.length - 1], ema10Series5m[ema10Series5m.length - 10]);
        passEma10_5mForShort = diff5mEma10Val < 0.5;
      }

      // 3. Dữ liệu nến 5m (candle 0 và candle 1)
      const candle0 = candles5m[0];
      const high0 = parseFloat(candle0[2]);

      const candle1 = candles5m[1];
      const open1 = parseFloat(candle1[1]);
      const low1 = parseFloat(candle1[3]);
      const close1 = parseFloat(candle1[4]);

      const bd5 = open1 > 0 ? ((close1 - open1) / open1) * 100 : 0;

      // 4. Bollinger Bands nến số 1
      const closesBB5m = candles5m.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
      const bb5m = calculateBollingerBands(closesBB5m, 20);

      if (!bb5m || bb5m.lower <= 0 || bb5m.upper <= 0 || bb5m.middle <= 0) {
        await sleep(80);
        continue;
      }

      const hbbPercent = ((bb5m.upper - bb5m.lower) / bb5m.middle) * 100;
      if (hbbPercent <= 4) {
        await sleep(80);
        continue;
      }
      countHbbFilter++;

      const bbd = ((low1 - bb5m.lower) / bb5m.lower) * 100;
      const bbm = ((high0 - bb5m.middle) / bb5m.middle) * 100;

      // 5. Kiểm tra điều kiện sơ bộ
      const passPreLong = isPotentialLong && bbd < 0.3 && bd5 > -1;
      const passPreShort = isPotentialShort && passEma10_5mForShort && bbm > -0.3 && bd5 < 1;

      if (!passPreLong && !passPreShort) {
        await sleep(80);
        continue;
      }

      // 6. Tính tỷ lệ x trên 5 cây nến gần nhất
      let maxAbsBd5 = -1;
      let targetIndex = 1;
      let targetBd5 = 0;

      for (let i = 1; i <= 5; i++) {
        const cOpen = parseFloat(candles5m[i][1]);
        const cClose = parseFloat(candles5m[i][4]);
        const changePct = cOpen > 0 ? ((cClose - cOpen) / cOpen) * 100 : 0;
        const absVal = Math.abs(changePct);

        if (absVal > maxAbsBd5) {
          maxAbsBd5 = absVal;
          targetIndex = i;
          targetBd5 = changePct;
        }
      }

      const targetClosesBB = candles5m.slice(targetIndex, targetIndex + 20).map((c) => parseFloat(c[4])).reverse();
      const targetBB = calculateBollingerBands(targetClosesBB, 20);

      if (!targetBB || targetBB.middle <= 0) {
        await sleep(80);
        continue;
      }

      const targetHbb = ((targetBB.upper - targetBB.lower) / targetBB.middle) * 100;
      if (targetHbb <= 0) {
        await sleep(80);
        continue;
      }

      const x = targetBd5 / targetHbb;

      // 7. Khớp tín hiệu
      const isLong = passPreLong && x > -0.4;
      const isShort = passPreShort && x < -0.4;

      if (!isLong && !isShort) {
        await sleep(80);
        continue;
      }

      const signalType = isLong ? 'LONG' : 'SHORT';
      const change24hStr = `${coin.change24hVal > 0 ? '+' : ''}${coin.change24hVal.toFixed(2)}%`;
      const diffema20_15mStr = `${diff15mVal > 0 ? '+' : ''}${diff15mVal.toFixed(2)}%`;
      const diffema20_5mStr = `${diff5mVal > 0 ? '+' : ''}${diff5mVal.toFixed(2)}%`;
      const diffema10_5mStr = `${diff5mEma10Val > 0 ? '+' : ''}${diff5mEma10Val.toFixed(2)}%`;
      const hbbStr = `${hbbPercent.toFixed(2)}%`;
      const bd5Str = `${bd5 > 0 ? '+' : ''}${bd5.toFixed(2)}%`;
      const xRatioStr = x.toFixed(3);

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
        xRatio: xRatioStr,
        Hbb: hbbStr,
        diffema20_15m: diffema20_15mStr,
        diffema20_5m: diffema20_5mStr,
        diffema10_5m: diffema10_5mStr,
        bd5: bd5Str,
        bd24h: change24hStr,
        link,
        teleSent: !isCooldown
      });

      // Gửi Telegram
      if (!isCooldown) {
        const icon = isLong ? '🟢' : '🔴';
        const message =
          `${icon} <b>${signalType}: ${coinName}</b>\n` +
          `• <b>x:</b> ${xRatioStr}\n` +
          `• <b>Hbb:</b> ${hbbStr}\n` +
          `• <b>diffema20 (15m):</b> ${diffema20_15mStr}\n` +
          (isShort ? `• <b>diffema20 (5m):</b> ${diffema20_5mStr}\n` : '') +
          (isShort ? `• <b>diffema10 (5m):</b> ${diffema10_5mStr}\n` : '') +
          `• <b>bd5:</b> ${bd5Str}\n` +
          `• <b>bd24h:</b> ${change24hStr}\n` +
          `• <a href="${link}">OKX</a>`;

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

    console.log('\n--- THỐNG KÊ SỐ LƯỢNG COIN THỎA ĐIỀU KIỆN ---');
    console.log(`Số coin tải nến 15m thành công: ${countValid15m}/${targetCoins.length}`);
    console.table([
      { 'Giai đoạn': `1. Đạt diffema20 15m (>${MIN_DIFF_EMA20_15M}%)`, 'Số lượng': count15mQualified },
      { 'Giai đoạn': '2. Đạt Hbb > 4% (trên 5m)', 'Số lượng': countHbbFilter },
      { 'Giai đoạn': '3. KHỚP TẤT CẢ LONG (bbd<0.3%, bd5>-1%, x>-0.4)', 'Số lượng': countMatchedLong },
      { 'Giai đoạn': `4. KHỚP TẤT CẢ SHORT (bd24h>${MIN_CHANGE_24H}%, ema10<0.5%, bbm>-0.3%, bd5<1%, x<-0.4)`, 'Số lượng': countMatchedShort }
    ]);

    if (scanResults.matched.length > 0) {
      console.table(scanResults.matched);
    } else {
      console.log('Không có coin nào thỏa mãn tất cả tiêu chí.');
    }

    console.log(`📁 File kết quả đã lưu: ${RESULTS_FILE}`);
    console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---\n');
  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
