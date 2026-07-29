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

// Cấu hình Cooldown: 4 tiếng
const COOLDOWN_TIME = 4 * 60 * 60 * 1000;
const MIN_VOLUME_USDT = 5000000; // 5 Triệu USDT

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

// ------------------- LẤY DANH SÁCH COIN VOLUME > 5M USDT -------------------
async function getHighVolumeCoins() {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const res = await axios.get(url, { timeout: 10000 });
        if (!res.data || res.data.code !== '0') return [];

        const tickers = res.data.data;
        const validCoins = tickers.filter(item => {
            if (!item.instId.endsWith('-USDT-SWAP')) return false;
            const volCcy = parseFloat(item.volCcy24h || 0); // Khối lượng tính theo USDT (24h)
            return volCcy >= MIN_VOLUME_USDT;
        }).map(item => item.instId);

        return validCoins;
    } catch (error) {
        console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
        return [];
    }
}

// ------------------- LOGIC KIỂM TRA SHORT 1H NEW -------------------
async function checkShort1HConditions(symbol) {
    try {
        // Lấy 60 nến 1H từ OKX API (Index 0: nến đang chạy, Index 1: nến vừa đóng [1], Index 2: nến [2]...)
        const url1H = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=60`;
        const res1H = await axios.get(url1H, { timeout: 5000 });

        if (!res1H.data || res1H.data.code !== '0' || res1H.data.data.length < 60) return null;

        const raw1H = res1H.data.data;

        // --- ĐIỀU KIỆN 1: Nến vừa đóng (nến số 1) phải là NẾN ĐỎ ---
        const candle1 = raw1H[1];
        const open1 = parseFloat(candle1[1]);
        const close1 = parseFloat(candle1[4]);
        if (close1 >= open1) return null; // Loại nếu không phải nến đỏ

        // --- ĐIỀU KIỆN 2: Tăng giá từ nến thấp nhất trong 60 nến đến nến số 1 > 15% ---
        let lowestPrice = Infinity;
        for (let i = 1; i < 60; i++) {
            const low = parseFloat(raw1H[i][3]);
            if (low < lowestPrice) lowestPrice = low;
        }

        const priceGainFromLowest = ((close1 - lowestPrice) / lowestPrice) * 100;
        if (priceGainFromLowest <= 15.0) return null;

        // --- ĐIỀU KIỆN 3: Tỉ số x > 3 (Tính trên 60 nến) ---
        let maxDropPct = 0;
        let maxDropIndex = -1;

        for (let i = 1; i < raw1H.length; i++) {
            const c = raw1H[i];
            const o = parseFloat(c[1]);
            const h = parseFloat(c[2]);
            const l = parseFloat(c[3]);
            const cl = parseFloat(c[4]);

            if (cl < o) { // Nến giảm
                const dropPct = ((h - l) / h) * 100;
                if (dropPct > maxDropPct) {
                    maxDropPct = dropPct;
                    maxDropIndex = i;
                }
            }
        }

        if (maxDropIndex === -1 || maxDropPct === 0) return null;

        const startIndex = maxDropIndex + 1;
        const endIndex = maxDropIndex + 21;
        if (raw1H.length < endIndex) return null;

        const candlesBeforeMaxDrop = raw1H.slice(startIndex, endIndex);
        let totalAbsChange20 = 0;

        for (const c of candlesBeforeMaxDrop) {
            const o = parseFloat(c[1]);
            const cl = parseFloat(c[4]);
            totalAbsChange20 += (Math.abs(cl - o) / o) * 100;
        }

        const avgChange20 = totalAbsChange20 / 20;
        if (avgChange20 === 0) return null;

        const x = maxDropPct / avgChange20;
        if (x <= 3.0) return null; // Điều kiện x > 3

        // --- ĐIỀU KIỆN 4: Nến số 2 gần Bollinger Bands (Upper hoặc Middle) ---
        const candle2 = raw1H[2];
        const high2 = parseFloat(candle2[2]);

        // Tính BB20 tại thời điểm nến số 2 (Lấy 20 nến tính từ index 2 trở về trước)
        const closedForBB2 = raw1H.slice(2, 22).reverse().map(c => parseFloat(c[4]));
        const bb2 = calculateBollingerBands(closedForBB2, 20);
        if (!bb2) return null;

        // Độ lệch % của High2 so với BB Upper và BB Middle
        const diffBBUpper = ((high2 - bb2.upper) / bb2.upper) * 100;
        const diffBBMiddle = ((high2 - bb2.middle) / bb2.middle) * 100;

        // Kiểm tra xem High2 có nằm gần dải Trên HOẶC dải Giữa hay không (-0.5% < diff < 1.0%)
        const isNearUpper = diffBBUpper > -0.5 && diffBBUpper < 1.0;
        const isNearMiddle = diffBBMiddle > -0.5 && diffBBMiddle < 1.0;

        if (!isNearUpper && !isNearMiddle) return null;

        const diffBBUsed = isNearUpper ? diffBBUpper : diffBBMiddle;
        const bbTargetName = isNearUpper ? 'BB Upper' : 'BB Mid';

        // --- ĐIỀU KIỆN 5: Diff EMA20 giữa nến số 1 và nến cách 20 phiên < 4% ---
        const closedAll1H = raw1H.slice(1).reverse().map(c => parseFloat(c[4]));
        const ema20_1 = calculateEMA(closedAll1H, 20);

        const closed1H_20 = closedAll1H.slice(0, closedAll1H.length - 20);
        const ema20_20 = calculateEMA(closed1H_20, 20);

        if (!ema20_1 || !ema20_20) return null;

        const diffEMA = ((ema20_1 - ema20_20) / ema20_20) * 100;
        if (diffEMA >= 4.0) return null;

        return {
            priceGainFromLowest,
            xRatio: x,
            diffBB: diffBBUsed,
            bbTargetName,
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
        console.log('--- BẤT ĐẦU QUÉT TÍN HIỆU SHORT 1H (FILTER CHI TIẾT) ---');

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        // Step 1: Lấy các coin có Volume 24h > 5 triệu USDT
        const highVolCoins = await getHighVolumeCoins();
        console.log(`📋 Tìm thấy ${highVolCoins.length} coins có Vol 24h > 5M USDT...`);

        // Step 2: Lặp qua các coin để lọc tín hiệu
        for (let i = 0; i < highVolCoins.length; i++) {
            const symbol = highVolCoins[i];

            if (!sentLog[symbol]) sentLog[symbol] = {};
            const lastSent = sentLog[symbol]._short1h || 0;
            if (currentTime - lastSent < COOLDOWN_TIME) continue;

            const shortSignal = await checkShort1HConditions(symbol);
            if (shortSignal) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                // Nội dung tin nhắn gửi Telegram
                const message = `🔴 <b>SHORT #${coinName} 1H</b>\n` +
                                `Tăng từ đáy 60n: <b>+${shortSignal.priceGainFromLowest.toFixed(2)}%</b> | x: <b>${shortSignal.xRatio.toFixed(2)}</b>\n` +
                                `${shortSignal.bbTargetName}: <code>${shortSignal.diffBB.toFixed(2)}%</code> | EMA: <code>${shortSignal.diffEMA.toFixed(2)}%</code>\n` +
                                `👉 <a href="${link}">OKX Trade</a>`;

                console.log(`🚀 [SHORT 1H MATCHED] Gửi Telegram ${symbol}...`);
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML'
                }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

                sentLog[symbol]._short1h = currentTime;
                hasNewAlert = true;
            }

            await sleep(100); // Tránh bị giới hạn rate limit API OKX
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- HOÀN THÀNH QUÉT TÍN HIỆU ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

main();
