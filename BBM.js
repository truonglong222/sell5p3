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
    console.log('=== BẮT ĐẦU QUÉT TÍN HIỆU SHORT (RSI 15M > 80% & DIFFRSI5 > 5%) ===\n');

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

      // 2. Lấy nến 15m
      const candles15m = await getCandles(symbol, '15m', 80);
      if (!candles15m || candles15m.length < 35) {
        await sleep(60);
        continue;
      }

      const chronological15m = [...candles15m].reverse();
      const closes15m = chronological15m.map((c) => parseFloat(c[4]));

      const rsiSeries15m = calculateRSIArray(closes15m, 14);
      if (rsiSeries15m.length < 6) {
        await sleep(60);
        continue;
      }

      // RSI nến hiện tại đang chạy ([0] theo API gốc OKX)
      const currentRsi = rsiSeries15m[rsiSeries15m.length - 1];

      // RSI nến số 5 (cách 5 nến trước đó)
      const rsiCandle5 = rsiSeries15m[rsiSeries15m.length - 1 - 5];

      // Điều kiện 1: RSI hiện tại > 80
      if (currentRsi <= 80) {
        await sleep(60);
        continue;
      }

      // Điều kiện 2: diffrsi5 > 5%
      const diffRsi5 = currentRsi - rsiCandle5;
      if (diffRsi5 <= 5) {
        await sleep(60);
        continue;
      }

      // 3. Lấy nến 5m để tính Hbb của nến vừa đóng
      const candles5m = await getCandles(symbol, '5m', 40);
      if (!candles5m || candles5m.length < 25) {
        await sleep(60);
        continue;
      }

      // Nến 5m vừa đóng là index 1, tính 20 nến từ 1 đến 20
      const closesBB5m = candles5m.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
      const bb5m = calculateBollingerBands(closesBB5m, 20);

      if (!bb5m || bb5m.middle <= 0) {
        await sleep(60);
        continue;
      }

      // Hbb = ((Upper - Lower) / Middle) * 100
      const Hbb = ((bb5m.upper - bb5m.lower) / bb5m.middle) * 100;

      // 4. Chuẩn bị gửi Telegram
      const coinName = symbol.replace('-USDT-SWAP', '');
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      const rsiCurrentStr = currentRsi.toFixed(2);
      const diffRsi5Str = `${diffRsi5 > 0 ? '+' : ''}${diffRsi5.toFixed(2)}%`;
      const hbbStr = `${Hbb.toFixed(2)}%`;

      const message =
        `🔴 <b>SHORT: ${coinName}</b>\n` +
        `• <b>RSI hiện tại:</b> ${rsiCurrentStr}\n` +
        `• <b>diffrsi5:</b> ${diffRsi5Str}\n` +
        `• <b>Hbb (5m):</b> ${hbbStr}\n` +
        `• <a href="${link}">Link OKX</a>`;

      console.log(`🚀 [SHORT] Đạt điều kiện! Đang gửi Telegram cho ${symbol}...`);

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
          type: 'SHORT',
          rsiCurrent: rsiCurrentStr,
          diffrsi5: diffRsi5Str,
          Hbb: hbbStr,
          link,
          time: new Date().toISOString()
        });
      }

      await sleep(100);
    }

    if (hasNewAlert) saveSentLog(sentLog);
    saveScanResults(scanResults);

    console.log(`\n=== HOÀN TẤT: Có ${scanResults.matched.length} coin gửi tín hiệu thành công. ===\n`);
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
