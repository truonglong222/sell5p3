import fs from "fs";
import axios from "axios";
import {
  getAllUSDTFutures,
  getEMA20,
  getChange24h
} from "./okx.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const COOLDOWN_FILE = "./cooldown.json";
const COOLDOWN_HOURS = 2;

// ----------------- LOAD COOLDOWN -----------------
function loadCooldown() {
  if (!fs.existsSync(COOLDOWN_FILE)) return {};
  return JSON.parse(fs.readFileSync(COOLDOWN_FILE));
}

function saveCooldown(data) {
  fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(data, null, 2));
}

// ----------------- TELEGRAM -----------------
async function sendTelegram(msg) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  await axios.post(url, {
    chat_id: CHAT_ID,
    text: msg,
    parse_mode: "Markdown"
  });
}
// ----------------- MAIN LOGIC -----------------
async function runBot() {
  let coins = await getAllUSDTFutures();

  // Tính % giảm 24h
  coins = coins.map(c => ({
    ...c,
    change24h: getChange24h(c)
  }));

  // Sort giảm mạnh nhất
  coins.sort((a, b) => a.change24h - b.change24h);

  const top10 = coins.slice(0, 10);

  const cooldown = loadCooldown();
  const now = Date.now();

  let results = [];

  for (const coin of top10) {
    try {
      const ema20 = await getEMA20(coin.instId);

      const diff =
        ((coin.last - ema20) / coin.last) * 100;

      const isValid = diff > -1;

      const lastSent = cooldown[coin.instId] || 0;
      const isCooldown = now - lastSent < COOLDOWN_HOURS * 3600 * 1000;

      if (isValid && !isCooldown) {
        results.push({
          ...coin,
          diff
        });

        cooldown[coin.instId] = now;
      }
    } catch (e) {
      // bỏ coin lỗi
      continue;
    }
  }

  saveCooldown(cooldown);

if (results.length === 0) {
  await sendTelegram("❌ Không có coin thỏa điều kiện.");
  return;
}

  let msg = `📉 *TOP COIN GIẢM MẠNH + EMA FILTER*\n\n`;

  results.forEach(c => {
    msg += `🔻 ${c.instId}\n`;
    msg += `24h: ${c.change24h.toFixed(2)}%\n`;
    msg += `EMA diff: ${c.diff.toFixed(2)}%\n\n`;
  });

  await sendTelegram(msg);
}

// ----------------- RUN (GitHub cron) -----------------
runBot().catch(console.error);
