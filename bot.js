import axios from "axios";
import fs from "fs";

const BOT_TOKEN = process.env.BOT_TOKEN || "BOT_TOKEN";
const CHAT_ID = process.env.CHAT_ID || "CHAT_ID";

const TELEGRAM_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

const CACHE_FILE = "./sent_cache.json";

// ========================================
// Cache
// ========================================

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

// ========================================
// Telegram
// ========================================

async function sendTelegram(text) {
    try {
        await axios.post(
            TELEGRAM_URL,
            {
                chat_id: CHAT_ID,
                text,
                parse_mode: "HTML",
                disable_web_page_preview: true
            },
            {
                timeout: 15000
            }
        );

        console.log("Telegram sent");
    } catch (e) {
        console.log("Telegram Error:", e.response?.data || e.message);
    }
}

// ========================================
// Lấy toàn bộ Future USDT
// ========================================

async function getAllUSDTFutures() {

    const url =
        "https://www.okx.com/api/v5/market/tickers?instType=SWAP";

    const res = await axios.get(url, {
        timeout: 15000
    });

    return res.data.data
        .filter(i => i.instId.endsWith("-USDT-SWAP"))
        .map(i => {

            const last = Number(i.last);
            const open24 = Number(i.sodUtc8);

            const volatility24h =
                open24 > 0
                    ? Math.abs((last - open24) / open24 * 100)
                    : 0;

            return {
                instId: i.instId,
                last,
                volatility24h
            };
        });
}

// ========================================
// % tăng 1H
// ========================================

async function get1hChange(instId) {

    const url =
        `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=1H&limit=2`;

    const res = await axios.get(url, {
        timeout: 15000
    });

    const data = res.data.data;

    if (data.length < 2) return null;

    const latest = data[0];
    const previous = data[1];

    const close = Number(latest[4]);
    const prevClose = Number(previous[4]);

    return ((close - prevClose) / prevClose) * 100;
}

// ========================================
// 4 nến 15m tăng liên tiếp
// ========================================

async function check4Bullish15m(instId) {

    const url =
        `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=15m&limit=4`;

    const res = await axios.get(url, {
        timeout: 15000
    });

    const candles = res.data.data;

    if (candles.length < 4) return false;

    candles.reverse();

    for (const candle of candles) {

        const open = Number(candle[1]);
        const close = Number(candle[4]);

        if (close <= open) {
            return false;
        }
    }

    return true;
}

// ========================================
// MAIN
// ========================================

async function runBot() {

    const cache = loadCache();

    const now = Date.now();

    let futures = await getAllUSDTFutures();

    // Chọn 50 coin biến động mạnh nhất 24h
    futures.sort(
        (a, b) => b.volatility24h - a.volatility24h
    );

    futures = futures.slice(0, 50);

    console.log(`Scanning ${futures.length} coins...`);

    for (const coin of futures) {

        try {

            const change1h = await get1hChange(coin.instId);

            if (change1h === null) continue;

            if (change1h <= 5) continue;

            const bullish =
                await check4Bullish15m(coin.instId);

            if (!bullish) continue;

            const lastSent =
                cache[coin.instId] || 0;

            // Không gửi lại trong 2 giờ
            if (
                now - lastSent <
                2 * 60 * 60 * 1000
            ) {
                continue;
            }

            const price =
                coin.last.toFixed(6);

            const message =
`🟢 <b>Coin thỏa điều kiện</b>

💰 ${coin.instId}

🔥 Biến động 24H: <b>${coin.volatility24h.toFixed(2)}%</b>

📈 Tăng 1H: <b>${change1h.toFixed(2)}%</b>

✅ Có ít nhất 4 nến 15 phút tăng liên tiếp

💵 Giá hiện tại: ${price}`;

            await sendTelegram(message);

            cache[coin.instId] = now;

            console.log(`${coin.instId} sent`);

        } catch (e) {

            console.log(
                coin.instId,
                e.response?.data || e.message
            );
        }
    }

    saveCache(cache);

    console.log("Done.");
}

runBot();
