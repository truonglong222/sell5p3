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

// Đường dẫn trỏ tới file statetop_15d.json
const STATE_TOP15D_FILE = path.join(__dirname, 'statetop_15d.json');

// Cấu hình Cooldown: 4 tiếng
const COOLDOWN_TIME = 4 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        for (const [coin, timeData] of Object.entries(logData)) {
            const temp = {};
            if (timeData._short1h && now - timeData._short1h < COOLDOWN_TIME) {
                temp._short1h = timeData._short1h;
            }
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

// ------------------- HÀM TÍNH EMA & BOLLINGER BANDS -------------------
function calculateEMA(prices, period = 20) {
    if (prices.length < period) return null;
    const k = 2 / (period + 1);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += prices[i];
    let ema = sum / period;
    for (let i = period; i < prices.length; i++) {
        ema = (prices[i] * k) + (ema * (1 - k));
    }
    return ema;
}

function calculateBollingerBands(prices, period = 20, stdDevMultiplier = 2) {
    if (prices.length < period) return null;
    const slice = prices.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    return {
        middle: mean,
        upper: mean + stdDevMultiplier * stdDev,
        lower: mean - stdDevMultiplier * stdDev
    };
}

// ------------------- LOGIC KIỂM TRA SHORT 1H -------------------
async function checkShort1HConditions(symbol) {
    try {
        // Lấy 60 nến khung 1H
        const url1H = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=60`;
        const res1H = await axios.get(url1H, { timeout: 5000 });

        if (!res1H.data || res1H.data.code !== '0' || res1H.data.data.length < 51) return null;

        const raw1H = res1H.data.data; // Index 0: nến đang chạy, 1: nến [1], 2: nến [2]
        const candle1 = raw1H[1];
        const candle2 = raw1H[2];

        const open1 = parseFloat(candle1[1]);
        const close1 = parseFloat(candle1[4]);
        const high2 = parseFloat(candle2[2]);

        // ĐIỀU KIỆN 1: Nến [1] vừa đóng phải là nến giảm giá (đỏ)
        if (close1 >= open1) return null;

        // ĐIỀU KIỆN 2: Tính BB cho nến [2] (20 nến tính từ index 2 đến 21)
        const closedForBB2 = raw1H.slice(2, 22).reverse().map(c => parseFloat(c[4]));
        const bb2 = calculateBollingerBands(closedForBB2, 20);
        if (!bb2) return null;

        // Râu trên (High) nến [2] sát BB Upper: -0.5% < diffBB < 1.0%
        const diffBB = ((high2 - bb2.upper) / bb2.upper) * 100;
        if (diffBB <= -0.5 || diffBB >= 1.0) return null;

        // ---------------- ĐIỀU KIỆN XÉT 50 NẾN 1H ----------------
        // A. Tìm nến giảm giá lớn nhất trong 50 nến 1H gần nhất (Index 1 đến 50)
        const last50Candles = raw1H.slice(1, 51);
        let maxDropPct = 0;

        for (const c of last50Candles) {
            const o = parseFloat(c[1]);
            const h = parseFloat(c[2]);
            const l = parseFloat(c[3]);
            const cl = parseFloat(c[4]);

            if (cl < o) { // Chỉ xét nến giảm
                const dropPct = ((h - l) / h) * 100;
                if (dropPct > maxDropPct) {
                    maxDropPct = dropPct;
                }
            }
        }

        // B. Tính biến động trung bình 20 nến 1H gần nhất (Index 1 đến 20)
        const last20Candles = raw1H.slice(1, 21);
        let totalAbsChange20 = 0;

        for (const c of last20Candles) {
            const o = parseFloat(c[1]);
            const cl = parseFloat(c[4]);
            totalAbsChange20 += (Math.abs(cl - o) / o) * 100;
        }

        const avgChange20 = totalAbsChange20 / 20;
        if (avgChange20 === 0) return null;

        // C. ĐIỀU KIỆN 3: Tỉ số x > 5
        const x = maxDropPct / avgChange20;
        if (x <= 5) return null;

        // ĐIỀU KIỆN 4: Diff EMA20 (1H) < 2%
        const closedAll1H = raw1H.slice(1).reverse().map(c => parseFloat(c[4]));
        const ema20_1 = calculateEMA(closedAll1H, 20);

        const closed1H_20 = closedAll1H.slice(0, closedAll1H.length - 20);
        const ema20_20 = calculateEMA(closed1H_20, 20);

        if (!ema20_1 || !ema20_20) return null;

        const diffEMA = ((ema20_1 - ema20_20) / ema20_20) * 100;
        if (diffEMA >= 2.0) return null;

        return {
            diffBB,
            xRatio: x,
            diffEMA
        };
    } catch (error) {
        console.error(`Lỗi SHORT 1H (${symbol}):`, error.message);
    }
    return null;
}

// ------------------- HÀM CHÍNH -------------------
async function main() {
    try {
        console.log('--- BẤT ĐẦU QUÉT TÍN HIỆU SHORT 1H (BB + EMA) ---');

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        if (fs.existsSync(STATE_TOP15D_FILE)) {
            const stateTop15dData = JSON.parse(fs.readFileSync(STATE_TOP15D_FILE, 'utf8'));
            const topGainers15D = stateTop15dData.top30Gainers15D || stateTop15dData.top20Gainers15D || [];
            console.log(`📋 Quét SHORT 1H (${topGainers15D.length} coins từ Top Tăng 15D)...`);

            for (let i = 0; i < topGainers15D.length; i++) {
                const item = topGainers15D[i];
                const symbol = typeof item === 'object' ? item.symbol : item;
                const gain = typeof item === 'object' ? item.change15DaysGain : 0;

                if (!sentLog[symbol]) sentLog[symbol] = {};
                const lastSent = sentLog[symbol]._short1h || 0;
                if (currentTime - lastSent < COOLDOWN_TIME) continue;

                const shortSignal = await checkShort1HConditions(symbol);
                if (shortSignal) {
                    const coinName = symbol.replace('-USDT-SWAP', '');
                    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                    // Nội dung tin nhắn rút gọn hiển thị % tăng giá
                    const message = `🔴 <b>SHORT #${coinName} 1H</b>\n` +
                                    `Gain 3D: <b>+${gain}%</b> | x: <b>${shortSignal.xRatio.toFixed(2)}</b>\n` +
                                    `BB: <code>${shortSignal.diffBB.toFixed(2)}%</code> | EMA: <code>${shortSignal.diffEMA.toFixed(2)}%</code>\n` +
                                    `👉 <a href="${link}">OKX</a>`;

                    console.log(`🚀 [SHORT 1H] Gửi Telegram ${symbol}...`);
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID,
                        text: message,
                        parse_mode: 'HTML'
                    }).catch(err => console.error(err.message));

                    sentLog[symbol]._short1h = currentTime;
                    hasNewAlert = true;
                }
                await sleep(100);
            }
        } else {
            console.error(`Không tìm thấy file trạng thái: ${STATE_TOP15D_FILE}`);
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- HOÀN THÀNH BÁO CÁO SCANNER ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

main();
