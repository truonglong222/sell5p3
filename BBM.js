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
const RESULTS_FILE = path.join(__dirname, 'scan_results.json');

// Cấu hình Cooldown & Ngưỡng lọc
const COOLDOWN_TIME = 1 * 60 * 60 * 1000; // 1 giờ
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
    for (const [coin, timestamp] of Object.entries(logData)) {
      if (now - timestamp < COOLDOWN_TIME) {
        cleanedLog[coin] = timestamp;
      }
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
  } catch (e) {}
}

function saveScanResults(results) {
  try {
    const outputData = {
      lastScanAt: new Date().toISOString(),
      matchedCount: results.matched.length,
      matchedList: results.matched
    };
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(outputData, null, 2), 'utf8');
  } catch (e) {
    console.error('Lỗi khi lưu kết quả scan:', e.message);
  }
}

// ------------------- HÀM TÍNH TOÁN KỸ THUẬT -------------------

// Tính RSI (Wilder's Smoothing chu kỳ 20)
function calculateRSIArray(closes, period = 20) {
  if (closes.length <= period) return [];

  const rsiArray = [];
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  rsiArray.push(100 - (100 / (1 + rs)));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiArray.push(100 - (100 / (1 + rs)));
  }

  return rsiArray;
}

function calculateBBMiddle(prices, period = 20) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ------------------- LỌC THỊ TRƯỜNG & LẤY NẾN -------------------

async function getFilteredMarkets() {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') return { allSwapsCount: 0, targetCoins: [] };

    const tickers = res.data.data.filter((item) => item.instId.endsWith('-USDT-SWAP'));
    const targetCoins = tickers
      .filter((item) => parseFloat(item.volCcy24h || 0) > MIN_VOL_CCY24H)
      .map((item) => ({
        instId: item.instId,
        volCcy24h: parseFloat(item.volCcy24h || 0)
      }));

    return {
      allSwapsCount: tickers.length,
      targetCoins
    };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { allSwapsCount: 0, targetCoins: [] };
  }
}

async function getCandles(symbol, bar = '5m', limit = 100) {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 6000 });
    if (!res.data || res.data.code !== '0' || !Array.isArray(res.data.data)) return null;
    return res.data.data;
  } catch (error) {
    console.error(`Lỗi lấy nến ${bar} (${symbol}):`, error.message);
    return null;
  }
}

// ------------------- TIẾN TRÌNH CHÍNH -------------------

