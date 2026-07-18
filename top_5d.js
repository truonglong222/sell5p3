import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;
const OKX_BASE_URL = 'https://www.okx.com';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'sent_long.json');
const STATE_LONG_FILE = path.join(__dirname, 'statelong.json');

const COOLDOWN_LONG = 24 * 60 * 60 * 1000; // Khóa 24 giờ không gửi trùng
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadLog() {
    if (fs.existsSync(DB_FILE)) {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8') || '{}');
    }
    return {};
}

function calculateRSI(prices, period = 20) {
    if (prices.length <= period) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff > 0) gains += diff; else losses -= diff;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    for (let i = period + 1; i < prices.length; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff > 0) {
            avgGain = (avgGain * (period - 1) + diff) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) - diff) / period;
        }
    }
    return avgLoss === 0 ? 100 : 100 - 100 / (1 + (avgGain / avgLoss));
}

async function getRSI15m(symbol) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=65`;
        const res = await axios.get(url, { timeout: 5000 });
        if (res.data && res.data.code === '0' && res.data.data.length >= 35) {
            const prices = res.data.data.reverse().map(c => parseFloat(c[4]));
            return calculateRSI(prices, 20);
        }
    } catch (e) {}
    return null;
}

async function main() {
    if (!fs.existsSync(STATE_LONG_FILE)) return;
    const { top20Losers } = JSON.parse(fs.readFileSync(STATE_LONG_FILE, 'utf8'));
    const sentLog = loadLog();
    const now = Date.now();
    let hasUpdate = false;

    console.log(`[LONG] Đang quét ${top20Losers.length} coin từ statelong.json...`);
    for (const symbol of top20Losers) {
        const lastSent = sentLog[symbol] || 0;
        if (now - lastSent >= COOLDOWN_LONG) {
            const rsi = await getRSI15m(symbol);
            if (rsi !== null && rsi > 66) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
                const message = `🟢 <b>TÍN HIỆU LONG (15M)</b>\n🔥 Coin: <b>#${coinName}</b>\n📊 RSI-20 (15m): <code>${rsi.toFixed(2)}</code> (&gt; 66)\n👉 <a href="${link}">Giao dịch ngay</a>`;
                
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML'
                }).catch(() => {});

                sentLog[symbol] = now;
                hasUpdate = true;
            }
            await sleep(50);
        }
    }
    if (hasUpdate) fs.writeFileSync(DB_FILE, JSON.stringify(sentLog, null, 2), 'utf8');
}
main();
