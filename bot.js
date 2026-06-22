const fs = require("fs");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CACHE_FILE = "sent_cache.json";
const COOLDOWN_HOURS = 8;

async function sendTelegram(text) {
  await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "HTML",
      }),
    }
  );
}

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

async function getTop24h() {
  const res = await fetch(
    "https://www.okx.com/api/v5/market/tickers?instType=SPOT"
  );

  const json = await res.json();

  return json.data
    .filter(
      (x) =>
        x.instId.endsWith("-USDT") &&
        Number(x.last) > 0
    )
    .map((x) => ({
      symbol: x.instId,
      change24h: Number(x.sodUtc0)
        ? ((Number(x.last) - Number(x.sodUtc0)) /
            Number(x.sodUtc0)) *
          100
        : 0,
    }))
    .sort((a, b) => b.change24h - a.change24h)
    .slice(0, 10);
}

async function getCandles(symbol, bar) {
  const url =
    `https://www.okx.com/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=20`;

  const res = await fetch(url);
  const json = await res.json();

  return json.data;
}

function calcChange(data, periodsBack) {
  if (data.length <= periodsBack) return null;

  const latest = Number(data[0][4]);
  const old = Number(data[periodsBack][4]);

  return ((latest - old) / old) * 100;
}

async function main() {
  const cache = loadCache();
  const now = Date.now();

  const topCoins = await getTop24h();

  let messages = [];

  for (const coin of topCoins) {
    try {
      const symbol = coin.symbol;

      if (
        cache[symbol] &&
        now - cache[symbol] <
          COOLDOWN_HOURS * 3600 * 1000
      ) {
        continue;
      }

      const candles15m =
        await getCandles(symbol, "15m");

      const candles1H =
        await getCandles(symbol, "1H");

      const change15m = calcChange(
        candles15m,
        1
      );

      const change2h = calcChange(
        candles1H,
        2
      );

      if (
        change15m > 2 &&
        change2h > -5 &&
        change2h < 5
      ) {
        messages.push(
          `🚀 <b>${symbol}</b>\n` +
            `24H: ${coin.change24h.toFixed(
              2
            )}%\n` +
            `15M: ${change15m.toFixed(2)}%\n` +
            `2H: ${change2h.toFixed(2)}%`
        );

        cache[symbol] = now;
      }
    } catch (e) {
      console.log(e.message);
    }
  }

  if (messages.length > 0) {
    await sendTelegram(
      messages.join("\n\n──────────\n\n")
    );
    saveCache(cache);
  } else {
    console.log("No signal");
  }
}

main();
