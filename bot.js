import axios from "axios";
import fs from "fs";

const BOT_TOKEN = process.env.BOT_TOKEN || "BOT_TOKEN";
const CHAT_ID = process.env.CHAT_ID || "CHAT_ID";

const TELEGRAM_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
const CACHE_FILE = "./sent_cache.json";

const OKX_TICKERS =
  "https://www.okx.com/api/v5/market/tickers?instType=SWAP";
const OKX_CANDLES =
  "https://www.okx.com/api/v5/market/history-candles";

// ======================
// Cache
// ======================
function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

const cache = loadCache();

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
// Get top 5 strongest 24h movers
// ======================
async function getTop5Coins() {
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
    .slice(0, 5);
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

  if (candles.length < 2) return null;

  // data[0]=current candle
  // data[1]=previous closed candle
  const c = candles[1];

  return {
    high: Number(c[2]),
    low: Number(c[3]),
  };
}

// ======================
// Main
// ======================
async function main() {
  try {
    const topCoins = await getTop5Coins();

    for (const coin of topCoins) {
      if (coin.change24h <= 30) continue;

      const candle = await getPrevious5m(coin.instId);
      if (!candle) continue;

      // Theo yêu cầu:
      // (low - high) / high *100 < -3%
      const drop5m =
        ((candle.low - candle.high) / candle.high) * 100;

      if (drop5m > -3) continue;

      const now = Date.now();

      if (
        cache[coin.instId] &&
        now - cache[coin.instId] < 2 * 60 * 60 * 1000
      ) {
        continue;
      }

      const msg =
`Coin: ${coin.instId}
5m: ${drop5m.toFixed(2)}%
24h: ${coin.change24h.toFixed(2)}%`;

      await sendTelegram(msg);

      cache[coin.instId] = now;
    }

    saveCache(cache);
  } catch (e) {
    console.error(e.response?.data || e.message);
  }
}

main();
