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
      totalScanned: results.totalScanned,
      passedEmaCount: results.passedEma.length,
      passedEmaList: results.passedEma,
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

// ------------------- LỌC THỊ TRƯỜNG (VOLUME > 5M & |bd24| > 10%) -------------------

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
      if (change24hVal > 10 || change24hVal < -10) {
        filteredCoins.push({
          instId: item.instId,
          open24h,
          last: lastPrice,
          change24hVal
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
    console.log('--- BẮT ĐẦU QUÉT THỊ TRƯỜNG OKX (LONG: 15m | SHORT: 5m) ---');

    const sentLog = loadSentLog();
    const currentTime = Date.now();
    let hasNewAlert = false;

    // 1. Lọc Volume > 5M USDT và |bd24| > 10%
    const { allSwapsCount, volPassedCount, filteredCoins: targetCoins } = await getFilteredMarkets();
    console.log(
      `📊 [Lọc] Tổng USDT Swap: ${allSwapsCount} | Vol > 5M: ${volPassedCount} | Thỏa |bd24| > 10%: ${targetCoins.length} coin`
    );

    const scanResults = {
      totalScanned: targetCoins.length,
      passedEma: [],
      matched: []
    };

    let countValidCandles = 0;
    let countMatchedEmaLong = 0;
    let countMatchedEmaShort = 0;
    let countMatchedLong = 0;
    let countMatchedShort = 0;

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // Phân luồng nến theo điều kiện bd24h:
      // bd24 < -10% -> Xét LONG trên nến 15m (cần ít nhất 80 nến để tính EMA50)
      // bd24 > +10% -> Xét SHORT trên nến 5m
      const isCandidateLong = coin.change24hVal < -10;
      const isCandidateShort = coin.change24hVal > 10;

      let isEmaValidLong = false;
      let isEmaValidShort = false;
      let diffema50 = 0;
      let diffema20 = 0;
      let bbd = 0;
      let bbt = 0;

      let candles5m = null;
      let candles15m = null;

      if (isCandidateLong) {
        // ================= XÉT LONG TRÊN NẾN 15M =================
        candles15m = await getCandles(symbol, '15m', 100);
        if (!candles15m || candles15m.length < 80) {
          await sleep(80);
          continue;
        }
        countValidCandles++;

        const closedCandles15m = candles15m.slice(1).reverse();
        const closedPrices15m = closedCandles15m.map((c) => parseFloat(c[4]));

        const emaSeries15m = calculateEMAArray(closedPrices15m, 20);
        if (emaSeries15m.length < 50) {
          await sleep(80);
          continue;
        }

        const ema1 = emaSeries15m[emaSeries15m.length - 1];
        const ema20 = emaSeries15m[emaSeries15m.length - 20];
        const ema50 = emaSeries15m[emaSeries15m.length - 50];

        if (!ema20 || ema20 <= 0 || !ema50 || ema50 <= 0) {
          await sleep(80);
          continue;
        }

        diffema50 = ((ema1 - ema50) / ema50) * 100;
        diffema20 = ((ema1 - ema20) / ema20) * 100;

        const isEma20Valid = diffema20 > -1 && diffema20 < 1;
        isEmaValidLong = diffema50 < -3 && isEma20Valid;

        if (isEmaValidLong) {
          countMatchedEmaLong++;
          scanResults.passedEma.push({
            symbol,
            change24h: coin.change24hVal.toFixed(2) + '%',
            diffema50: diffema50.toFixed(2) + '%',
            diffema20: diffema20.toFixed(2) + '%',
            validFor: 'LONG'
          });

          // BB 15m nến đóng gần nhất
          const closesBB15m = candles15m.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
          const bb15m = calculateBollingerBands(closesBB15m, 20);

          if (bb15m && bb15m.lower > 0) {
            const candle0 = candles15m[0];
            const low0 = parseFloat(candle0[3]);
            bbd = ((low0 - bb1.lower || low0 - bb15m.lower) / bb15m.lower) * 100;
          }
        }
      } else if (isCandidateShort) {
        // ================= XÉT SHORT TRÊN NẾN 5M =================
        candles5m = await getCandles(symbol, '5m', 100);
        if (!candles5m || candles5m.length < 80) {
          await sleep(80);
          continue;
        }
        countValidCandles++;

        const closedCandles5m = candles5m.slice(1).reverse();
        const closedPrices5m = closedCandles5m.map((c) => parseFloat(c[4]));

        const emaSeries5m = calculateEMAArray(closedPrices5m, 20);
        if (emaSeries5m.length < 50) {
          await sleep(80);
          continue;
        }

        const ema1 = emaSeries5m[emaSeries5m.length - 1];
        const ema20 = emaSeries5m[emaSeries5m.length - 20];
        const ema50 = emaSeries5m[emaSeries5m.length - 50];

        if (!ema20 || ema20 <= 0 || !ema50 || ema50 <= 0) {
          await sleep(80);
          continue;
        }

        diffema50 = ((ema1 - ema50) / ema50) * 100;
        diffema20 = ((ema1 - ema20) / ema20) * 100;

        const isEma20Valid = diffema20 > -0.5 && diffema20 < 0.5;
        isEmaValidShort = diffema50 > 3 && isEma20Valid;

        if (isEmaValidShort) {
          countMatchedEmaShort++;
          scanResults.passedEma.push({
            symbol,
            change24h: coin.change24hVal.toFixed(2) + '%',
            diffema50: diffema50.toFixed(2) + '%',
            diffema20: diffema20.toFixed(2) + '%',
            validFor: 'SHORT'
          });

          // BB 5m nến đóng gần nhất
          const closesBB5m = candles5m.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
          const bb5m = calculateBollingerBands(closesBB5m, 20);

          if (bb5m && bb5m.upper > 0) {
            const candle0 = candles5m[0];
            const high0 = parseFloat(candle0[2]);
            bbt = ((high0 - bb5m.upper) / bb5m.upper) * 100;
          }
        }
      }

      // Xét điều kiện Entry
      const isLong = isEmaValidLong && bbd > -2 && bbd < 0.5;
      const isShort = isEmaValidShort && bbt > -0.5 && bbt < 2;

      if (!isLong && !isShort) {
        await sleep(80);
        continue;
      }

      // ================= BƯỚC 4: TÍNH HBB 15M (BỔ TRỢ HIỂN THỊ) =================
      let hbb15m = 0;
      let hbb15mPercent = 0;

      // Nếu đã lấy 15m ở trên thì tái sử dụng, nếu chưa thì fetch thêm
      if (!candles15m) {
        candles15m = await getCandles(symbol, '15m', 30);
      }

      if (candles15m && candles15m.length >= 21) {
        const closes15m = candles15m.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
        const bb15m = calculateBollingerBands(closes15m, 20);
        if (bb15m && bb15m.middle > 0) {
          hbb15m = bb15m.upper - bb15m.lower;
          hbb15mPercent = (hbb15m / bb15m.middle) * 100;
        }
      }

      const change24hStr = (coin.change24hVal >= 0 ? '+' : '') + coin.change24hVal.toFixed(2) + '%';
      const signalType = isLong ? 'LONG' : 'SHORT';
      const timeframe = isLong ? '15m' : '5m';

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
        type: `${signalType} (${timeframe})`,
        change24h: change24hStr,
        diffema50: diffema50.toFixed(2) + '%',
        diffema20: diffema20.toFixed(2) + '%',
        bbd: isLong ? bbd.toFixed(2) + '%' : '-',
        bbt: isShort ? bbt.toFixed(2) + '%' : '-',
        hbb15m: hbb15m.toFixed(4),
        hbb15mPercent: hbb15mPercent.toFixed(2) + '%',
        link,
        teleSent: !isCooldown
      });

      // ================= BƯỚC 5: GỬI CẢNH BÁO TELEGRAM =================
      if (!isCooldown) {
        const icon = isLong ? '🟢' : '🔴';
        const entryDetail = isLong
          ? `• <b>bbd:</b> ${bbd.toFixed(2)}% (so với Lower BB 15m)`
          : `• <b>bbt:</b> ${bbt.toFixed(2)}% (so với Upper BB 5m)`;

        const message =
          `${icon} <b>TÍN HIỆU ${signalType} (${timeframe}): ${coinName}</b>\n` +
          `• <b>Biến động 24h:</b> ${change24hStr}\n` +
          `• <b>diffema50 (${timeframe}):</b> ${diffema50.toFixed(2)}%\n` +
          `• <b>diffema20 (${timeframe}):</b> ${diffema20.toFixed(2)}%\n` +
          `${entryDetail}\n` +
          `• <b>Hbb (15m):</b> ${hbb15m.toFixed(4)} (${hbb15mPercent.toFixed(2)}%)\n` +
          `• <a href="${link}">Link OKX</a>`;

        console.log(`🚀 [${signalType} ${timeframe}] Gửi Telegram cho ${symbol}...`);
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

    console.log('\n================== THỐNG KÊ CHI TIẾT ==================');
    console.log(`1️⃣ Thị trường: Tổng Swap = ${allSwapsCount} | Vol > 5M = ${volPassedCount} | |bd24| > 10% = ${targetCoins.length}`);
    console.log(`2️⃣ Dữ liệu nến: Tải thành công = ${countValidCandles}/${targetCoins.length}`);
    console.log(`3️⃣ Lọc EMA Long (15m): ${countMatchedEmaLong} coin`);
    console.log(`   Lọc EMA Short (5m): ${countMatchedEmaShort} coin`);
    console.log(`4️⃣ Tín hiệu LONG khớp: ${countMatchedLong} coin | SHORT khớp: ${countMatchedShort} coin`);

    console.log('\n================== KẾT QUẢ QUÉT ==================');
    if (scanResults.matched.length > 0) {
      console.table(scanResults.matched);
    } else {
      console.log('Không có coin nào thỏa mãn điều kiện.');
    }
    console.log(`📁 File kết quả đã lưu: ${RESULTS_FILE}`);
    console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---\n');
  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
