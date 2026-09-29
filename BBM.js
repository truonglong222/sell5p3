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

// Tính diffema cho khoảng lag mong muốn
function calculateDiffEma(candles, period = 20, lagBars = 20) {
  if (!candles || candles.length < period + lagBars + 1) return null;
  const closedPrices = candles.slice(1).reverse().map((c) => parseFloat(c[4]));
  const emaSeries = calculateEMAArray(closedPrices, period);

  if (emaSeries.length < lagBars) return null;

  const emaCurrent = emaSeries[emaSeries.length - 1];
  const emaLag = emaSeries[emaSeries.length - lagBars];

  if (!emaLag || emaLag <= 0) return null;

  return ((emaCurrent - emaLag) / emaLag) * 100;
}

// ------------------- LỌC THỊ TRƯỜNG (bd24h > 5%) -------------------

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

      if (change24hVal > 5) {
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

    // STEP 1: Lọc theo Vol > 5M và bd24h > 5%
    const { allSwapsCount, volPassedCount, filteredCoins: rawCoins } = await getFilteredMarkets();
    console.log(
      `📊 Tổng USDT Swap: ${allSwapsCount} | Vol > 5M: ${volPassedCount} | Thỏa bd24h > 5%: ${rawCoins.length} coin`
    );

    // STEP 2: Lọc tiếp Hbb > 3% trên KHUNG NẾN 15M
    console.log(`⏳ Đang kiểm tra điều kiện Hbb > 3% trên khung 15m...`);
    const targetCoins = [];

    for (const coin of rawCoins) {
      const candles15m = await getCandles(coin.instId, '15m', 30);
      if (candles15m && candles15m.length >= 21) {
        const closesBB15m = candles15m.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
        const bb15m = calculateBollingerBands(closesBB15m, 20);

        if (bb15m && bb15m.middle > 0) {
          const hbbPercent = ((bb15m.upper - bb15m.lower) / bb15m.middle) * 100;
          if (hbbPercent > 3) {
            coin.hbb15m = parseFloat(hbbPercent.toFixed(2));
            targetCoins.push(coin);
          }
        }
      }
      await sleep(60);
    }

    console.log(`🎯 Số coin thỏa mãn thêm Hbb (15m) > 3%: ${targetCoins.length} coin`);

    // STEP 3: Tính chỉ số ud (4H) trên danh sách coin đã lọc
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

    const scanResults = {
      ud4h: marketUDStr,
      targetCoins,
      matched: []
    };

    let countValidCandles = 0;

    // Biến đếm thống kê
    let countDiffEma20_15m_Long = 0;
    let countX_Long = 0;
    let countBbmLong = 0;

    let countX_Short = 0;
    let countDiffEma20_15m_Short = 0;
    let countBbtShort = 0;

    let countMatchedLong = 0;
    let countMatchedShort = 0;

    // STEP 4: Kiểm tra chiến lược LONG / SHORT hoàn toàn trên KHUNG 15M
    for (const coin of targetCoins) {
      const symbol = coin.instId;

      const candles15m = await getCandles(symbol, '15m', 65);

      if (!candles15m || candles15m.length < 65) {
        await sleep(80);
        continue;
      }
      countValidCandles++;

      // --- Tính toán Bollinger Bands & Chênh lệch giá nến 15m ---
      const candle0_15m = candles15m[0]; // Nến 15m vừa đóng
      const high0_15m = parseFloat(candle0_15m[2]);
      const low0_15m = parseFloat(candle0_15m[3]);

      const closesBB15m = candles15m.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
      const bb15m = calculateBollingerBands(closesBB15m, 20);

      if (!bb15m || bb15m.lower <= 0 || bb15m.upper <= 0 || bb15m.middle <= 0) {
        await sleep(80);
        continue;
      }

      // bbm: % chênh lệch giữa LOW nến 15m vừa đóng với BB MID
      const bbm15m = ((low0_15m - bb15m.middle) / bb15m.middle) * 100;
      // bbt: % chênh lệch giữa HIGH nến 15m vừa đóng với BB UPPER
      const bbt15m = ((high0_15m - bb15m.upper) / bb15m.upper) * 100;

      // --- Tính toán EMA & x trên khung 15m ---
      const diffema20_15m = calculateDiffEma(candles15m, 20, 20);
      const diffema40_15m = calculateDiffEma(candles15m, 20, 40);

      let xVal = null;
      if (diffema20_15m !== null && diffema40_15m !== null && diffema20_15m !== 0) {
        xVal = diffema40_15m / diffema20_15m;
      }

      // --- ĐÁNH GIÁ ĐIỀU KIỆN LỆNH LONG (15M) ---
      // diffema20(15m) > 4%, x < 1.3, bbm(15m) < 0
      const passDiffEma20_15m_Long = diffema20_15m !== null && diffema20_15m > 4;
      const passX_Long = xVal !== null && xVal < 1.3;
      const passBbmLong = bbm15m < 0;

      if (passDiffEma20_15m_Long) countDiffEma20_15m_Long++;
      if (passX_Long) countX_Long++;
      if (passBbmLong) countBbmLong++;

      const isLong = passDiffEma20_15m_Long && passX_Long && passBbmLong;

      // --- ĐÁNH GIÁ ĐIỀU KIỆN LỆNH SHORT (15M) ---
      // x > 1.7, diffema20(15m) < 2%, bbt(15m) > 0
      const passX_Short = xVal !== null && xVal > 1.7;
      const passDiffEma20_15m_Short = diffema20_15m !== null && diffema20_15m < 2;
      const passBbtShort = bbt15m > 0;

      if (passX_Short) countX_Short++;
      if (passDiffEma20_15m_Short) countDiffEma20_15m_Short++;
      if (passBbtShort) countBbtShort++;

      const isShort = passX_Short && passDiffEma20_15m_Short && passBbtShort;

      if (!isLong && !isShort) {
        await sleep(80);
        continue;
      }

      const signalType = isLong ? 'LONG' : 'SHORT';
      const change24hStr = `+${coin.change24hVal.toFixed(2)}%`;
      const hbbStr = `${coin.hbb15m.toFixed(2)}%`;
      const xStr = xVal !== null ? xVal.toFixed(2) : 'N/A';
      const diffema20_15mStr = diffema20_15m !== null ? `${diffema20_15m.toFixed(2)}%` : 'N/A';

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
        Hbb15m: hbbStr,
        bd24h: change24hStr,
        x: xStr,
        diffema20_15m: diffema20_15mStr,
        bbm15m: bbm15m.toFixed(2) + '%',
        bbt15m: bbt15m.toFixed(2) + '%',
        link,
        teleSent: !isCooldown
      });

      if (!isCooldown) {
        const icon = isLong ? '🟢' : '🔴';
        const message =
          `<b>ud (4H): ${marketUDStr}</b>\n` +
          `${icon} <b>TÍN HIỆU ${signalType} (15m): ${coinName}</b>\n` +
          `• <b>Hbb (15m):</b> ${hbbStr}\n` +
          `• <b>bd24h:</b> ${change24hStr}\n` +
          `• <b>x (15m):</b> ${xStr}\n` +
          `• <b>diffema20 (15m):</b> ${diffema20_15mStr}\n` +
          (isLong
            ? `• <b>bbm (15m):</b> ${bbm15m.toFixed(2)}%\n`
            : `• <b>bbt (15m):</b> ${bbt15m.toFixed(2)}%\n`) +
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

    // Bảng thống kê ngắn gọn
    console.log('\n--- THỐNG KÊ SỐ LƯỢNG COIN THỎA ĐIỀU KIỆN (KHUNG 15M) ---');
    console.log(`Chỉ số thị trường ud (4H): ${marketUDStr}`);
    console.log(`Số coin kiểm tra thành công: ${countValidCandles}/${targetCoins.length}`);
    console.table([
      { 'Điều kiện': 'diffema20(15m) > 4% (Long)', 'Số lượng': countDiffEma20_15m_Long },
      { 'Điều kiện': 'x < 1.3 (Long)', 'Số lượng': countX_Long },
      { 'Điều kiện': 'bbm(15m) < 0 (Long)', 'Số lượng': countBbmLong },
      { 'Điều kiện': 'x > 1.7 (Short)', 'Số lượng': countX_Short },
      { 'Điều kiện': 'diffema20(15m) < 2% (Short)', 'Số lượng': countDiffEma20_15m_Short },
      { 'Điều kiện': 'bbt(15m) > 0 (Short)', 'Số lượng': countBbtShort },
      { 'Điều kiện': 'KHỚP TẤT CẢ LONG', 'Số lượng': countMatchedLong },
      { 'Điều kiện': 'KHỚP TẤT CẢ SHORT', 'Số lượng': countMatchedShort }
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
