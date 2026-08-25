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

// Tính mảng EMA (mảng prices theo thứ tự thời gian tăng dần: cũ nhất -> mới nhất)
function calculateEMAArray(prices, period = 20) {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const emaArray = [];
  
  // Giá trị đầu tiên là SMA
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

// Tính Bollinger Bands cho nến đóng gần nhất
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
    if (!res.data || res.data.code !== '0' || res.data.data.length < 50) return null;
    return res.data.data; // Dữ liệu trả về từ nến mới nhất [0] -> nến cũ nhất [limit - 1]
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

      // BƯỚC 2: Lấy nến 1H (limit 100 nến để tính EMA20 và BB)
      const candles1h = await getCandles(symbol, '1H', 100);
      if (!candles1h) {
        await sleep(80);
        continue;
      }

      // Lấy toàn bộ các nến ĐÃ ĐÓNG (bỏ nến [0] đang chạy) theo thứ tự thời gian cũ -> mới
      // closes1hClosed: index 0 là nến cũ nhất, index cuối là nến vừa đóng (nến index 1 trong API)
      const closedCandles = candles1h.slice(1);
      const closes1hClosed = closedCandles.map(c => parseFloat(c[4])).reverse();

      // Tính mảng EMA20 cho khung 1H
      const ema1hArray = calculateEMAArray(closes1hClosed, 20);

      // Cần tối thiểu 25 giá trị EMA để so sánh nến vừa đóng và nến cách 24 cây
      if (ema1hArray.length < 25) {
        await sleep(80);
        continue;
      }

      // ema0: EMA20 nến 1h vừa đóng, ema24: EMA20 cách đó 24 nến
      const ema0 = ema1hArray[ema1hArray.length - 1];
      const ema24 = ema1hArray[ema1hArray.length - 25];
      const diffema24 = ema24 > 0 ? ((ema0 - ema24) / ema24) * 100 : 0;

      // BƯỚC 3: Tính Bollinger Bands 20 nến gần nhất (từ nến vừa đóng)
      const closedCandle1h = candles1h[1];
      const currentPrice1h = parseFloat(closedCandle1h[4]); // Giá close nến 1h vừa đóng

      const closes1hForBB = candles1h.slice(1, 21).map(c => parseFloat(c[4])).reverse();
      const bb1h = calculateBollingerBands(closes1hForBB, 20);

      if (!bb1h || bb1h.lower <= 0 || bb1h.upper <= 0) {
        await sleep(80);
        continue;
      }

      // Tính Hbb, bbd1h, bbt1h
      const Hbb = ((bb1h.upper - bb1h.lower) / bb1h.lower) * 100;
      const bbd1h = ((currentPrice1h - bb1h.lower) / bb1h.lower) * 100;
      const bbt1h = ((currentPrice1h - bb1h.upper) / bb1h.upper) * 100;

      // Điều kiện tiên quyết: Hbb > 3%
      if (Hbb <= 3) {
        await sleep(80);
        continue;
      }

      // BƯỚC 4: Kiểm tra điều kiện Long / Short theo thiết lập mới
      // Long: 1% < diffema24 < 3% VÀ -3% < bbd1h < -0.5%
      const isLong = diffema24 > 1 && diffema24 < 3 && bbd1h > -3 && bbd1h < -0.5;

      // Short: -3% < diffema24 < -1% VÀ 0.5% < bbt1h < 3%
      const isShort = diffema24 > -3 && diffema24 < -1 && bbt1h > 0.5 && bbt1h < 3;

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
          diffema24: diffema24.toFixed(2) + '%',
          bbd1h: bbd1h.toFixed(2) + '%',
          bbt1h: bbt1h.toFixed(2) + '%',
          change24h: coin.change24h.toFixed(2) + '%',
          teleSent: !isCooldown
        });

        if (!isCooldown) {
          const icon = isLong ? '🟢' : '🔴';
          
          // Tạo nội dung tin nhắn Telegram phân loại theo Long/Short
          let message = `${icon} <b>TÍN HIỆU ${type}: ${coinName}</b>\n` +
            `• <b>Hbb:</b> ${Hbb.toFixed(2)}%\n` +
            `• <b>diffema24:</b> ${diffema24.toFixed(2)}%\n`;

          if (isLong) {
            message += `• <b>bbd1h:</b> ${bbd1h.toFixed(2)}%\n`;
          } else {
            message += `• <b>bbt1h:</b> ${bbt1h.toFixed(2)}%\n`;
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

    // Ghi kết quả quét ra file
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
