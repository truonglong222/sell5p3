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

// Cấu hình Cooldown
const COOLDOWN_LONG = 12 * 60 * 60 * 1000; // 12 tiếng
const COOLDOWN_SHORT = 2 * 60 * 60 * 1000;  // 2 tiếng
const MIN_VOL_CCY24H = 5_000_000;          // Volume 24h > 5 triệu USDT

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
      if (timeData.longAlert && now - timeData.longAlert < COOLDOWN_LONG) {
        temp.longAlert = timeData.longAlert;
      }
      if (timeData.shortAlert && now - timeData.shortAlert < COOLDOWN_SHORT) {
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

// ------------------- HÀM TÍNH TOÁN KĨ THUẬT -------------------

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

function calculateEMAArray(prices, period = 30) {
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

async function getCandles(symbol, bar = '5m', limit = 150) {
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

    // Lọc Volume > 5M USDT
    const { allSwapsCount, volPassedCoins } = await getFilteredMarkets();

    // Lọc bd24h > 5%
    const targetCoins = volPassedCoins.filter((coin) => coin.change24hVal > 5);

    // Bộ đếm thống kê từng điều kiện
    const stats = {
      allSwaps: allSwapsCount,
      passedVol5M: volPassedCoins.length,
      passedBd24h: targetCoins.length,
      // Đếm các coin thỏa mãn từng chỉ số kỹ thuật độc lập
      passedDiffema30: 0,
      passedHbb: 0,
      passedBbd: 0,
      passedBbt: 0,
      passedBdn1Bullish: 0,
      passedBdn1Bearish: 0,
      // Điều kiện lọc theo nhánh Long
      longReadyCooldown: 0,
      longMatched: 0,
      // Điều kiện lọc theo nhánh Short
      inLongCooldownList: 0,
      shortReadyCooldown: 0,
      shortMatched: 0
    };

    const scanResults = {
      targetCoins,
      matched: []
    };

    let countMatchedLong = 0;
    let countMatchedShort = 0;

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      if (!sentLog[symbol]) sentLog[symbol] = {};
      const inLongCooldown = currentTime - (sentLog[symbol].longAlert || 0) < COOLDOWN_LONG;
      const inShortCooldown = currentTime - (sentLog[symbol].shortAlert || 0) < COOLDOWN_SHORT;

      if (!inLongCooldown) {
        stats.longReadyCooldown++;
      } else {
        stats.inLongCooldownList++;
        if (!inShortCooldown) {
          stats.shortReadyCooldown++;
        }
      }

      if (inLongCooldown && inShortCooldown) {
        continue;
      }

      const candles5m = await getCandles(symbol, '5m', 150);
      if (!candles5m || candles5m.length < 100) {
        await sleep(60);
        continue;
      }

      const closed5m = candles5m.slice(1).reverse();
      const closedPrices5m = closed5m.map((c) => parseFloat(c[4]));

      // 1. Tính diffema30
      const ema30Series5m = calculateEMAArray(closedPrices5m, 30);
      if (ema30Series5m.length < 30) {
        await sleep(60);
        continue;
      }

      const ema30_n1 = ema30Series5m[ema30Series5m.length - 1];
      const ema30_n30 = ema30Series5m[ema30Series5m.length - 30];
      if (ema30_n30 <= 0) {
        await sleep(60);
        continue;
      }

      const diffema30_5m = ((ema30_n1 - ema30_n30) / ema30_n30) * 100;
      if (diffema30_5m > 3) stats.passedDiffema30++;

      // 2. Tính Bollinger Bands trên nến 2
      const candle2 = candles5m[2];
      const high2 = parseFloat(candle2[2]);
      const low2 = parseFloat(candle2[3]);

      const closesBB2 = candles5m.slice(2, 22).map((c) => parseFloat(c[4])).reverse();
      const bb2 = calculateBollingerBands(closesBB2, 20);

      if (!bb2 || bb2.middle <= 0) {
        await sleep(60);
        continue;
      }

      const Hbb = ((bb2.upper - bb2.lower) / bb2.middle) * 100;
      const bbd = low2 - bb2.lower;
      const bbt = high2 - bb2.upper;

      if (Hbb > 3) stats.passedHbb++;
      if (bbd < 0) stats.passedBbd++;
      if (bbt > 0) stats.passedBbt++;

      // 3. Tính bdn1
      const candle1 = candles5m[1];
      const open1 = parseFloat(candle1[1]);
      const close1 = parseFloat(candle1[4]);
      if (open1 <= 0) {
        await sleep(60);
        continue;
      }
      const bdn1 = ((close1 - open1) / open1) * 100;

      if (bdn1 > 0) stats.passedBdn1Bullish++;
      if (bdn1 < 0) stats.passedBdn1Bearish++;

      let isLong = false;
      let isShort = false;

      // KIỂM TRA ĐIỀU KIỆN TÍN HIỆU
      // Long: Chưa dính cooldown Long, diffema30 > 3%, Hbb > 3%, bbd < 0, bdn1 > 0%
      if (!inLongCooldown) {
        if (diffema30_5m > 3 && Hbb > 3 && bbd < 0 && bdn1 > 0) {
          isLong = true;
          stats.longMatched++;
        }
      }

      // Short: Đang trong cooldown Long (< 12h), chưa dính cooldown Short (< 2h), Hbb > 3%, bbt > 0, bdn1 < 0%
      if (inLongCooldown && !inShortCooldown) {
        if (Hbb > 3 && bbt > 0 && bdn1 < 0) {
          isShort = true;
          stats.shortMatched++;
        }
      }

      if (!isLong && !isShort) {
        await sleep(60);
        continue;
      }

      const signalType = isLong ? 'LONG' : 'SHORT';
      const coinName = symbol.replace('-USDT-SWAP', '');
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      const hbbStr = `${Hbb.toFixed(2)}%`;
      const diffema30Str = `${diffema30_5m > 0 ? '+' : ''}${diffema30_5m.toFixed(2)}%`;
      const bd24Str = `${coin.change24hVal > 0 ? '+' : ''}${coin.change24hVal.toFixed(2)}%`;
      const bdn1Str = `${bdn1 > 0 ? '+' : ''}${bdn1.toFixed(2)}%`;

      // GỬI TELEGRAM THEO THỨ TỰ: Hbb, diffema30, bd24, bdn1
      const icon = isLong ? '🟢' : '🔴';
      const message =
        `${icon} <b>${signalType}: ${coinName}</b>\n` +
        `• <b>Hbb:</b> ${hbbStr}\n` +
        `• <b>diffema30:</b> ${diffema30Str}\n` +
        `• <b>bd24:</b> ${bd24Str}\n` +
        `• <b>bdn1:</b> ${bdn1Str}\n` +
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
        if (isLong) {
          countMatchedLong++;
          sentLog[symbol].longAlert = currentTime;
        }
        if (isShort) {
          countMatchedShort++;
          sentLog[symbol].shortAlert = currentTime;
        }

        scanResults.matched.push({
          symbol,
          type: signalType,
          Hbb: hbbStr,
          diffema30: diffema30Str,
          bd24: bd24Str,
          bdn1: bdn1Str,
          link,
          teleSent: true
        });

        hasNewAlert = true;
      }

      await sleep(60);
    }

    if (hasNewAlert) saveSentLog(sentLog);
    saveScanResults(scanResults);

    // ================= LOG SỐ LƯỢNG THỎA MÃN TỪNG ĐIỀU KIỆN (DẠNG VĂN BẢN) =================
    console.log('\n--- BÁO CÁO THỐNG KÊ SỐ LƯỢNG COIN THỎA MÃN TỪNG ĐIỀU KIỆN ---');
    console.log(`Tổng số cặp USDT-SWAP quét được: ${stats.allSwaps} coin.`);
    console.log(`Số coin đạt Volume 24h trên 5 triệu USDT: ${stats.passedVol5M} coin.`);
    console.log(`Số coin đạt biên độ bd24h > 5%: ${stats.passedBd24h} coin.`);
    console.log('');
    console.log(`[Thống kê kỹ thuật trên danh sách bd24h > 5%]`);
    console.log(`- Số coin có diffema30 > 3%: ${stats.passedDiffema30} coin.`);
    console.log(`- Số coin có Hbb > 3%: ${stats.passedHbb} coin.`);
    console.log(`- Số coin có bbd < 0 (giá thấp nhất nến 2 xuyên qua Lower BB): ${stats.passedBbd} coin.`);
    console.log(`- Số coin có bbt > 0 (giá cao nhất nến 2 xuyên qua Upper BB): ${stats.passedBbt} coin.`);
    console.log(`- Số coin có nến 1 tăng (bdn1 > 0%): ${stats.passedBdn1Bullish} coin.`);
    console.log(`- Số coin có nến 1 giảm (bdn1 < 0%): ${stats.passedBdn1Bearish} coin.`);
    console.log('');
    console.log(`[Thống kê lọc lệnh LONG]`);
    console.log(`- Số coin hợp lệ chưa dính Cooldown Long (12h): ${stats.longReadyCooldown} coin.`);
    console.log(`- Số coin khớp tất cả điều kiện LONG: ${stats.longMatched} coin.`);
    console.log(`- Số tín hiệu LONG gửi Telegram thành công: ${countMatchedLong} coin.`);
    console.log('');
    console.log(`[Thống kê lọc lệnh SHORT]`);
    console.log(`- Số coin đang nằm trong danh sách Cooldown Long (12h): ${stats.inLongCooldownList} coin.`);
    console.log(`- Số coin sẵn sàng vào lệnh Short (chưa dính Cooldown Short 2h): ${stats.shortReadyCooldown} coin.`);
    console.log(`- Số coin khớp tất cả điều kiện SHORT: ${stats.shortMatched} coin.`);
    console.log(`- Số tín hiệu SHORT gửi Telegram thành công: ${countMatchedShort} coin.`);
    console.log('-------------------------------------------------------------\n');

    if (scanResults.matched.length > 0) {
      console.log('--- CHI TIẾT CÁC COIN ĐÃ PHÁT TÍN HIỆU ---');
      scanResults.matched.forEach((item, index) => {
        console.log(
          `${index + 1}. [${item.type}] ${item.symbol} -> Hbb: ${item.Hbb}, diffema30: ${item.diffema30}, bd24: ${item.bd24}, bdn1: ${item.bdn1}`
        );
      });
      console.log('');
    } else {
      console.log('Không có coin nào khớp toàn bộ điều kiện trong lượt quét này.\n');
    }

    console.log(`Kết quả JSON đã được ghi vào file: ${RESULTS_FILE}`);
    console.log('=== HOÀN THÀNH QUÉT THỊ TRƯỜNG ===\n');
  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
