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
const FILE_24H = path.join(__dirname, '24h.json');

// Cấu hình Cooldown & Ngưỡng lọc
const COOLDOWN_TIME_LONG = 24 * 60 * 60 * 1000;      // 24 giờ cho Long
const CLEANUP_TIME_24H_FILE = 12 * 60 * 60 * 1000;  // Tự động xóa coin trong 24h.json sau 12 giờ
const MIN_VOL_CCY24H = 5_000_000;                     // Volume 24h > 5 triệu USDT
const MIN_BD24H = 5;                                  // Biến động 24h > 5%

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------- QUẢN LÝ DỮ LIỆU FILE -------------------

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
      if (now - timestamp < COOLDOWN_TIME_LONG) {
        cleanedLog[key] = timestamp;
      }
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
  } catch (e) {}
}

function load24hList() {
  try {
    if (fs.existsSync(FILE_24H)) {
      const data = fs.readFileSync(FILE_24H, 'utf8');
      return data.trim() ? JSON.parse(data) : {};
    }
  } catch (e) {}
  return {};
}

function updateAndSave24hList(list24h, newRsi80Coins) {
  try {
    const now = Date.now();
    
    // Thêm hoặc cập nhật mốc thời gian cho coin mới đạt RSI > 80
    for (const symbol of newRsi80Coins) {
      list24h[symbol] = now;
    }

    // Tự động dọn dẹp coin đã lưu quá 12 giờ
    const cleaned24h = {};
    for (const [symbol, timestamp] of Object.entries(list24h)) {
      if (now - timestamp < CLEANUP_TIME_24H_FILE) {
        cleaned24h[symbol] = timestamp;
      }
    }

    fs.writeFileSync(FILE_24H, JSON.stringify(cleaned24h, null, 2), 'utf8');
    return cleaned24h;
  } catch (e) {
    console.error('Lỗi khi lưu 24h.json:', e.message);
    return list24h;
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
    console.log('=== BẮT ĐẦU QUÉT TÍN HIỆU LONG ===\n');

    const sentLog = loadSentLog();
    let list24h = load24hList();
    const currentTime = Date.now();
    let hasNewAlert = false;

    const { allSwaps, passedVol, passedVolAndBd24h, targetCoins } = await getFilteredMarkets();

    const stats = {
      allSwaps,
      passedVol,
      passedVolAndBd24h,
      candlesValid: 0,
      
      // Thống kê 24h.json
      newRsi80Detected: 0,
      totalIn24hList: 0,

      // Thống kê từng điều kiện LONG
      longIn24hList: 0,
      longCandlePattern: 0,
      longLowerBB: 0,
      longMatched: 0,
      longSentSuccess: 0
    };

    const newRsi80Coins = [];

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      const candles15m = await getCandles(symbol, '15m', 80);
      if (!candles15m || candles15m.length < 35) {
        await sleep(60);
        continue;
      }

      const closedCandles = candles15m.slice(1);
      const chronological15m = [...closedCandles].reverse();
      const closes15m = chronological15m.map((c) => parseFloat(c[4]));

      const rsiSeries15m = calculateRSIArray(closes15m, 20);
      if (rsiSeries15m.length < 10) {
        await sleep(60);
        continue;
      }

      stats.candlesValid++;

      const currentRsi15m = rsiSeries15m[rsiSeries15m.length - 1];
      const coinName = symbol.replace('-USDT-SWAP', '');
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
      const volFormatted = `$${(coin.volCcy24h / 1_000_000).toFixed(2)}M USDT`;
      const rsiStr = currentRsi15m.toFixed(2);

      // --- BƯỚC 1: CẬP NHẬT COIN CÓ RSI 15M HIỆN TẠI > 80 VÀO TẬP LƯU 24H ---
      if (currentRsi15m > 80) {
        newRsi80Coins.push(symbol);
        stats.newRsi80Detected++;
      }

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

      // ---------------- KIỂM TRA ĐIỀU KIỆN LONG ----------------
      const longKey = `${symbol}_LONG`;
      const lastSentLong = sentLog[longKey] || 0;

      // Điều kiện 1: Coin BẮT BUỘC phải nằm trong danh sách 24h.json (hoặc vừa chạm RSI > 80)
      const isIn24hList = !!list24h[symbol] || currentRsi15m > 80;

      if (isIn24hList) {
        stats.longIn24hList++;

        const candle1 = closedCandles[0];
        const candle2 = closedCandles[1];

        const open1 = parseFloat(candle1[1]);
        const close1 = parseFloat(candle1[4]);
        const isGreenCandle1 = close1 > open1; // Nến 1 Tăng

        const open2 = parseFloat(candle2[1]);
        const close2 = parseFloat(candle2[4]);
        const low2 = parseFloat(candle2[3]);
        const isRedCandle2 = close2 < open2;   // Nến 2 Giảm

        // Điều kiện 2: Mô hình Nến 1 Tăng VÀ Nến 2 Giảm
        if (isGreenCandle1 && isRedCandle2) {
          stats.longCandlePattern++;

          const closesBB2 = closedCandles.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
          const bb2 = calculateBollingerBands(closesBB2, 20, 2);

          // Điều kiện 3: Low Nến 2 < Lower BB 15m của Nến 2
          if (bb2 && low2 < bb2.lower) {
            stats.longLowerBB++;

            // Kiểm tra Cooldown 24h
            if (currentTime - lastSentLong >= COOLDOWN_TIME_LONG) {
              stats.longMatched++;

              const changeCandle1 = (((close1 - open1) / open1) * 100).toFixed(2);
              const changeCandle2 = (((close2 - open2) / open2) * 100).toFixed(2);

              const longMsg =
                `🟢 <b>LONG: ${coinName}</b>\n` +
                `• <b>RSI(20) (15m):</b> ${rsiStr}%\n` +
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
              }
            }
          }
        }
      }

      await sleep(100);
    }

    // Cập nhật file 24h.json và sent_ema.json
    list24h = updateAndSave24hList(list24h, newRsi80Coins);
    stats.totalIn24hList = Object.keys(list24h).length;

    if (hasNewAlert) saveSentLog(sentLog);

    // ================= BÁO CÁO THỐNG KÊ CHI TIẾT (VĂN BẢN) =================
    console.log('\n================ BÁO CÁO THỐNG KÊ QUÉT THỊ TRƯỜNG ================');
    console.log(`- Tổng số cặp SWAP quét được từ OKX: ${stats.allSwaps} coin`);
    console.log(`- Số coin thỏa mãn Volume 24h > 5M USDT: ${stats.passedVol} coin`);
    console.log(`- Số coin thỏa mãn thêm Biến động 24h (bd24h) > 5%: ${stats.passedVolAndBd24h} coin`);
    console.log(`- Số coin tải thành công đủ dữ liệu nến 15m: ${stats.candlesValid} coin`);
    console.log('');
    console.log('--- QUẢN LÝ TẬP LƯU 24H (24h.json) ---');
    console.log(`- Số coin có RSI 15m hiện tại > 80 mới phát hiện phiên này: ${stats.newRsi80Detected} coin`);
    console.log(`- Tổng số coin hiện lưu trong 24h.json (còn hạn < 12h): ${stats.totalIn24hList} coin`);
    console.log('');
    console.log('--- KẾT QUẢ XÉT TÍN HIỆU LONG ---');
    console.log(`- Số coin nằm trong 24h.json được đưa vào kiểm tra: ${stats.longIn24hList} coin`);
    console.log(`- Số coin đạt mô hình Nến 1 Tăng VÀ Nến 2 Giảm: ${stats.longCandlePattern} coin`);
    console.log(`- Số coin đạt thêm Low Nến 2 < Lower BB 15m: ${stats.longLowerBB} coin`);
    console.log(`- Số coin đạt điều kiện LONG và đã qua Cooldown (24h): ${stats.longMatched} coin`);
    console.log(`- Số tín hiệu LONG gửi Telegram thành công: ${stats.longSentSuccess} tin`);
    console.log('==================================================================\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
