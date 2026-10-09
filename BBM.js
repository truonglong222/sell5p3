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
const COOLDOWN_TIME_SHORT = 1 * 60 * 60 * 1000;  // 1 giờ cho Short
const COOLDOWN_TIME_LONG = 24 * 60 * 60 * 1000;  // 24 giờ cho Long
const MIN_VOL_CCY24H = 5_000_000;                 // Volume 24h > 5 triệu USDT
const MIN_BD24H = 5;                              // Biến động 24h > 5%

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
      const isLong = key.endsWith('_LONG');
      const cooldown = isLong ? COOLDOWN_TIME_LONG : COOLDOWN_TIME_SHORT;
      
      if (now - timestamp < cooldown) {
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

function calculateBollingerBands(prices, period = 20, multiplier = 2) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;

  const variance = slice.reduce((sum, price) => sum + Math.pow(price - mid, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = mid + multiplier * stdDev;
  const lower = mid - multiplier * stdDev;

  return { mid, upper, lower };
}

// ------------------- LỌC THỊ TRƯỜNG & LẤY NẾN -------------------

async function getFilteredMarkets() {
  let allSwaps = 0;
  let passedVol = 0;
  let passedVolAndBd24h = 0;
  const targetCoins = [];

  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') {
      return { allSwaps, passedVol, passedVolAndBd24h, targetCoins };
    }

    const tickers = res.data.data.filter((item) => item.instId.endsWith('-USDT-SWAP'));
    allSwaps = tickers.length;

    for (const item of tickers) {
      const vol = parseFloat(item.volCcy24h || 0);
      const open24h = parseFloat(item.open24h || 0);
      const last = parseFloat(item.last || 0);

      let bd24h = 0;
      if (open24h > 0) {
        bd24h = Math.abs((last - open24h) / open24h) * 100;
      }

      if (vol > MIN_VOL_CCY24H) {
        passedVol++;
        if (bd24h > MIN_BD24H) {
          passedVolAndBd24h++;
          targetCoins.push({
            instId: item.instId,
            volCcy24h: vol
          });
        }
      }
    }

    return { allSwaps, passedVol, passedVolAndBd24h, targetCoins };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { allSwaps, passedVol, passedVolAndBd24h, targetCoins };
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

    const { allSwaps, passedVol, passedVolAndBd24h, targetCoins } = await getFilteredMarkets();

    const stats = {
      allSwaps,
      passedVol,
      passedVolAndBd24h,
      candlesValid: 0,
      
      // Thống kê từng điều kiện SHORT
      shortRsi80: 0,
      shortDiffRsi15: 0,
      shortMatched: 0,
      shortSentSuccess: 0,

      // Thống kê từng điều kiện LONG
      longMaxRsi80: 0,
      longCandlePattern: 0,
      longLowerBB: 0,
      longMatched: 0,
      longSentSuccess: 0
    };

    const scanResults = { matched: [] };

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      const candles15m = await getCandles(symbol, '15m', 80);
      if (!candles15m || candles15m.length < 55) {
        await sleep(60);
        continue;
      }

      const closedCandles = candles15m.slice(1);
      const chronological15m = [...closedCandles].reverse();
      const closes15m = chronological15m.map((c) => parseFloat(c[4]));

      const rsiSeries15m = calculateRSIArray(closes15m, 20);
      if (rsiSeries15m.length < 30) {
        await sleep(60);
        continue;
      }

      stats.candlesValid++;

      const currentRsi15m = rsiSeries15m[rsiSeries15m.length - 1];
      const coinName = symbol.replace('-USDT-SWAP', '');
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
      const volFormatted = `$${(coin.volCcy24h / 1_000_000).toFixed(2)}M USDT`;
      const rsiStr = currentRsi15m.toFixed(2);

      // --- TÍNH BIẾN ĐỘNG BD30 TRÊN 30 NẾN 15M ĐÃ ĐÓNG GẦN NHẤT ---
      const last30Candles = closedCandles.slice(0, 30);
      let maxHigh30 = -Infinity;
      let minLow30 = Infinity;

      for (const c of last30Candles) {
        const h = parseFloat(c[2]);
        const l = parseFloat(c[3]);
        if (h > maxHigh30) maxHigh30 = h;
        if (l < minLow30) minLow30 = l;
      }

      const bd30 = minLow30 > 0 ? ((maxHigh30 - minLow30) / minLow30) * 100 : 0;
      const bd30Str = `${bd30.toFixed(2)}%`;

      // ---------------- KIỂM TRA ĐIỀU KIỆN SHORT ----------------
      const rsi5Prev15m = rsiSeries15m[rsiSeries15m.length - 6];
      const diffRsi5 = currentRsi15m - rsi5Prev15m;
      const shortKey = `${symbol}_SHORT`;
      const lastSentShort = sentLog[shortKey] || 0;

      if (currentRsi15m > 80) {
        stats.shortRsi80++;
        if (diffRsi5 > 15) {
          stats.shortDiffRsi15++;
          if (currentTime - lastSentShort >= COOLDOWN_TIME_SHORT) {
            stats.shortMatched++;
            const diffRsiStr = `${diffRsi5 > 0 ? '+' : ''}${diffRsi5.toFixed(2)}`;

            const shortMsg =
              `🔴 <b>SHORT: ${coinName}</b>\n` +
              `• <b>RSI(20) (15m):</b> ${rsiStr}%\n` +
              `• <b>diffrsi5 (15m):</b> ${diffRsiStr}\n` +
              `• <b>bd30 (15m):</b> ${bd30Str}\n` +
              `• <b>Volume 24h:</b> ${volFormatted}\n` +
              `• <a href="${link}">Link OKX</a>`;

            console.log(`🔻 [SHORT] Đạt điều kiện! Đang gửi Telegram cho ${symbol}...`);

            const isShortSent = await sendTelegramMessage(shortMsg);
            if (isShortSent) {
              stats.shortSentSuccess++;
              sentLog[shortKey] = currentTime;
              hasNewAlert = true;

              scanResults.matched.push({
                symbol,
                type: 'SHORT',
                rsi15m: rsiStr,
                diffrsi5: diffRsiStr,
                bd30: bd30Str,
                vol24h: volFormatted,
                link,
                time: new Date().toISOString()
              });
            }
          }
        }
      }

      // ---------------- KIỂM TRA ĐIỀU KIỆN LONG ----------------
      const longKey = `${symbol}_LONG`;
      const lastSentLong = sentLog[longKey] || 0;

      // 1. Tìm nến có High cao nhất trong 30 nến 15m vừa đóng
      let highestHighIndexIn30 = 0;
      let highestHighVal = -Infinity;

      for (let i = 0; i < last30Candles.length; i++) {
        const h = parseFloat(last30Candles[i][2]);
        if (h > highestHighVal) {
          highestHighVal = h;
          highestHighIndexIn30 = i;
        }
      }

      const highestHighChronoIndex = (chronological15m.length - 1) - highestHighIndexIn30;
      const rsiAtHighestCandle = rsiSeries15m[highestHighChronoIndex];

      if (rsiAtHighestCandle > 80) {
        stats.longMaxRsi80++;

        const candle1 = closedCandles[0];
        const candle2 = closedCandles[1];

        const open1 = parseFloat(candle1[1]);
        const close1 = parseFloat(candle1[4]);
        const isGreenCandle1 = close1 > open1;

        const open2 = parseFloat(candle2[1]);
        const close2 = parseFloat(candle2[4]);
        const low2 = parseFloat(candle2[3]);
        const isRedCandle2 = close2 < open2;

        if (isGreenCandle1 && isRedCandle2) {
          stats.longCandlePattern++;

          const closesBB2 = closedCandles.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
          const bb2 = calculateBollingerBands(closesBB2, 20, 2);

          if (bb2 && low2 < bb2.lower) {
            stats.longLowerBB++;

            if (currentTime - lastSentLong >= COOLDOWN_TIME_LONG) {
              stats.longMatched++;

              const changeCandle1 = (((close1 - open1) / open1) * 100).toFixed(2);
              const changeCandle2 = (((close2 - open2) / open2) * 100).toFixed(2);

              const longMsg =
                `🟢 <b>LONG: ${coinName}</b>\n` +
                `• <b>RSI(20) (15m):</b> ${rsiStr}%\n` +
                `• <b>RSI Nến High Max:</b> ${rsiAtHighestCandle.toFixed(2)}%\n` +
                `• <b>bd30 (15m):</b> ${bd30Str}\n` +
                `• <b>Nến 1 (15m):</b> Tăng (+${changeCandle1}%)\n` +
                `• <b>Nến 2 (15m):</b> Giảm (${changeCandle2}%)\n` +
                `• <b>Low Nến 2:</b> < Lower BB (${low2.toFixed(4)} < ${bb2.lower.toFixed(4)})\n` +
                `• <b>Volume 24h:</b> ${volFormatted}\n` +
                `• <a href="${link}">Link OKX</a>`;

              console.log(`🚀 [LONG] Đạt điều kiện! Đang gửi Telegram cho ${symbol}...`);

              const isLongSent = await sendTelegramMessage(longMsg);
              if (isLongSent) {
                stats.longSentSuccess++;
                sentLog[longKey] = currentTime;
                hasNewAlert = true;

                scanResults.matched.push({
                  symbol,
                  type: 'LONG',
                  rsi15m: rsiStr,
                  rsiHighestCandle: rsiAtHighestCandle.toFixed(2),
                  bd30: bd30Str,
                  candle1Change: `+${changeCandle1}%`,
                  candle2Change: `${changeCandle2}%`,
                  vol24h: volFormatted,
                  link,
                  time: new Date().toISOString()
                });
              }
            }
          }
        }
      }

      await sleep(100);
    }

    if (hasNewAlert) saveSentLog(sentLog);
    saveScanResults(scanResults);

    // ================= BÁO CÁO THỐNG KÊ CHI TIẾT (VĂN BẢN) =================
    console.log('\n================ BÁO CÁO THỐNG KÊ QUÉT THỊ TRƯỜNG ================');
    console.log(`- Tổng số cặp SWAP quét được từ OKX: ${stats.allSwaps} coin`);
    console.log(`- Số coin thỏa mãn Volume 24h > 5M USDT: ${stats.passedVol} coin`);
    console.log(`- Số coin thỏa mãn thêm Biến động 24h (bd24h) > 5%: ${stats.passedVolAndBd24h} coin`);
    console.log(`- Số coin tải thành công đủ dữ liệu nến 15m: ${stats.candlesValid} coin`);
    console.log('');
    console.log('--- ĐIỀU KIỆN SHORT ---');
    console.log(`- Số coin có RSI 15m hiện tại > 80: ${stats.shortRsi80} coin`);
    console.log(`- Số coin có diffrsi5 (RSI hiện tại - RSI 5 nến trước) > 15: ${stats.shortDiffRsi15} coin`);
    console.log(`- Số coin thỏa mãn SHORT và qua Cooldown (1h): ${stats.shortMatched} coin`);
    console.log(`- Số tin nhắn SHORT đã gửi Telegram thành công: ${stats.shortSentSuccess} tin`);
    console.log('');
    console.log('--- ĐIỀU KIỆN LONG ---');
    console.log(`- Số coin có RSI của nến High cao nhất trong 30 nến > 80: ${stats.longMaxRsi80} coin`);
    console.log(`- Số coin thỏa mãn mô hình Nến 1 Tăng VÀ Nến 2 Giảm: ${stats.longCandlePattern} coin`);
    console.log(`- Số coin thỏa mãn thêm Low Nến 2 < Lower BB 15m: ${stats.longLowerBB} coin`);
    console.log(`- Số coin thỏa mãn LONG và qua Cooldown (24h): ${stats.longMatched} coin`);
    console.log(`- Số tin nhắn LONG đã gửi Telegram thành công: ${stats.longSentSuccess} tin`);
    console.log('');
    console.log(`- Tổng số tín hiệu ghi nhận trong phiên: ${scanResults.matched.length}`);
    console.log(`- File kết quả đã lưu: ${RESULTS_FILE}`);
    console.log('==================================================================\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
