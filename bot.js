
import axios from "axios";
import fs from "fs";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const STATE_FILE = "./state.json";
const COOLDOWN = 4 * 60 * 60 * 1000;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(data) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

async function sendTelegram(text) {
  await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text,
    disable_web_page_preview: true
  });
}

// Futures USDT tickers
async function getTickers() {
  const res = await axios.get("https://www.okx.com/api/v5/market/tickers?instType=SWAP");
  return res.data.data.filter(x => x.instId.includes("USDT-SWAP"));
}

// candle change
async function getChange(instId, bar) {
  try {
    const res = await axios.get(
      `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=2`
    );

    const data = res.data.data;
    if (!data || data.length < 2) return null;

    const latest = Number(data[0][4]);
    const prev = Number(data[1][4]);

    return ((latest - prev) / prev) * 100;
  } catch {
    return null;
  }
}

async function run() {
  const state = loadState();
  const now = Date.now();

  const tickers = await getTickers();

  // sort 24h losers
  const ranked = tickers
    .map(t => {
      const last = Number(t.last);
      const open = Number(t.open24h);
      const change = ((last - open) / open) * 100;

      return { symbol: t.instId, change24h: change };
    })
    .sort((a, b) => a.change24h - b.change24h)
    .slice(0, 20);

  const results = [];

  for (const c of ranked) {
    const chg15m = await getChange(c.symbol, "15m");
    if (chg15m === null || chg15m <= 2) continue;

    const chg2h = await getChange(c.symbol, "2H");
    if (chg2h === null || chg2h <= 5) continue;

    const lastSent = state[c.symbol] || 0;
    if (now - lastSent < COOLDOWN) continue;

    results.push({ ...c, chg15m, chg2h });
  }

  if (results.length === 0) return;

  for (const r of results) {
    const link = `https://www.okx.com/trade-swap/${r.symbol.toLowerCase()}`;

    const msg =
`🚨 OKX FUTURES SIGNAL

${r.symbol}
24H: ${r.change24h.toFixed(2)}%
15M: +${r.chg15m.toFixed(2)}%
2H: +${r.chg2h.toFixed(2)}%

Link:
${link}`;

    await sendTelegram(msg);
    state[r.symbol] = now;
  }

  saveState(state);
}

run().catch(console.error);
