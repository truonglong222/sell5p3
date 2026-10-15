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

// Cấu hình Cooldown & Ngưỡng lọc tối ưu
const COOLDOWN_TIME_LONG = 24 * 60 * 60 * 1000;      // 24 giờ cooldown cho mỗi coin
const MIN_VOL_CCY24H = 5_000_000;                   // 1. Lọc Volume 24h > 5 triệu USDT
const MIN_BD3 = 2;                                  // 2. Lọc % tăng trưởng 3 nến gần nhất > +2%
const MAX_DIFF_RSI = 25;                            // 3. Lọc diffRsi < 25%

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------- HÀM TIỆN ÍCH TRÁNH LỖI HTML TELEGRAM -------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '')
    .replace(/>/g, '');
}

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
  } catch (e) {
    console.error('Lỗi khi lưu sent_ema.json:', e.message);
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

// ------------------- LỌC THỊ TRƯỜNG & LẤY NẾN -------------------

async function getFilteredMarkets() {
  let allSwaps = 0;
  let passedVol = 0;
  const targetCoins = [];

  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') {
      return { allSwaps, passedVol, targetCoins };
    }

    const tickers = res.data.data.filter((item) => item.instId.endsWith('-USDT-SWAP'));
    allSwaps = tickers.length;

    // Bước 1: Lọc Volume > 5 triệu USDT
    for (const item of tickers) {
      const vol = parseFloat(item.volCcy24h || 0);
      if (vol > MIN_VOL_CCY24H) {
        passedVol++;
        targetCoins.push({
          instId: item.instId,
          volCcy24h: vol
        });
      }
    }

    return { allSwaps, passedVol, targetCoins };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { allSwaps, passedVol, targetCoins };
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

// ------------------- GỬI TELEGRAM & BẮT LOG LỖI CHI TIẾT -------------------

async function sendTelegramMessage(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('\n❌ [TELEGRAM ERROR] Thiếu cấu hình BOT_TOKEN hoặc CHAT_ID:');
    console.error(`   - BOT_TOKEN: ${TELEGRAM_BOT_TOKEN ? 'Đã có' : 'CHƯA CÓ (undefined)'}`);
    console.error(`   - CHAT_ID: ${TELEGRAM_CHAT_ID ? TELEGRAM_CHAT_ID : 'CHƯA CÓ (undefined)'}\n`);
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }, { timeout: 8000 });
    return true;
  } catch (err) {
    console.error('\n❌ [TELEGRAM SEND ERROR]');
    if (err.response) {
      console.error(`- HTTP Status : ${err.response.status}`);
      console.error(`- Error Code  : ${err.response.data?.error_code}`);
      console.error(`- Description : ${err.response.data?.description}`);
      console.error(`- Raw Data    :`, JSON.stringify(err.response.data, null, 2));
    } else if (err.request) {
      console.error(`- Network Error: Không nhận được phản hồi từ api.telegram.org (${err.code || err.message})`);
    } else {
      console.error(`- General Error: ${err.message}`);
    }
    console.error('- Message Preview:\n', message);
    console.error('--------------------------------------------------\n');
    return false;
  }
}

// ------------------- TIẾN TRÌNH CHÍNH -------------------

