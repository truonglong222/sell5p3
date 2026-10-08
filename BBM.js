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

// Tính RSI (Wilder's Smoothing chu kỳ 14)
function calculateRSIArray(closes, period = 14) {
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

// Tính Middle Band (SMA chu kỳ 20)
function calculateBBMiddle(prices, period = 20) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  return mean;
}

// ------------------- LỌC THỊ TRƯỜNG & LẤY NẾN -------------------

async function getFilteredMarkets() {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') return [];

    const tickers = res.data.data.filter((item) => item.instId.endsWith('-USDT-SWAP'));
    return tickers.filter((item) => parseFloat(item.volCcy24h || 0) > MIN_VOL_CCY24H);
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return [];
  }
}

async function getCandles(symbol, bar = '15m', limit = 100) {
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
    console.log('=== BẮT ĐẦU QUÉT TÍN HIỆU LONG (RSI 15M > 65 & BBM 5M) ===\n');

    const sentLog = loadSentLog();
    const currentTime = Date.now();
    let hasNewAlert = false;

    // 1. Lọc Volume > 5M USDT
    const targetCoins = await getFilteredMarkets();
    console.log(`Tìm thấy ${targetCoins.length} coin đạt Volume > 5M USDT.\n`);

    const scanResults = { matched: [] };

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // Kiểm tra Cooldown 1h
      const lastSent = sentLog[symbol] || 0;
      if (currentTime - lastSent < COOLDOWN_TIME) {
        continue;
      }

      // 2. Lấy nến 15m để tính RSI
      const candles15m = await getCandles(symbol, '15m', 80);
      if (!candles15m || candles15m.length < 35) {
        await sleep(60);
        continue;
      }

      const chronological15m = [...candles15m].reverse();
      const closes15m = chronological15m.map((c) => parseFloat(c[4]));

      const rsiSeries15m = calculateRSIArray(closes15m, 14);
      if (rsiSeries15m.length === 0) {
        await sleep(60);
        continue;
      }

      // RSI nến 15m hiện tại (phần tử cuối cùng)
      const currentRsi15m = rsiSeries15m[rsiSeries15m.length - 1];

      // Điều kiện 1: RSI 15m > 65
      if (currentRsi15m <= 65) {
        await sleep(60);
        continue;
      }

      // 3. Lấy nến 5m để kiểm tra nến số 1 và tính bbm trên nến số 2
      // candles5m[0]: nến đang chạy, [1]: nến số 1 vừa đóng, [2]: nến số 2
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

      // Nến số 2: tính bbm = (low2 - middle2) / middle2 * 100
      const low2 = parseFloat(candles5m[2][3]);

      // Lấy 20 nến đóng cửa tính từ nến số 2 (index 2 đến 21) để tính Middle Band (SMA 20) của nến số 2
      const closesBB2 = candles5m.slice(2, 22).map((c) => parseFloat(c[4])).reverse();
      const bbMiddle2 = calculateBBMiddle(closesBB2, 20);

      if (!bbMiddle2 || bbMiddle2 <= 0) {
        await sleep(60);
        continue;
      }

      const bbm = ((low2 - bbMiddle2) / bbMiddle2) * 100;

      // Điều kiện 2: -1% < bbm < 0.5%
      if (bbm <= -1 || bbm >= 0.5) {
        await sleep(60);
        continue;
      }

      // 4. Chuẩn bị gửi Telegram tín hiệu LONG
      const coinName = symbol.replace('-USDT-SWAP', '');
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      const rsiStr = currentRsi15m.toFixed(2);
      const bbmStr = `${bbm > 0 ? '+' : ''}${bbm.toFixed(2)}%`;
      const changeCandle1 = (((close1 - open1) / open1) * 100).toFixed(2);

      const message =
        `🟢 <b>LONG: ${coinName}</b>\n` +
        `• <b>RSI (15m):</b> ${rsiStr}%\n` +
        `• <b>bbm (5m nến 2):</b> ${bbmStr}\n` +
        `• <b>Nến 1 (5m):</b> Tăng (+${changeCandle1}%)\n` +
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
        sentLog[symbol] = currentTime;
        hasNewAlert = true;

        scanResults.matched.push({
          symbol,
          type: 'LONG',
          rsi15m: rsiStr,
          bbm: bbmStr,
          candle1Change: `+${changeCandle1}%`,
          link,
          time: new Date().toISOString()
        });
      }

      await sleep(100);
    }

    if (hasNewAlert) saveSentLog(sentLog);
    saveScanResults(scanResults);

    console.log(`\n=== HOÀN TẤT: Có ${scanResults.matched.length} coin gửi tín hiệu LONG thành công. ===\n`);
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
