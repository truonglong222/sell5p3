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
      matchedCount: results.matched.length,
      matchedList: results.matched
    };
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(outputData, null, 2), 'utf8');
  } catch (e) {
    console.error('Lỗi khi lưu 24h.json:', e.message);
  }
}

// ------------------- HÀM TÍNH TOÁN KỸ THUẬT -------------------

function calculateEMAArray(prices, period = 20) {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const emaArray = [];
  
  let sum = 0;
  for (let i = 0; i < period; i++) sum += prices[i];
  let currentEma = sum / period;
  emaArray.push(currentEma);

  for (let i = period; i < prices.length; i++) {
    currentEma = prices[i] * k + currentEma * (1 - k);
    emaArray.push(currentEma);
  }
  return emaArray;
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

// ------------------- LỌC THỊ TRƯỜNG THEO VOLUME VÀ % 24H -------------------
async function getFilteredMarkets() {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') return [];

    const tickers = res.data.data;
    return tickers
      .filter(item => item.instId.endsWith('-USDT-SWAP'))
      .map(item => {
        const last = parseFloat(item.last || 0);
        const open24h = parseFloat(item.open24h || 0);
        const change24h = open24h > 0 ? ((last - open24h) / open24h) * 100 : 0;
        return {
          instId: item.instId,
          lastPrice: last,
          change24h: change24h,
          volCcy24h: parseFloat(item.volCcy24h || 0)
        };
      })
      .filter(c => c.volCcy24h > MIN_VOL_CCY24H && c.change24h >= -5 && c.change24h <= 5);
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return [];
  }
}

