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

// Cấu hình Cooldown: 2 TIẾNG
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
    if (!res.data || res.data.code !== '0') return { step1Count: 0, step2Count: 0, coins: [] };

    const tickers = res.data.data.filter(item => item.instId.endsWith('-USDT-SWAP'));

    // Bước 1: Lọc Volume > 5M
    const step1Coins = tickers
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
      .filter(c => c.volCcy24h > MIN_VOL_CCY24H);

    // Bước 2: Lọc biến động 24h từ -3% đến +3%
    const step2Coins = step1Coins.filter(c => c.change24h >= -3 && c.change24h <= 3);

    return {
      step1Count: step1Coins.length,
      step2Count: step2Coins.length,
      coins: step2Coins
    };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { step1Count: 0, step2Count: 0, coins: [] };
  }
}

// ------------------- LẤY DỮ LIỆU NẾN -------------------

async function getCandles(symbol, bar = '1H', limit = 100) {
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

    // Lọc Tickers
    const marketFilter = await getFilteredMarkets();
    const targetCoins = marketFilter.coins;

    console.log(`📊 [Bước 1] Thỏa điều kiện Vol > 5M USDT: ${marketFilter.step1Count} coin`);
    console.log(`📊 [Bước 2] Thỏa điều kiện biến động 24h (-3% đến +3%): ${marketFilter.step2Count} coin`);

    const scanResults = {
      totalScanned: targetCoins.length,
      matched: []
    };

    let validCandlesCount = 0;
    let validDiffBbmCount = 0;
    let validHbbCount = 0;
    let longCount = 0;
    let shortCount = 0;

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // Lấy dữ liệu nến 1H (tối thiểu 35 nến để tính BBM index 15)
      const candles1h = await getCandles(symbol, '1H', 100);

      if (!candles1h || candles1h.length < 35) {
        await sleep(80);
        continue;
      }
      validCandlesCount++;

      // BBM Nến 1, 8, 15
      const closes1 = candles1h.slice(1, 21).map(c => parseFloat(c[4]));
      const closes8 = candles1h.slice(8, 28).map(c => parseFloat(c[4]));
      const closes15 = candles1h.slice(15, 35).map(c => parseFloat(c[4]));

      const bbm1 = calculateSMA(closes1, 20);
      const bbm8 = calculateSMA(closes8, 20);
      const bbm15 = calculateSMA(closes15, 20);

      if (!bbm1 || !bbm8 || !bbm15) {
        await sleep(80);
        continue;
      }

      // Tính diffbbm giữa Max và Min của 3 BBM
      const maxBbm = Math.max(bbm1, bbm8, bbm15);
      const minBbm = Math.min(bbm1, bbm8, bbm15);

      if (minBbm <= 0) {
        await sleep(80);
        continue;
      }

      const diffbbm = ((maxBbm - minBbm) / minBbm) * 100;

      // Điều kiện lọc diffbbm trong khoảng [-0.5%, +0.5%]
      if (diffbbm < -0.5 || diffbbm > 0.5) {
        await sleep(80);
        continue;
      }
      validDiffBbmCount++;

      // Tính Bollinger Bands 1H tại nến vừa đóng (nến index 1)
      const closedCandle1h = candles1h[1];
      const currentPrice1h = parseFloat(closedCandle1h[4]);

      const closes1hForBB = closes1.slice().reverse();
      const bb1h = calculateBollingerBands(closes1hForBB, 20);

      if (!bb1h || bb1h.lower <= 0 || bb1h.upper <= 0) {
        await sleep(80);
        continue;
      }

      // Tính độ rộng dải Hbb, bbd1h và bbt1h
      const Hbb = ((bb1h.upper - bb1h.lower) / bb1h.lower) * 100;
      const bbd1h = ((currentPrice1h - bb1h.lower) / bb1h.lower) * 100;
      const bbt1h = ((currentPrice1h - bb1h.upper) / bb1h.upper) * 100;

      // Điều kiện Hbb > 3%
      if (Hbb <= 3) {
        await sleep(80);
        continue;
      }
      validHbbCount++;

      // Kiểm tra điều kiện Long / Short
      const isLong = bbd1h > -1 && bbd1h < 0.5;
      const isShort = bbt1h > -0.5 && bbt1h < 1;

      if (isLong) longCount++;
      if (isShort) shortCount++;

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
          diffbbm: diffbbm.toFixed(2) + '%',
          bbd1h: bbd1h.toFixed(2) + '%',
          bbt1h: bbt1h.toFixed(2) + '%',
          change24h: coin.change24h.toFixed(2) + '%',
          teleSent: !isCooldown
        });

        if (!isCooldown) {
          const icon = isLong ? '🟢' : '🔴';
          
          let message = `${icon} <b>TÍN HIỆU ${type} (1H): ${coinName}</b>\n` +
            `• <b>Hbb (1H):</b> ${Hbb.toFixed(2)}%\n` +
            `• <b>diffbbm (1H):</b> ${diffbbm.toFixed(2)}%\n`;

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

    saveScanResults(scanResults);

    console.log('\n================== TIẾN TRÌNH LỌC CHI TIẾT ==================');
    console.log(`🔹 [Bước 3] Lấy nến 1H thành công: ${validCandlesCount}/${targetCoins.length} coin`);
    console.log(`🔹 [Bước 4] Thỏa diffbbm (-0.5% -> +0.5%): ${validDiffBbmCount} coin`);
    console.log(`🔹 [Bước 5] Thỏa Hbb > 3%: ${validHbbCount} coin`);
    console.log(`🔹 [Bước 6] Tín hiệu khớp: ${scanResults.matched.length} (Long: ${longCount}, Short: ${shortCount})`);

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
