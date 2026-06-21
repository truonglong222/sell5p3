const fs = require("fs");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const COOLDOWN_HOURS = 8;

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML"
    })
  });
}

async function getJSON(url) {
  const res = await fetch(url);
  return await res.json();
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync("cache.json", "utf8"));
  } catch {
    return {};
  }
}

function saveCache(data) {
  fs.writeFileSync("cache.json", JSON.stringify(data, null, 2));
}

async function main() {

  const tickerData = await getJSON(
    "https://www.okx.com/api/v5/market/tickers?instType=SPOT"
  );

  const usdtPairs = tickerData.data.filter(
    x => x.instId.endsWith("-USDT")
  );

  const top10 = usdtPairs
    .map(x => ({
      symbol: x.instId,
      change24h:
        ((parseFloat(x.last) - parseFloat(x.open24h))
          / parseFloat(x.open24h)) * 100
    }))
    .sort((a, b) => b.change24h - a.change24h)
    .slice(0, 10);

  const cache = loadCache();
  const now = Date.now();

  let alerts = [];

  for (const coin of top10) {

    try {

      const candles15m = await getJSON(
        `https://www.okx.com/api/v5/market/candles?instId=${coin.symbol}&bar=15m&limit=2`
      );

      const candles2h = await getJSON(
        `https://www.okx.com/api/v5/market/candles?instId=${coin.symbol}&bar=2H&limit=2`
      );

      if (
        !candles15m.data?.length ||
        !candles2h.data?.length
      ) continue;

      const c15 = candles15m.data[0];
      const open15 = parseFloat(c15[1]);
      const close15 = parseFloat(c15[4]);

      const change15 =
        ((close15 - open15) / open15) * 100;

      const c2h = candles2h.data[0];
      const open2h = parseFloat(c2h[1]);
      const close2h = parseFloat(c2h[4]);

      const change2h =
        ((close2h - open2h) / open2h) * 100;

      if (change15 <= 2) continue;

      if (change2h <= -5 || change2h >= 5) continue;

      const lastSent = cache[coin.symbol] || 0;

      if (
        now - lastSent <
        COOLDOWN_HOURS * 60 * 60 * 1000
      ) {
        continue;
      }

      alerts.push(
`🚀 <b>${coin.symbol}</b>

📈 24H: ${coin.change24h.toFixed(2)}%
⚡ 15M: ${change15.toFixed(2)}%
🕐 2H: ${change2h.toFixed(2)}%

🔥 Top 10 tăng mạnh nhất 24H`
      );

      cache[coin.symbol] = now;

    } catch (e) {
      console.log("Error:", coin.symbol);
    }
  }

  if (alerts.length > 0) {

    await sendTelegram(
      alerts.join("\n\n====================\n\n")
    );

    saveCache(cache);
  }
}

main();
