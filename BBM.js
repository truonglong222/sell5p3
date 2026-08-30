import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;
const OKX_BASE_URL = 'https://www.okx.com';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'sent_alerts.json');
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

// Tính SMA (trục giữa Bollinger Bands) cho một mảng giá
function calculateSMA(prices, period = 20) {
  if (prices.length < period) return null;
  const sum = prices.slice(0, period).reduce((a, b) => a + b, 0);
  return sum / period;
}

// ------------------- LỌC THỊ TRƯỜNG -------------------

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

// ------------------- LẤY DỮ LIỆU NẾN -------------------

async function getCandles(symbol, bar, limit = 100) {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 6000 });
    if (!res.data || res.data.code !== '0' || res.data.data.length < 50) return null;
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

    // BƯỚC 1: Lọc Volume > 5M và biến động 24h từ -5% đến +5%
    const targetCoins = await getFilteredMarkets();
    console.log(`🔍 Số coin thỏa mãn điều kiện Vol > 5M và 24h (-5% -> +5%): ${targetCoins.length}`);

    const scanResults = {
      totalScanned: targetCoins.length,
      matched: []
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // BƯỚC 2: Lấy nến 1H và nến 15m
      const [candles1h, candles15m] = await Promise.all([
        getCandles(symbol, '1H', 100),
        getCandles(symbol, '15m', 100)
      ]);

      if (!candles1h || !candles15m || candles1h.length < 45) {
        await sleep(80);
        continue;
      }

      // Nến OKX trả về từ mới nhất -> cũ nhất: candles[0] là nến đang chạy
      // candles1h.slice(1, 21): 20 nến tính từ nến vừa đóng (nến 1)
      const closes1hRecent = candles1h.slice(1, 21).map(c => parseFloat(c[4]));
      // candles1h.slice(21, 41): 20 nến tính từ nến 20 nến trước đó (nến 20)
      const closes1h20Ago = candles1h.slice(21, 41).map(c => parseFloat(c[4]));

      const bbmNow = calculateSMA(closes1hRecent, 20);
      const bbm20Ago = calculateSMA(closes1h20Ago, 20);

      if (!bbmNow || !bbm20Ago || bbm20Ago === 0) {
        await sleep(80);
        continue;
      }

      // diffbbm20: Chênh lệch % giữa BB Mid nến vừa đóng và BB Mid nến số 20 trước đó
      const diffbbm20 = ((bbmNow - bbm20Ago) / bbm20Ago) * 100;

      // BƯỚC 3: Tính Bollinger Bands khung 15m
      const closedCandle15m = candles15m[1];
      const currentPrice15m = parseFloat(closedCandle15m[4]);

      const closes15mForBB = candles15m.slice(1, 21).map(c => parseFloat(c[4])).reverse();
      const bb15m = calculateBollingerBands(closes15mForBB, 20);

      if (!bb15m || bb15m.lower <= 0 || bb15m.upper <= 0) {
        await sleep(80);
        continue;
      }

      // Tính Hbb, bbd15m, bbt15m
      const Hbb = ((bb15m.upper - bb15m.lower) / bb15m.lower) * 100;
      const bbd15m = ((currentPrice15m - bb15m.lower) / bb15m.lower) * 100;
      const bbt15m = ((currentPrice15m - bb15m.upper) / bb15m.upper) * 100;

      // Điều kiện Hbb > 3%
      if (Hbb <= 3) {
        await sleep(80);
        continue;
      }

      // BƯỚC 4: Kiểm tra điều kiện Long / Short với diffbbm20 (Đã cập nhật theo yêu cầu mới)
      const isLong = diffbbm20 > 1 && diffbbm20 < 3 && bbd15m > -2 && bbd15m < 0.5;
      const isShort = diffbbm20 > -3 && diffbbm20 < -1 && bbt15m > -0.5 && bbt15m < 2;

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
          diffbbm20: diffbbm20.toFixed(2) + '%',
          bbd15m: bbd15m.toFixed(2) + '%',
          bbt15m: bbt15m.toFixed(2) + '%',
          change24h: coin.change24h.toFixed(2) + '%',
          teleSent: !isCooldown
        });

        if (!isCooldown) {
          const icon = isLong ? '🟢' : '🔴';
          
          let message = `${icon} <b>TÍN HIỆU ${type}: ${coinName}</b>\n` +
            `• <b>Hbb (15m):</b> ${Hbb.toFixed(2)}%\n` +
            `• <b>diffbbm20 (1H):</b> ${diffbbm20.toFixed(2)}%\n`;

          if (isLong) {
            message += `• <b>bbd15m:</b> ${bbd15m.toFixed(2)}%\n`;
          } else {
            message += `• <b>bbt15m:</b> ${bbt15m.toFixed(2)}%\n`;
          }

          message += `• <b>Biến động 24h:</b> ${coin.change24h >= 0 ? '+' : ''}${coin.change24h.toFixed(2)}%\n` +
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
