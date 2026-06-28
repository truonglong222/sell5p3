import axios from "axios";
import fs from "fs";

const BOT_TOKEN = process.env.BOT_TOKEN || "BOT_TOKEN";
const CHAT_ID = process.env.CHAT_ID || "CHAT_ID";

const TELEGRAM_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
const CACHE_FILE = "./sent_cache.json";

// =======================
// Load cache
// =======================
function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return {};

  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// =======================
// Telegram
// =======================
async function sendTelegram(text) {
  try {
    await axios.post(TELEGRAM_URL, {
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    });

    console.log("Telegram sent");
  } catch (e) {
    console.log("Telegram Error:", e.response?.data || e.message);
  }
}

// =======================
// Lấy toàn bộ Future USDT
// =======================
async function getAllUSDTFutures() {
  const url =
    "https://www.okx.com/api/v5/market/tickers?instType=SWAP";

  const res = await axios.get(url);

  return res.data.data.filter(i => i.instId.endsWith("-USDT-SWAP"));
}

// =======================
// % tăng 1h
// =======================
async function get1hChange(instId) {
  const url =
    `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=1H&limit=2`;

  const res = await axios.get(url);

  const data = res.data.data;

  if (data.length < 2) return null;

  // dữ liệu trả về mới nhất trước
  const latest = data[0];
  const prev = data[1];

  const close = parseFloat(latest[4]);
  const prevClose = parseFloat(prev[4]);

  return ((close - prevClose) / prevClose) * 100;
}

// =======================
// 3 nến 15p liên tiếp tăng
// =======================
async function check3Bullish15m(instId) {
  const url =
    `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=15m&limit=3`;

  const res = await axios.get(url);

  const candles = res.data.data;

  if (candles.length < 3) return false;

  // API trả nến mới nhất trước -> đảo lại
  candles.reverse();

  for (const c of candles) {
    const open = parseFloat(c[1]);
    const close = parseFloat(c[4]);

    if (close <= open) return false;
  }

  return true;
}

// =======================
// MAIN
// =======================
async function runBot() {

  const cache = loadCache();
  const now = Date.now();

  const futures = await getAllUSDTFutures();

  for (const coin of futures) {

    try {

      const change1h = await get1hChange(coin.instId);

      if (change1h === null) continue;

      if (change1h <= 3) continue;

      const bullish = await check3Bullish15m(coin.instId);

      if (!bullish) continue;

      const lastSent = cache[coin.instId] || 0;

      // Không gửi lại trong 2 giờ
      if (now - lastSent < 2 * 60 * 60 * 1000)
        continue;

      const price = Number(coin.last).toFixed(6);

      const msg =
`🟢 <b>Coin thỏa điều kiện</b>

💰 ${coin.instId}

📈 Tăng 1H: <b>${change1h.toFixed(2)}%</b>

✅ Có ít nhất 3 nến 15 phút tăng liên tiếp

💵 Giá hiện tại: ${price}`;

      await sendTelegram(msg);

      cache[coin.instId] = now;

    } catch (e) {
      console.log(coin.instId, e.message);
    }
  }

  saveCache(cache);
}

runBot();
