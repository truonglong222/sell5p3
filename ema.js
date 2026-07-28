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
        // [ĐÃ SỬA] Lấy 70 nến khung 1H từ OKX API
        const url1H = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=70`;
        const res1H = await axios.get(url1H, { timeout: 5000 });

        if (!res1H.data || res1H.data.code !== '0' || res1H.data.data.length < 51) return null;

        const raw1H = res1H.data.data; // Index 0: nến đang chạy, 1: nến [1], 2: nến [2]...

        // --- ĐIỀU KIỆN 2: Tính BB & diffBB cho nến HIỆN TẠI (Index 0) ---
        const candle0 = raw1H[0];
        const high0 = parseFloat(candle0[2]);

        // Tính BB bằng 20 nến gần nhất tính từ nến hiện tại về trước (index 0 đến 19)
        const closedForBB0 = raw1H.slice(0, 20).reverse().map(c => parseFloat(c[4]));
        const bb0 = calculateBollingerBands(closedForBB0, 20);
        if (!bb0) return null;

        // Râu trên (High) nến HIỆN TẠI sát BB Upper: -0.5% < diffBB < 1.0%
        const diffBB = ((high0 - bb0.upper) / bb0.upper) * 100;
        if (diffBB <= -0.5 || diffBB >= 1.0) return null;

        // ---------------- ĐIỀU KIỆN XÉT NẾN GIẢM VÀ 20 NẾN TRƯỚC NÓ ----------------
        // [ĐÃ SỬA] A. Tìm nến giảm giá lớn nhất trong 50 nến 1H gần nhất (Index 1 đến 50)
        let maxDropPct = 0;
        let maxDropIndex = -1; // Lưu lại vị trí (index) của nến giảm lớn nhất

        for (let i = 1; i <= 50 && i < raw1H.length; i++) {
            const c = raw1H[i];
            const o = parseFloat(c[1]);
            const h = parseFloat(c[2]);
            const l = parseFloat(c[3]);
            const cl = parseFloat(c[4]);

            if (cl < o) { // Chỉ xét nến giảm
                const dropPct = ((h - l) / h) * 100;
                if (dropPct > maxDropPct) {
                    maxDropPct = dropPct;
                    maxDropIndex = i;
                }
            }
        }

        // Nếu không tìm thấy nến giảm nào trong 50 nến gần nhất thì bỏ qua
        if (maxDropIndex === -1 || maxDropPct === 0) return null;

        // [ĐÃ SỬA] B. Tính biến động trung bình của 20 nến TÍNH TỪ TRƯỚC cây nến giảm lớn nhất
        // Nến nằm ngay trước nến maxDropIndex sẽ bắt đầu từ index (maxDropIndex + 1) đến (maxDropIndex + 20)
        const startIndex = maxDropIndex + 1;
        const endIndex = maxDropIndex + 21;

        // Kiểm tra xem dữ liệu fetch về có đủ 20 nến trước đó hay không
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

        // C. ĐIỀU KIỆN 3: Tỉ số x > 4
        const x = maxDropPct / avgChange20;
        if (x <= 4) return null;

        // ĐIỀU KIỆN 4: Diff EMA20 (1H) < 3%
        const closedAll1H = raw1H.slice(1).reverse().map(c => parseFloat(c[4]));
        const ema20_1 = calculateEMA(closedAll1H, 20);

        const closed1H_20 = closedAll1H.slice(0, closedAll1H.length - 20);
        const ema20_20 = calculateEMA(closed1H_20, 20);

        if (!ema20_1 || !ema20_20) return null;

        const diffEMA = ((ema20_1 - ema20_20) / ema20_20) * 100;
        if (diffEMA >= 3.0) return null;

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
