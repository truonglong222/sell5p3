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
    for (const [key, timestamp] of Object.entries(logData)) {
      if (now - timestamp < COOLDOWN_TIME) {
        cleanedLog[key] = timestamp;
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

// Hàm tính Bollinger Bands (Mid & Upper)
function calculateBollingerBands(prices, period = 20, multiplier = 2) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;

  const variance = slice.reduce((sum, price) => sum + Math.pow(price - mid, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = mid + multiplier * stdDev;

  return { mid, upper };
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

async function sendTelegramMessage(message) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    return true;
  } catch (err) {
    console.error('Lỗi gửi Telegram:', err.message);
    return false;
  }
}

// ------------------- TIẾN TRÌNH CHÍNH -------------------

async function main() {
  try {
    console.log('=== BẮT ĐẦU QUÉT TÍN HIỆU LONG & SHORT ===\n');

    const sentLog = loadSentLog();
    const currentTime = Date.now();
    let hasNewAlert = false;

    const { allSwapsCount, targetCoins } = await getFilteredMarkets();

    const stats = {
      allSwaps: allSwapsCount,
      passedVol5M: targetCoins.length,
      passedRsi65: 0,
      matchedLong: 0,
      sentLongSuccess: 0,
      matchedShort: 0,
      sentShortSuccess: 0
    };

    const scanResults = { matched: [] };

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // 1. Lấy nến 15m để tính RSI(20)
      const candles15m = await getCandles(symbol, '15m', 80);
      if (!candles15m || candles15m.length < 45) {
        await sleep(60);
        continue;
      }

      const chronological15m = [...candles15m].reverse();
      const closes15m = chronological15m.map((c) => parseFloat(c[4]));

      const rsiSeries15m = calculateRSIArray(closes15m, 20);
      if (rsiSeries15m.length < 4) {
        await sleep(60);
        continue;
      }

      const currentRsi15m = rsiSeries15m[rsiSeries15m.length - 1];

      // Điều kiện lọc gốc: RSI 15m > 65
      if (currentRsi15m <= 65) {
        await sleep(60);
        continue;
      }
      stats.passedRsi65++;

      // 2. Lấy nến 5m để kiểm tra điều kiện Long & tính BBM, Hbb
      const candles5m = await getCandles(symbol, '5m', 40);
      if (!candles5m || candles5m.length < 25) {
        await sleep(60);
        continue;
      }

      const coinName = symbol.replace('-USDT-SWAP', '');
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
      const volFormatted = `$${(coin.volCcy24h / 1_000_000).toFixed(2)}M USDT`;
      const rsiStr = currentRsi15m.toFixed(2);

      // Tính BBM và Hbb dựa trên nến 5m số 2
      const low2 = parseFloat(candles5m[2][3]);
      const closesBB2 = candles5m.slice(2, 22).map((c) => parseFloat(c[4])).reverse();
      const bb2 = calculateBollingerBands(closesBB2, 20, 2);

      let bbm = null;
      let hbm = null;
      let bbmStr = 'N/A';
      let hbmStr = 'N/A';

      if (bb2 && bb2.mid > 0) {
        bbm = ((low2 - bb2.mid) / bb2.mid) * 100;
        // Công thức Hbb mới: (Upper Band - Mid Band) / Mid Band * 100
        hbm = ((bb2.upper - bb2.mid) / bb2.mid) * 100;

        bbmStr = `${bbm > 0 ? '+' : ''}${bbm.toFixed(2)}%`;
        hbmStr = `${hbm > 0 ? '+' : ''}${hbm.toFixed(2)}%`;
      }

      // ---------------- KIỂM TRA ĐIỀU KIỆN SHORT ----------------
      // diffrsi3 = RSI hiện tại - RSI nến 15m số 3 trước đó (cách 3 cây nến)
      const rsi3Prev15m = rsiSeries15m[rsiSeries15m.length - 4];
      const diffRsi3 = currentRsi15m - rsi3Prev15m;
      const shortKey = `${symbol}_SHORT`;
      const lastSentShort = sentLog[shortKey] || 0;

      if (currentRsi15m > 80 && diffRsi3 > 10 && (currentTime - lastSentShort >= COOLDOWN_TIME)) {
        stats.matchedShort++;
        const diffRsiStr = `${diffRsi3 > 0 ? '+' : ''}${diffRsi3.toFixed(2)}`;

        const shortMsg =
          `🔴 <b>SHORT: ${coinName}</b>\n` +
          `• <b>RSI(20) (15m):</b> ${rsiStr}%\n` +
          `• <b>diffrsi3 (15m):</b> ${diffRsiStr}\n` +
          `• <b>Hbb (5m nến 2):</b> ${hbmStr}\n` +
          `• <b>Volume 24h:</b> ${volFormatted}\n` +
          `• <a href="${link}">Link OKX</a>`;

        console.log(`🔻 [SHORT] Đạt điều kiện! Đang gửi Telegram cho ${symbol}...`);

        const isShortSent = await sendTelegramMessage(shortMsg);
        if (isShortSent) {
          stats.sentShortSuccess++;
          sentLog[shortKey] = currentTime;
          hasNewAlert = true;

          scanResults.matched.push({
            symbol,
            type: 'SHORT',
            rsi15m: rsiStr,
            diffrsi3: diffRsiStr,
            hbb: hbmStr,
            vol24h: volFormatted,
            link,
            time: new Date().toISOString()
          });
        }
      }

      // ---------------- KIỂM TRA ĐIỀU KIỆN LONG ----------------
      const longKey = `${symbol}_LONG`;
      const lastSentLong = sentLog[longKey] || 0;

      if (currentTime - lastSentLong >= COOLDOWN_TIME) {
        const open1 = parseFloat(candles5m[1][1]);
        const close1 = parseFloat(candles5m[1][4]);
        const isGreenCandle1 = close1 > open1;

        const open2 = parseFloat(candles5m[2][1]);
        const close2 = parseFloat(candles5m[2][4]);
        const isRedCandle2 = close2 < open2;

        if (isGreenCandle1 && isRedCandle2 && bbm !== null && bbm > -1 && bbm < 0.5) {
          stats.matchedLong++;

          const changeCandle1 = (((close1 - open1) / open1) * 100).toFixed(2);
          const changeCandle2 = (((close2 - open2) / open2) * 100).toFixed(2);

          const longMsg =
            `🟢 <b>LONG: ${coinName}</b>\n` +
            `• <b>RSI(20) (15m):</b> ${rsiStr}%\n` +
            `• <b>bbm (5m nến 2):</b> ${bbmStr}\n` +
            `• <b>Hbb (5m nến 2):</b> ${hbmStr}\n` +
            `• <b>Nến 1 (5m):</b> Tăng (+${changeCandle1}%)\n` +
            `• <b>Nến 2 (5m):</b> Giảm (${changeCandle2}%)\n` +
            `• <b>Volume 24h:</b> ${volFormatted}\n` +
            `• <a href="${link}">Link OKX</a>`;

          console.log(`🚀 [LONG] Đạt điều kiện! Đang gửi Telegram cho ${symbol}...`);

          const isLongSent = await sendTelegramMessage(longMsg);
          if (isLongSent) {
            stats.sentLongSuccess++;
            sentLog[longKey] = currentTime;
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
        }
      }

      await sleep(100);
    }

    if (hasNewAlert) saveSentLog(sentLog);
    saveScanResults(scanResults);

    // ================= BÁO CÁO THỐNG KÊ =================
    console.log('\n--- BÁO CÁO THỐNG KÊ CHI TIẾT ---');
    console.log(`Tổng SWAP quét được: ${stats.allSwaps}`);
    console.log(`Đạt Volume > 5M USDT: ${stats.passedVol5M}`);
    console.log(`Thỏa mãn RSI 15m > 65%: ${stats.passedRsi65}`);
    console.log(`- LONG thỏa mãn: ${stats.matchedLong} (Đã gửi TG: ${stats.sentLongSuccess})`);
    console.log(`- SHORT thỏa mãn: ${stats.matchedShort} (Đã gửi TG: ${stats.sentShortSuccess})`);
    console.log(`Tổng tín hiệu ghi nhận: ${scanResults.matched.length}`);
    console.log(`File kết quả: ${RESULTS_FILE}`);
    console.log('=== HOÀN TẤT QUÉT THỊ TRƯỜNG ===\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
