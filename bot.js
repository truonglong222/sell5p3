import axios from "axios";
import fs from "fs";

const BOT_TOKEN = process.env.BOT_TOKEN || "BOT_TOKEN";
const CHAT_ID = process.env.CHAT_ID || "CHAT_ID";

const TELEGRAM_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
const CACHE_FILE = "./sent_cache.json";

const OKX_TICKERS = "https://www.okx.com/api/v5/market/tickers?instType=SWAP";
const OKX_CANDLES = "https://www.okx.com/api/v5/market/history-candles";

// Đổi thời gian cache thành 30 phút (30 phút * 60 giây * 1000 mili-giây)
const CACHE_EXPIRE = 30 * 60 * 1000; 

// ======================
// Cache
// ======================
function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error("Lỗi khi ghi file cache:", e.message);
  }
}

// ======================
// Telegram
// ======================
async function sendTelegram(text) {
  try {
    await axios.post(TELEGRAM_URL, {
      chat_id: CHAT_ID,
      text,
    });
    console.log("Telegram sent");
  } catch (e) {
    console.error("Telegram error:", e.response?.data || e.message);
  }
}

// ======================
// Get top 10 strongest 24h movers
// ======================
async function getTop10Coins() {
  const res = await axios.get(OKX_TICKERS);

  return res.data.data
    .filter(
      (x) =>
        x.instId.endsWith("-USDT-SWAP") &&
        Number(x.volCcy24h || 0) > 0 &&
        Number(x.open24h || 0) > 0
    )
    .map((x) => {
      const open = Number(x.open24h);
      const last = Number(x.last);

      return {
        instId: x.instId,
        change24h: ((last - open) / open) * 100,
      };
    })
    .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))
    .slice(0, 10); // Đã sửa: Lấy top 10 con biến động lớn nhất
}

// ======================
// Previous 5m candle
// ======================
async function getPrevious5m(instId) {
  const res = await axios.get(OKX_CANDLES, {
    params: {
      instId,
      bar: "5m",
      limit: 2,
    },
  });

  const candles = res.data.data;

  if (!candles || candles.length < 2) return null;

  const c = candles[1];

  return {
    open: Number(c[1]),  
    close: Number(c[4]), 
  };
}

// ======================
// Main
// ======================
async function main() {
  try {
    const cache = loadCache();
    const now = Date.now();

    // Dọn dẹp cache quá 30 phút
    for (const symbol in cache) {
      if (now - cache[symbol] >= CACHE_EXPIRE) {
        delete cache[symbol];
      }
    }

    const topCoins = await getTop10Coins();

    for (const coin of topCoins) {
      // 1. Điều kiện biến động 24h > 30%
      if (coin.change24h <= 30) continue;

      // 2. Kiểm tra trùng coin trong vòng 30 phút
      if (cache[coin.instId] && (now - cache[coin.instId] < CACHE_EXPIRE)) {
        continue;
      }

      const candle = await getPrevious5m(coin.instId);
      if (!candle) continue;

      // Tính % thay đổi nến 5m chuẩn đóng cửa
      const change5m = ((candle.close - candle.open) / candle.open) * 100;

      // 3. Điều kiện biến động 5 phút > 6%
      if (change5m <= 6) continue;

      // Đổi tiêu đề thành BUY vì coin đang pump mạnh trong 5 phút
      const msg = `BUY\n\nCoin: ${coin.instId}\n5m: +${change5m.toFixed(2)}%\n24h: ${coin.change24h.toFixed(2)}%\n\nhttps://www.okx.com/trade-swap/${coin.instId.toLowerCase()}`;

      // Gửi tín hiệu
      await sendTelegram(msg);

      // Lưu cache tức thời
      cache[coin.instId] = Date.now();
      saveCache(cache); 

      console.log(`${coin.instId} tăng mạnh +${change5m.toFixed(2)}% trong 5m. Đã gửi Telegram.`);
      
      // Nghỉ chống spam Telegram API
      await new Promise(r => setTimeout(r, 500));
    }

    saveCache(cache);

  } catch (e) {
    console.error("Lỗi hệ thống chính:", e.response?.data || e.message);
  }
}

main();