async function main() {
  try {
    console.log('=== BẮT ĐẦU QUÉT THỊ TRƯỜNG (5m) ===\n');

    const sentLog = loadSentLog();
    const currentTime = Date.now();

    const { allSwaps, passedVol, targetCoins } = await getFilteredMarkets();

    const stats = {
      allSwaps,
      passedVol,
      passedBd3: 0,
      passedDiffRsi: 0,
      longSavedSuccess: 0,
      longSentSuccess: 0
    };

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      // Lấy nến 5m (cần ít nhất 35 nến để tính chính xác RSI với period = 20)
      const candles5m = await getCandles(symbol, '5m', 50);
      if (!candles5m || candles5m.length < 35) {
        await sleep(60);
        continue;
      }

      const closedCandles = candles5m.slice(1); // Bỏ nến chưa đóng hiện tại
      if (closedCandles.length < 25) {
        await sleep(60);
        continue;
      }

      // Tính bd3: chênh lệch % giữa giá đóng cửa nến vừa đóng (index 0) và giá mở cửa nến số 3 (index 2)
      const close0 = parseFloat(closedCandles[0][4]);
      const open2 = parseFloat(closedCandles[2][1]);

      let bd3 = 0;
      if (open2 > 0) {
        bd3 = ((close0 - open2) / open2) * 100;
      }

      // Bước 2: Lọc bd3 > 2%
      if (bd3 <= MIN_BD3) {
        await sleep(60);
        continue;
      }
      stats.passedBd3++;

      // Tính mảng RSI theo thứ tự thời gian tăng dần
      const chronological5m = [...closedCandles].reverse();
      const closes5m = chronological5m.map((c) => parseFloat(c[4]));
      const rsiSeries5m = calculateRSIArray(closes5m, 20);

      if (rsiSeries5m.length < 5) {
        await sleep(60);
        continue;
      }

      // `closedCandles` đang sắp xếp mới nhất ở index 0, cũ dần về sau.
      // Do đó:
      // - Nến số 1 (vừa đóng) tương ứng với phần tử cuối cùng của `rsiSeries5m` (hoặc lấy từ mảng đóng cửa ngược lại).
      // Để đồng bộ chính xác với mảng `closedCandles`, ta đảo ngược mảng RSI để map trực tiếp:
      const chronologicalRsi = [...rsiSeries5m].reverse(); 
      // chronologicalRsi[0] là nến vừa đóng (nến 1)
      // chronologicalRsi[2] là nến số 3
      const rsiNen1 = chronologicalRsi[0];
      const rsiNen3 = chronologicalRsi[2];

      let diffRsi = 0;
      if (rsiNen3 > 0) {
        diffRsi = ((rsiNen1 - rsiNen3) / rsiNen3) * 100;
      }

      // Bước 3: Lọc diffRsi < 25%
      if (diffRsi >= MAX_DIFF_RSI) {
        await sleep(60);
        continue;
      }
      stats.passedDiffRsi++;

      const coinName = escapeHtml(symbol.replace('-USDT-SWAP', ''));
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
      const bd3Str = `+${bd3.toFixed(2)}`;
      const diffRsiStr = diffRsi >= 0 ? `+${diffRsi.toFixed(2)}` : diffRsi.toFixed(2);
      const rsiNen1Str = rsiNen1.toFixed(2);

      const longKey = `${symbol}_LONG`;
      const lastSentLong = sentLog[longKey] || 0;

      if (currentTime - lastSentLong >= COOLDOWN_TIME_LONG) {
        // 1. Cập nhật và lưu NGAY LẬP TỨC vào sent_ema.json trước khi gửi tin nhắn Telegram
        sentLog[longKey] = currentTime;
        saveSentLog(sentLog);
        stats.longSavedSuccess++;

        const longMsg =
          `<b>🚀 TÍN HIỆU LONG</b>\n` +
          `Coin: <b>${coinName}</b> (5m)\n` +
          `BD3: ${bd3Str}%\n` +
          `RSI (Nến 1): ${rsiNen1Str}\n` +
          `DiffRSI: ${diffRsiStr}%\n` +
          `<a href="${link}">🔗 Giao dịch OKX</a>`;

        console.log(`💾 [LONG] Đã lưu ${symbol} vào sent_ema.json! Đang gửi Telegram (BD3: ${bd3Str}%, DiffRSI: ${diffRsiStr}%)...`);

        // 2. Gửi tin nhắn Telegram sau khi đã lưu
        const isLongSent = await sendTelegramMessage(longMsg);
        if (isLongSent) {
          stats.longSentSuccess++;
        }
      }

      await sleep(100);
    }

    console.log('\n================ BÁO CÁO THỐNG KÊ QUÉT THỊ TRƯỜNG (5m) ================');
    console.log(`- Tổng số cặp SWAP quét được từ OKX: ${stats.allSwaps} coin`);
    console.log(`- Số coin thỏa mãn Volume 24h > 5M USDT: ${stats.passedVol} coin`);
    console.log(`- Số coin thỏa mãn BD3 > +2%: ${stats.passedBd3} coin`);
    console.log(`- Số coin thỏa mãn DiffRSI < 25%: ${stats.passedDiffRsi} coin`);
    console.log(`- Số tín hiệu LONG thỏa mãn & đã lưu file: ${stats.longSavedSuccess} coin`);
    console.log(`- Số tín hiệu LONG gửi Telegram thành công: ${stats.longSentSuccess} tin`);
    console.log('======================================================================\n');
  } catch (err) {
    console.error('Lỗi trong hàm main():', err.message);
  }
}

main();
