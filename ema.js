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
const STATE_TOP5D_FILE = path.join(__dirname, 'statetop_5d.json');

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
            if (timeData._short15m && now - timeData._short15m < COOLDOWN_TIME) {
                temp._short15m = timeData._short15m;
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

// ------------------- LOGIC KIỂM TRA SHORT 15M (BOLLINGER BAND) -------------------
async function checkShort15MConditions(symbol) {
    try {
        const url15M = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=100`;
        const res15M = await axios.get(url15M, { timeout: 5000 });

        if (!res15M.data || res15M.data.code !== '0' || res15M.data.data.length < 85) return null;

        const raw15M = res15M.data.data; // Index 0: nến đang chạy, 1: nến [1], 2: nến [2], 3: nến [3]
        const candle1 = raw15M[1];
        const candle3 = raw15M[3];

        const open1 = parseFloat(candle1[1]);
        const close1 = parseFloat(candle1[4]);
        
        // Index [2] là giá HIGH (giá cao nhất)
        const high3 = parseFloat(candle3[2]);

        // Điều kiện 1: Nến 15m vừa đóng [1] là nến giảm
        if (close1 >= open1) return null;

        // Tính Bollinger Band cho nến [3] (Lấy 20 nến trước nến 3)
        const closedForBB = raw15M.slice(3, 23).reverse().map(c => parseFloat(c[4]));
        const bb = calculateBollingerBands(closedForBB, 20);
        if (!bb) return null;

        // Điều kiện 2: Râu nến [3] (high) chạm BB trên (-0.5% < diffBB < 1%)
        const diffBB = ((high3 - bb.upper) / bb.upper) * 100;
        if (diffBB <= -0.5 || diffBB >= 1.0) return null;

        // ---------------- ĐIỀU KIỆN XÉT 60 NẾN 15M ----------------
        // A. Tìm nến giảm giá lớn nhất trong 60 nến gần nhất (Index 1 đến 60)
        const last60Candles = raw15M.slice(1, 61);
        let maxDropPct = 0; // Trị tuyệt đối mức giảm giá lớn nhất (%)

        for (const c of last60Candles) {
            const o = parseFloat(c[1]);
            const cl = parseFloat(c[4]);
            if (cl < o) { // Chỉ xét nến giảm
                const dropPct = ((o - cl) / o) * 100; // Trị tuyệt đối của % giảm
                if (dropPct > maxDropPct) {
                    maxDropPct = dropPct;
                }
            }
        }

        // B. Tính biến động trung bình của 20 nến gần nhất (Index 1 đến 20)
        const last20Candles = raw15M.slice(1, 21);
        let totalAbsChange20 = 0;

        for (const c of last20Candles) {
            const o = parseFloat(c[1]);
            const cl = parseFloat(c[4]);
            const absChange = (Math.abs(cl - o) / o) * 100; // Trị tuyệt đối biến động
            totalAbsChange20 += absChange;
        }

        const avgChange20 = totalAbsChange20 / 20;
        if (avgChange20 === 0) return null;

        // C. Tính x = Trị tuyệt đối nến giảm max 60 nến / TB biến động 20 nến
        const x = maxDropPct / avgChange20;
        
        // Điều kiện: x > 4
        if (x <= 4) return null;

        // Điều kiện 4: Diff EMA 15M (< 3%)
        const closedAll15M = raw15M.slice(1).reverse().map(c => parseFloat(c[4]));
        const ema20_1 = calculateEMA(closedAll15M, 20);

        const closed15M_20 = closedAll15M.slice(0, closedAll15M.length - 20);
        const ema20_20 = calculateEMA(closed15M_20, 20);

        if (!ema20_1 || !ema20_20) return null;

        const diffEMA = ((ema20_1 - ema20_20) / ema20_20) * 100;
        if (diffEMA >= 3.0) return null; // Điều kiện: diffEMA < 3%

        return {
            diffBB,
            xRatio: x,
            diffEMA,
            candle1BodyPct: ((close1 - open1) / open1) * 100
        };
    } catch (error) {
        console.error(`Lỗi SHORT 15M (${symbol}):`, error.message);
    }
    return null;
}

// ------------------- HÀM CHÍNH -------------------
async function main() {
    try {
        console.log('--- BẤT ĐẦU QUÉT TÍN HIỆU SHORT (BOLLINGER BAND & EMA) ---');

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        if (fs.existsSync(STATE_TOP5D_FILE)) {
            const stateTop5dData = JSON.parse(fs.readFileSync(STATE_TOP5D_FILE, 'utf8'));
            
            // Đọc danh sách Top 30 Coin Tăng Giá 5D từ file statetop_5d.json
            const topGainers5D = stateTop5dData.top30Gainers5D || [];
            console.log(`📋 Quét SHORT 15M (${topGainers5D.length} coins từ Top Tăng 5D)...`);

            for (let i = 0; i < topGainers5D.length; i++) {
                const item = topGainers5D[i];
                const symbol = typeof item === 'object' ? item.symbol : item;
                const gain5dStr = typeof item === 'object' && item.change5DaysGain ? `${item.change5DaysGain}%` : 'N/A';

                if (!sentLog[symbol]) sentLog[symbol] = {};
                const lastSent = sentLog[symbol]._short15m || 0;
                if (currentTime - lastSent < COOLDOWN_TIME) continue;

                const shortSignal = await checkShort15MConditions(symbol);
                if (shortSignal) {
                    const coinName = symbol.replace('-USDT-SWAP', '');
                    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                    const message = `🔴 <b>SHORT #${coinName} (BB + EMA 15M)</b>\n` +
                                    `🏆 Xếp hạng: <b>Top ${i + 1} Tăng 5D (+${gain5dStr})</b>\n` +
                                    `🎯 Râu High[3] lệch BB Upper: <code>${shortSignal.diffBB.toFixed(2)}%</code>\n` +
                                    `🔻 Nến 15M vừa đóng: <code>${shortSignal.candle1BodyPct.toFixed(2)}%</code>\n` +
                                    `📉 Tỉ số Xả/TB20 (x): <code>${shortSignal.xRatio.toFixed(2)}</code> (> 4)\n` +
                                    `⚡ Diff EMA20 (15M): <code>${shortSignal.diffEMA.toFixed(2)}%</code> (< 3%)\n` +
                                    `👉 <a href="${link}">Đồ thị OKX</a>`;

                    console.log(`🚀 [SHORT 15M] Gửi Telegram ${symbol}...`);
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID,
                        text: message,
                        parse_mode: 'HTML'
                    }).catch(err => console.error(err.message));

                    sentLog[symbol]._short15m = currentTime;
                    hasNewAlert = true;
                }
                await sleep(100);
            }
        } else {
            console.error(`Không tìm thấy file trạng thái: ${STATE_TOP5D_FILE}`);
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- HOÀN THÀNH BÁO CÁO SCANNER ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

main();