async function main() {
  try {
    console.log('=== BẮT ĐẦU QUÉT TÍN HIỆU LONG (RSI(20) 15M > 65 & BBM 5M) ===\n');

    const sentLog = loadSentLog();
    const currentTime = Date.now();
    let hasNewAlert = false;

    // 1. Lọc Volume > 5M USDT
    const { allSwapsCount, targetCoins } = await getFilteredMarkets();

    // Khởi tạo bộ đếm thống kê
    const stats = {
      allSwaps: allSwapsCount,
      passedVol5M: targetCoins.length,
      inCooldown: 0,
      readyCooldown: 0,
      passedRsi65: 0,
      passedGreenCandle1: 0,
      passedRedCandle2: 0, // Đếm nến số 2 là nến đỏ
      passedBbmRange: 0,
      totalMatched: 0,
      sentTelegramSuccess: 0
    };

    const scanResults = { matched: [] };

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // Kiểm tra Cooldown 1h
      const lastSent = sentLog[symbol] || 0;
      if (currentTime - lastSent < COOLDOWN_TIME) {
        stats.inCooldown++;
        continue;
      }
      stats.readyCooldown++;

      // 2. Lấy nến 15m để tính RSI(20)
      const candles15m = await getCandles(symbol, '15m', 80);
      if (!candles15m || candles15m.length < 45) {
        await sleep(60);
        continue;
      }

      const chronological15m = [...candles15m].reverse();
      const closes15m = chronological15m.map((c) => parseFloat(c[4]));

      const rsiSeries15m = calculateRSIArray(closes15m, 20);
      if (rsiSeries15m.length === 0) {
        await sleep(60);
        continue;
      }

      const currentRsi15m = rsiSeries15m[rsiSeries15m.length - 1];

      // Điều kiện 1: RSI 15m > 65
      if (currentRsi15m <= 65) {
        await sleep(60);
        continue;
      }
      stats.passedRsi65++;

      // 3. Lấy nến 5m
      const candles5m = await getCandles(symbol, '5m', 40);
      if (!candles5m || candles5m.length < 25) {
        await sleep(60);
        continue;
      }

      // Nến số 1: kiểm tra nến xanh (close > open)
      const open1 = parseFloat(candles5m[1][1]);
      const close1 = parseFloat(candles5m[1][4]);
      const isGreenCandle1 = close1 > open1;

      if (!isGreenCandle1) {
        await sleep(60);
        continue;
      }
      stats.passedGreenCandle1++;

      // Nến số 2: kiểm tra nến giảm (close < open)
      const open2 = parseFloat(candles5m[2][1]);
      const close2 = parseFloat(candles5m[2][4]);
      const isRedCandle2 = close2 < open2;

      if (!isRedCandle2) {
        await sleep(60);
        continue;
      }
      stats.passedRedCandle2++;

      // Nến số 2: tính bbm & hbm
      const low2 = parseFloat(candles5m[2][3]);
      const high2 = parseFloat(candles5m[2][2]); // Giá High của nến 2
      const closesBB2 = candles5m.slice(2, 22).map((c) => parseFloat(c[4])).reverse();
      const bbMiddle2 = calculateBBMiddle(closesBB2, 20);

      if (!bbMiddle2 || bbMiddle2 <= 0) {
        await sleep(60);
        continue;
      }

      const bbm = ((low2 - bbMiddle2) / bbMiddle2) * 100;
      const hbm = ((high2 - bbMiddle2) / bbMiddle2) * 100; // Tính Hbb (%)

      // Điều kiện 3: -1% < bbm < 0.5%
      if (bbm <= -1 || bbm >= 0.5) {
        await sleep(60);
        continue;
      }
      stats.passedBbmRange++;
      stats.totalMatched++;

      // 4. Chuẩn bị gửi Telegram
      const coinName = symbol.replace('-USDT-SWAP', '');
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      const rsiStr = currentRsi15m.toFixed(2);
      const bbmStr = `${bbm > 0 ? '+' : ''}${bbm.toFixed(2)}%`;
      const hbmStr = `${hbm > 0 ? '+' : ''}${hbm.toFixed(2)}%`;
      const changeCandle1 = (((close1 - open1) / open1) * 100).toFixed(2);
      const changeCandle2 = (((close2 - open2) / open2) * 100).toFixed(2);
      const volFormatted = `$${(coin.volCcy24h / 1_000_000).toFixed(2)}M USDT`;

      const message =
        `🟢 <b>LONG: ${coinName}</b>\n` +
        `• <b>RSI(20) (15m):</b> ${rsiStr}%\n` +
        `• <b>bbm (5m nến 2):</b> ${bbmStr}\n` +
        `• <b>Hbb (5m nến 2):</b> ${hbmStr}\n` +
        `• <b>Nến 1 (5m):</b> Tăng (+${changeCandle1}%)\n` +
        `• <b>Nến 2 (5m):</b> Giảm (${changeCandle2}%)\n` +
        `• <b>Volume 24h:</b> ${volFormatted}\n` +
        `• <a href="${link}">Link OKX</a>`;

      console.log(`🚀 [LONG] Đạt tất cả điều kiện! Đang gửi Telegram cho ${symbol}...`);

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
        console.error(`Lỗi gửi Telegram (${symbol}):`, err.message);
      }

      if (isSentSuccess) {
        stats.sentTelegramSuccess++;
        sentLog[symbol] = currentTime;
        hasNewAlert = true;

        scanResults.matched.push({
          symbol,
          type: 'LONG',
          rsi15m: rsiStr,
          bbm: bbmStr,
          hbb: hbmStr,
          candle1Change: `+${changeCandle1}%`,
          candle2Change: `${changeCandle2}%`,
          vol24h: volFormatted,
          link,
          time: new Date().toISOString()
        });
      }

      await sleep(100);
    }

    if (hasNewAlert) saveSentLog(sentLog);
    saveScanResults(scanResults);

    // ================= BÁO CÁO THỐNG KÊ DẠNG VĂN BẢN =================
    console.log('\n--- BÁO CÁO THỐNG KÊ SỐ LƯỢNG COIN THỎA MÃN TỪNG ĐIỀU KIỆN ---');
    console.log(`Tổng số cặp USDT-SWAP quét được: ${stats.allSwaps} coin.`);
    console.log(`Số coin đạt Volume 24h trên 5 triệu USDT: ${stats.passedVol5M} coin.`);
    console.log(`Số coin đang trong thời gian Cooldown (1h): ${stats.inCooldown} coin.`);
    console.log(`Số coin sẵn sàng quét (không dính Cooldown): ${stats.readyCooldown} coin.`);
    console.log('');
    console.log('[Kết quả lọc qua các tầng kỹ thuật]');
    console.log(`- Số coin thỏa mãn RSI(20) 15m > 65%: ${stats.passedRsi65} coin.`);
    console.log(`- Số coin (đã qua RSI 65%) có nến 5m số 1 là nến xanh: ${stats.passedGreenCandle1} coin.`);
    console.log(`- Số coin (đã qua nến 1 xanh) có nến 5m số 2 là nến đỏ: ${stats.passedRedCandle2} coin.`);
    console.log(`- Số coin (đã qua các điều kiện trên) có -1% < bbm < 0.5%: ${stats.passedBbmRange} coin.`);
    console.log('');
    console.log(`Tổng số coin thỏa mãn toàn bộ điều kiện LONG: ${stats.totalMatched} coin.`);
    console.log(`Số tín hiệu LONG gửi Telegram thành công: ${stats.sentTelegramSuccess} coin.`);
    console.log('-------------------------------------------------------------\n');

    if (scanResults.matched.length > 0) {
      console.log('--- DANH SÁCH COIN ĐÃ PHÁT TÍN HIỆU ---');
      scanResults.matched.forEach((item, index) => {
        console.log(`${index + 1}. [LONG] ${item.symbol} -> RSI(20) 15m: ${item.rsi15m}%, bbm: ${item.bbm}, Hbb: ${item.hbb}, nến 1: ${item.candle1Change}, nến 2: ${item.candle2Change}, Vol: ${item.vol24h}`);
      });
      console.log('');
    }

    console.log(`Kết quả chi tiết đã được ghi vào file: ${RESULTS_FILE}`);
    console.log('=== HOÀN TẤT QUÉT THỊ TRƯỜNG ===\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