// ------------------- LẤY DỮ LIỆU NẾN (OKX API) -------------------
async function getCandles(symbol, bar, limit = 100) {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 6000 });
    if (!res.data || res.data.code !== '0' || res.data.data.length < 45) return null;
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

    // BƯỚC 1: Lọc Market Vol > 5M và biến động 24h
    const targetCoins = await getFilteredMarkets();
    console.log(`🔍 Số coin thỏa mãn điều kiện Vol > 5M và 24h (-5% -> +5%): ${targetCoins.length}`);

    const scanResults = {
      totalScanned: targetCoins.length,
      matched: []
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // BƯỚC 2: Kiểm tra khung 4H (diffema10)
      const candles4h = await getCandles(symbol, '4H', 100);
      if (!candles4h) {
        await sleep(80);
        continue;
      }

      const closes4h = candles4h.map(c => parseFloat(c[4])).reverse();
      const ema4hArray = calculateEMAArray(closes4h, 20);

      if (ema4hArray.length < 11) {
        await sleep(80);
        continue;
      }

      const ema4h0 = ema4hArray[ema4hArray.length - 1];
      const ema4h10 = ema4hArray[ema4hArray.length - 11];
      const diffema10 = ema4h10 > 0 ? ((ema4h0 - ema4h10) / ema4h10) * 100 : 0;

      // Phân loại tiềm năng khung 4H: Long (0 < diffema10 < 2) hoặc Short (-2 < diffema10 < 0)
      const is4hLong = diffema10 > 0 && diffema10 < 2;
      const is4hShort = diffema10 > -2 && diffema10 < 0;

      if (!is4hLong && !is4hShort) {
        await sleep(80);
        continue;
      }

      // BƯỚC 3: Lấy dữ liệu 1H tính diffema1h và Bollinger Bands
      const candles1h = await getCandles(symbol, '1H', 100);
      if (!candles1h) {
        await sleep(80);
        continue;
      }

      // Tính EMA20 trên chuỗi 1H
      const closes1h = candles1h.map(c => parseFloat(c[4])).reverse();
      const ema1hArray = calculateEMAArray(closes1h, 20);

      if (ema1hArray.length < 21) {
        await sleep(80);
        continue;
      }

      // EMA20 nến hiện tại và EMA20 cách 20 nến
      const ema1h0 = ema1hArray[ema1hArray.length - 1];
      const ema1h20 = ema1hArray[ema1hArray.length - 21];
      const diffema1h = ema1h20 > 0 ? ((ema1h0 - ema1h20) / ema1h20) * 100 : 0;

      // Lọc tiếp theo điều kiện diffema1h
      const passDiffema1hLong = is4hLong && (diffema1h > 0 && diffema1h < 3);
      const passDiffema1hShort = is4hShort && (diffema1h > -3 && diffema1h < 0);

      if (!passDiffema1hLong && !passDiffema1hShort) {
        await sleep(80);
        continue;
      }

      // Tính BB(20) dựa trên 20 nến 1H đã đóng gần nhất [1..20]
      const closes1hForBB = candles1h.slice(1, 21).map(c => parseFloat(c[4])).reverse();
      const bb1h = calculateBollingerBands(closes1hForBB, 20);

      if (!bb1h || bb1h.lower <= 0 || bb1h.upper <= 0) {
        await sleep(80);
        continue;
      }

      // Lấy giá High / Low của nến 1H hiện tại [0]
      const currentCandle1h = candles1h[0];
      const high1hCurrent = parseFloat(currentCandle1h[2]);
      const low1hCurrent = parseFloat(currentCandle1h[3]);

      // Tính Hbb, bbd1h, bbt1h
      const Hbb = ((bb1h.upper - bb1h.lower) / bb1h.lower) * 100;
      const bbd1h = ((low1hCurrent - bb1h.lower) / bb1h.lower) * 100;
      const bbt1h = ((high1hCurrent - bb1h.upper) / bb1h.upper) * 100;

      if (Hbb <= 3) {
        await sleep(80);
        continue;
      }

      // BƯỚC 4: Điều kiện cuối cùng
      // Long: passDiffema1hLong VÀ -3% < bbd1h < -0.5%
      const isLong = passDiffema1hLong && (bbd1h > -3 && bbd1h < -0.5);

      // Short: passDiffema1hShort VÀ 0.5% < bbt1h < 3%
      const isShort = passDiffema1hShort && (bbt1h > 0.5 && bbt1h < 3);

      if (isLong || isShort) {
        const type = isLong ? 'LONG' : 'SHORT';
        const coinName = symbol.replace('-USDT-SWAP', '');
        const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

        if (!sentLog[symbol]) sentLog[symbol] = {};
        const lastSentTime = isLong ? sentLog[symbol].longAlert : sentLog[symbol].shortAlert;
        const isCooldown = currentTime - (lastSentTime || 0) < COOLDOWN_TIME;

        scanResults.matched.push({
          symbol,
          type,
          Hbb: Hbb.toFixed(2) + '%',
          diffema10: diffema10.toFixed(2) + '%',
          diffema1h: diffema1h.toFixed(2) + '%',
          bbd1h: isLong ? bbd1h.toFixed(2) + '%' : undefined,
          bbt1h: isShort ? bbt1h.toFixed(2) + '%' : undefined,
          change24h: coin.change24h.toFixed(2) + '%',
          teleSent: !isCooldown
        });

        if (!isCooldown) {
          const icon = isLong ? '🟢' : '🔴';
          const bbField = isLong 
            ? `• <b>bbd1h:</b> ${bbd1h.toFixed(2)}%\n` 
            : `• <b>bbt1h:</b> ${bbt1h.toFixed(2)}%\n`;

          const message = `${icon} <b>TÍN HIỆU ${type}: ${coinName}</b>\n` +
            `• <b>Hbb:</b> ${Hbb.toFixed(2)}%\n` +
            `• <b>diffema10 (4H):</b> ${diffema10.toFixed(2)}%\n` +
            `• <b>diffema1h:</b> ${diffema1h.toFixed(2)}%\n` +
            bbField +
            `• <b>Biến động 24h:</b> ${coin.change24h >= 0 ? '+' : ''}${coin.change24h.toFixed(2)}%\n` +
            `• <a href="${link}">Link OKX</a>`;

          console.log(`🚀 [${type}] Gửi Telegram cho ${symbol}...`);
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

          if (isLong) sentLog[symbol].longAlert = currentTime;
          if (isShort) sentLog[symbol].shortAlert = currentTime;
          hasNewAlert = true;
        }
      }

      await sleep(80);
    }

    if (hasNewAlert) saveSentLog(sentLog);

    saveScanResults(scanResults);

    console.log('\n================== KẾT QUẢ QUÉT ==================');
    console.log(`Số tín hiệu thỏa mãn: ${scanResults.matched.length}`);
    if (scanResults.matched.length > 0) {
      console.table(scanResults.matched);
    }
    console.log(`📁 File kết quả đã lưu: ${RESULTS_FILE}`);
    console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---\n');

  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
