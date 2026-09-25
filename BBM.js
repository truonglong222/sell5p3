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
const THRESHOLD_CHANGE_24H = 5;           // bd24h > 5% hoặc < -5%
const MIN_HBB_PERCENT = 3;                // Hbb > 3%

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

      // Lọc bd24h > 5% HOẶC bd24h < -5%
      if (change24hVal > THRESHOLD_CHANGE_24H || change24hVal < -THRESHOLD_CHANGE_24H) {
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

    const coinsUp24h = targetCoins.filter((c) => c.change24hVal > THRESHOLD_CHANGE_24H);
    const countBd24Long = coinsUp24h.length;
    const countBd24Short = targetCoins.filter((c) => c.change24hVal < -THRESHOLD_CHANGE_24H).length;

    // ================= TÍNH UD DỰA TRÊN TẤT CẢ COIN CÓ bd24h > 5% =================
    console.log(`\n⏳ Đang lấy nến 4H vừa đóng của ${coinsUp24h.length} coin (bd24h > 5%) để tính ud...`);
    let totalUpCandles4h = 0;
    let totalDownCandles4h = 0;

    for (const c of coinsUp24h) {
      const candles4h = await getCandles(c.instId, '4H', 3);
      if (candles4h && candles4h.length >= 2) {
        // Nến 0 đang chạy, nến 1 là nến 4H vừa đóng
        const open4h = parseFloat(candles4h[1][1]);
        const close4h = parseFloat(candles4h[1][4]);

        if (close4h > open4h) {
          totalUpCandles4h++;
        } else if (close4h < open4h) {
          totalDownCandles4h++;
        }
      }
      await sleep(60);
    }

    const ud = totalUpCandles4h - totalDownCandles4h;
    const udStr = `${ud > 0 ? '+' : ''}${ud}`;
    console.log(`✅ Kết quả tính ud: Tăng = ${totalUpCandles4h}, Giảm = ${totalDownCandles4h} => ud = ${udStr}\n`);

    let countCandlesOk = 0;

    // Đếm Long
    let countLongDiffEma30 = 0;
    let countLongBd15 = 0;
    let countLongHbb = 0;
    let countLongBbd = 0;
    let countLongMatched = 0;

    // Đếm Short
    let countShortDiffEma30 = 0;
    let countShortBd15 = 0;
    let countShortHbb = 0;
    let countShortBbt = 0;
    let countShortMatched = 0;

    const scanResults = {
      targetCoins,
      matched: []
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      const isPotentialLong = coin.change24hVal > THRESHOLD_CHANGE_24H;
      const isPotentialShort = coin.change24hVal < -THRESHOLD_CHANGE_24H;

      // ================= KIỂM TRA NẾN 15M =================
      const candles15m = await getCandles(symbol, '15m', 80);
      if (!candles15m || candles15m.length < 65) {
        await sleep(80);
        continue;
      }
      countCandlesOk++;

      const closed15m = candles15m.slice(1).reverse().map((c) => parseFloat(c[4]));

      // 1. Tính diffema30 trên nến 15m
      const ema30Series = calculateEMAArray(closed15m, 30);
      if (ema30Series.length < 30) {
        await sleep(80);
        continue;
      }
      const ema30_n1 = ema30Series[ema30Series.length - 1];
      const ema30_n30 = ema30Series[ema30Series.length - 30];
      const diffema30Val = calcDiffPct(ema30_n1, ema30_n30);

      // Điều kiện lọc diffema30 trong khoảng [-1%, +1%]
      const passDiffEma30 = diffema30Val >= -1 && diffema30Val <= 1;
      if (!passDiffEma30) {
        await sleep(80);
        continue;
      }
      if (isPotentialLong) countLongDiffEma30++;
      if (isPotentialShort) countShortDiffEma30++;

      // 2. Thông số nến 1 vừa đóng
      const candle1 = candles15m[1];
      const open1 = parseFloat(candle1[1]);
      const high1 = parseFloat(candle1[2]);
      const low1 = parseFloat(candle1[3]);
      const close1 = parseFloat(candle1[4]);
      const bd15 = open1 > 0 ? ((close1 - open1) / open1) * 100 : 0;

      const passLongBd15 = isPotentialLong && bd15 > -2;
      const passShortBd15 = isPotentialShort && bd15 < 2;

      if (!passLongBd15 && !passShortBd15) {
        await sleep(80);
        continue;
      }
      if (passLongBd15) countLongBd15++;
      if (passShortBd15) countShortBd15++;

      // 3. Bollinger Bands tại nến 1 & Kiểm tra Hbb > 3%
      const closesBB15m = candles15m.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
      const bb15m = calculateBollingerBands(closesBB15m, 20);

      if (!bb15m || bb15m.lower <= 0 || bb15m.upper <= 0 || bb15m.middle <= 0) {
        await sleep(80);
        continue;
      }

      const hbbPercent = ((bb15m.upper - bb15m.lower) / bb15m.middle) * 100;
      if (hbbPercent <= MIN_HBB_PERCENT) {
        await sleep(80);
        continue;
      }

      if (passLongBd15) countLongHbb++;
      if (passShortBd15) countShortHbb++;

      // 4. Kiểm tra bbd (Long) và bbt (Short)
      const bbd = ((low1 - bb15m.lower) / bb15m.lower) * 100;
      const bbt = ((high1 - bb15m.upper) / bb15m.upper) * 100;

      const passLongBbd = passLongBd15 && bbd < 0.5;
      const passShortBbt = passShortBd15 && bbt > -0.5;

      if (!passLongBbd && !passShortBbt) {
        await sleep(80);
        continue;
      }
      if (passLongBbd) countLongBbd++;
      if (passShortBbt) countShortBbt++;

      // 5. Tính tỷ lệ x trên 5 cây nến gần nhất (15m)
      let maxAbsBd15 = -1;
      let targetIndex = 1;
      let targetBd15 = 0;

      for (let i = 1; i <= 5; i++) {
        const cOpen = parseFloat(candles15m[i][1]);
        const cClose = parseFloat(candles15m[i][4]);
        const changePct = cOpen > 0 ? ((cClose - cOpen) / cOpen) * 100 : 0;
        const absVal = Math.abs(changePct);

        if (absVal > maxAbsBd15) {
          maxAbsBd15 = absVal;
          targetIndex = i;
          targetBd15 = changePct;
        }
      }

      const targetClosesBB = candles15m.slice(targetIndex, targetIndex + 20).map((c) => parseFloat(c[4])).reverse();
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

      const x = targetBd15 / targetHbb;

      // 6. Khớp tín hiệu hoàn tất
      const isLong = passLongBbd && x > -0.4;
      const isShort = passShortBbt && x < 0.4;

      if (!isLong && !isShort) {
        await sleep(80);
        continue;
      }

      if (isLong) countLongMatched++;
      if (isShort) countShortMatched++;

      const signalType = isLong ? 'LONG' : 'SHORT';
      const change24hStr = `${coin.change24hVal > 0 ? '+' : ''}${coin.change24hVal.toFixed(2)}%`;
      const diffema30Str = `${diffema30Val > 0 ? '+' : ''}${diffema30Val.toFixed(2)}%`;
      const hbbStr = `${hbbPercent.toFixed(2)}%`;
      const xRatioStr = x.toFixed(3);

      const coinName = symbol.replace('-USDT-SWAP', '');
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      if (!sentLog[symbol]) sentLog[symbol] = {};
      const alertKey = isLong ? 'longAlert' : 'shortAlert';
      const lastSentTime = sentLog[symbol][alertKey];
      const isCooldown = currentTime - (lastSentTime || 0) < COOLDOWN_TIME;

      scanResults.matched.push({
        symbol,
        type: signalType,
        Hbb: hbbStr,
        xRatio: xRatioStr,
        ud: udStr,
        diffema30: diffema30Str,
        bd24h: change24hStr,
        link,
        teleSent: !isCooldown
      });

      // Gửi Telegram theo thứ tự: Hbb, x, ud, diffema30, bd24, link
      if (!isCooldown) {
        const icon = isLong ? '🟢' : '🔴';
        const message =
          `${icon} <b>${signalType}: ${coinName}</b>\n` +
          `• <b>Hbb:</b> ${hbbStr}\n` +
          `• <b>x:</b> ${xRatioStr}\n` +
          `• <b>ud:</b> ${udStr}\n` +
          `• <b>diffema30:</b> ${diffema30Str}\n` +
          `• <b>bd24:</b> ${change24hStr}\n` +
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

    // ================= LOG SỐ LƯỢNG COIN CÒN LẠI SAU TỪNG BƯỚC =================
    console.log('\n--- KẾT QUẢ LỌC THỊ TRƯỜNG ---');
    console.log(`- Tổng số cặp USDT-SWAP: ${allSwapsCount}`);
    console.log(`- Thỏa mãn Vol 24h > 5M: ${volPassedCount}`);
    console.log(`- Thỏa mãn |bd24h| > 5%: ${targetCoins.length} (Tải đủ nến 15m: ${countCandlesOk})`);
    console.log(`- Chỉ số ud thị trường (từ coin bd24h > 5%): ${udStr}`);

    console.log('\n[TIẾN TRÌNH LỌC LONG]');
    console.log(`  1. Thỏa bd24h > 5%: ${countBd24Long}`);
    console.log(`  2. Thỏa diffema30 trong khoảng [-1%, 1%]: ${countLongDiffEma30}`);
    console.log(`  3. Thỏa bd15 > -2%: ${countLongBd15}`);
    console.log(`  4. Thỏa Hbb > 3%: ${countLongHbb}`);
    console.log(`  5. Thỏa bbd < 0.5%: ${countLongBbd}`);
    console.log(`  6. Khớp hoàn tất (x > -0.4): ${countLongMatched}`);

    console.log('\n[TIẾN TRÌNH LỌC SHORT]');
    console.log(`  1. Thỏa bd24h < -5%: ${countBd24Short}`);
    console.log(`  2. Thỏa diffema30 trong khoảng [-1%, 1%]: ${countShortDiffEma30}`);
    console.log(`  3. Thỏa bd15 < 2%: ${countShortBd15}`);
    console.log(`  4. Thỏa Hbb > 3%: ${countShortHbb}`);
    console.log(`  5. Thỏa bbt > -0.5%: ${countShortBbt}`);
    console.log(`  6. Khớp hoàn tất (x < 0.4): ${countShortMatched}`);

    if (scanResults.matched.length > 0) {
      console.log('\nDanh sách khớp tín hiệu:');
      scanResults.matched.forEach((item) => {
        console.log(`- [${item.type}] ${item.symbol} | Hbb: ${item.Hbb} | x: ${item.xRatio} | ud: ${item.ud} | diffema30: ${item.diffema30} | bd24: ${item.bd24h}`);
      });
    } else {
      console.log('\nKhông có coin nào khớp tất cả điều kiện.');
    }

    console.log(`\n📁 File kết quả đã lưu: ${RESULTS_FILE}`);
    console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---\n');
  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
