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
const STATE_TOP3_FILE = path.join(__dirname, 'statetop3_4h.json');
const STATE_TOP5D_FILE = path.join(__dirname, 'statetop_5d.json');

// Cấu hình Cooldown: TẤT CẢ LỆNH ĐỀU LÀ 4 TIẾNG
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
            if (timeData._long15m && now - timeData._long15m < COOLDOWN_TIME) temp._long15m = timeData._long15m;
            if (timeData._long5m && now - timeData._long5m < COOLDOWN_TIME) temp._long5m = timeData._long5m;
            if (timeData._short15m && now - timeData._short15m < COOLDOWN_TIME) temp._short15m = timeData._short15m;
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

// ------------------- 1. LOGIC KIỂM TRA LONG 15M -------------------
async function checkLong15MConditions(symbol) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=60`;
        const response = await axios.get(url, { timeout: 5000 });

        if (response.data && response.data.code === '0' && response.data.data.length >= 45) {
            const rawCandles = response.data.data; // Index 0: Nến đang chạy, Index 1: Nến [1] vừa đóng
            const lastClosedCandle = rawCandles[1];
            const openPrice = parseFloat(lastClosedCandle[1]);
            const lowPrice = parseFloat(lastClosedCandle[3]);
            const closePrice = parseFloat(lastClosedCandle[4]);

            // Mảng đóng nến lịch sử (đảo ngược để nến cũ đứng trước)
            const closedCandles = rawCandles.slice(1).reverse();
            const closePrices = closedCandles.map(c => parseFloat(c[4]));

            // EMA20 của nến vừa đóng [1]
            const ema20_1 = calculateEMA(closePrices, 20);
            if (ema20_1 === null) return null;

            // EMA20 của nến cách đó 20 nến [20]
            const closePrices20 = closePrices.slice(0, closePrices.length - 20);
            const ema20_20 = calculateEMA(closePrices20, 20);
            if (ema20_20 === null) return null;

            // Tính Diff EMA20 (%)
            const diffEMA = ((ema20_1 - ema20_20) / ema20_20) * 100;

            const lowDiffPct = ((lowPrice - ema20_1) / ema20_1) * 100;
            const candleBodyPct = ((closePrice - openPrice) / openPrice) * 100;

            const isLowNearEMA = lowDiffPct > -0.5 && lowDiffPct < 0.5;
            const isBullishCandle = candleBodyPct > 0;
            const isDiffEMAValid = diffEMA > 3.0;

            if (isLowNearEMA && isBullishCandle && isDiffEMAValid) {
                return {
                    closePrice,
                    ema20: ema20_1,
                    lowDiffPct,
                    candleBodyPct,
                    diffEMA
                };
            }
        }
    } catch (error) {
        console.error(`Lỗi LONG 15M (${symbol}):`, error.message);
    }
    return null;
}

// ------------------- 2. LOGIC KIỂM TRA LONG 5M -------------------
async function checkLong5MConditions(symbol) {
    try {
        // STEP 1: LẤY DỮ LIỆU 15M (1 LẦN GỌI API)
        const url15M = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=60`;
        const res15M = await axios.get(url15M, { timeout: 5000 });
        if (!res15M.data || res15M.data.code !== '0' || res15M.data.data.length < 45) return null;

        const raw15M = res15M.data.data;

        // A. Kiểm tra 8 nến 15M vừa qua tăng > 2.5% (từ open nến thứ 8 [8] đến close nến thứ 1 [1])
        const open8_15M = parseFloat(raw15M[8][1]);
        const close1_15M = parseFloat(raw15M[1][4]);
        const change8Candles15M = ((close1_15M - open8_15M) / open8_15M) * 100;

        if (change8Candles15M <= 2.5) return null; // Không đạt → bỏ ngay

        // B. Tính Diff EMA20 15M > -0.5%
        const closed15M = raw15M.slice(1).reverse();
        const closePrices15M = closed15M.map(c => parseFloat(c[4]));

        const ema20_15M_1 = calculateEMA(closePrices15M, 20);
        const closePrices15M_20 = closePrices15M.slice(0, closePrices15M.length - 20);
        const ema20_15M_20 = calculateEMA(closePrices15M_20, 20);

        if (!ema20_15M_1 || !ema20_15M_20) return null;

        const diffEMA15M = ((ema20_15M_1 - ema20_15M_20) / ema20_15M_20) * 100;

        if (diffEMA15M <= -0.5) return null; // Không đạt → bỏ ngay

        // STEP 2: LẤY DỮ LIỆU 5M (1 LẦN GỌI API)
        const url5M = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=5m&limit=60`;
        const res5M = await axios.get(url5M, { timeout: 5000 });
        if (!res5M.data || res5M.data.code !== '0' || res5M.data.data.length < 30) return null;

        const raw5M = res5M.data.data;
        const candle1_5M = raw5M[1]; // Nến 5M[1]
        const candle2_5M = raw5M[2]; // Nến 5M[2]

        const open1_5M = parseFloat(candle1_5M[1]);
        const close1_5M = parseFloat(candle1_5M[4]);
        const low2_5M = parseFloat(candle2_5M[3]);

        // A. Nến 5M[1] là nến tăng
        if (close1_5M <= open1_5M) return null;

        // B. Đáy nến 5M[2] sát EMA20 (-0.5% đến 0.3%)
        const closed5M = raw5M.slice(2).reverse();
        const closePrices5M = closed5M.map(c => parseFloat(c[4]));
        const ema20_5M = calculateEMA(closePrices5M, 20);
        if (!ema20_5M) return null;

        const diffPrice5M = ((low2_5M - ema20_5M) / ema20_5M) * 100;
        if (diffPrice5M <= -0.5 || diffPrice5M >= 0.3) return null;

        return {
            change8Candles15M,
            diffEMA15M,
            diffPrice5M,
            candle1BodyPct: ((close1_5M - open1_5M) / open1_5M) * 100
        };
    } catch (error) {
        console.error(`Lỗi LONG 5M (${symbol}):`, error.message);
    }
    return null;
}

// ------------------- 3. LOGIC KIỂM TRA SHORT 15M (BOLLINGER BAND) -------------------
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
        console.log('--- BẤT ĐẦU QUÉT TÍN HIỆU BOLLINGER BAND & EMA ---');

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        // ==================== 1. QUÉT LONG 15M ====================
        if (fs.existsSync(STATE_TOP3_FILE)) {
            const stateData = JSON.parse(fs.readFileSync(STATE_TOP3_FILE, 'utf8'));
            const top3Gainers = stateData.top3Gainers4h || stateData.top3Gainers8h || [];

            console.log(`📋 Quét LONG 15M (${top3Gainers.length} coins)...`);

            for (const item of top3Gainers) {
                const symbol = typeof item === 'object' ? item.symbol : item;
                const changeStr = typeof item === 'object' && item.change ? `${item.change}` : 'N/A';
                const rank5d = typeof item === 'object' && item.rank5d ? item.rank5d : 'N/A';

                if (!sentLog[symbol]) sentLog[symbol] = {};
                const lastSent = sentLog[symbol]._long15m || 0;
                if (currentTime - lastSent < COOLDOWN_TIME) continue;

                const signal = await checkLong15MConditions(symbol);
                if (signal) {
                    const coinName = symbol.replace('-USDT-SWAP', '');
                    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                    const message = `🟢 <b>LONG #${coinName} (15M)</b>\n` +
                                    `🏆 Vị trí: <b>Top ${rank5d} Biến động 5D</b>\n` +
                                    `📊 Biến động 3 nến 2H: <code>${changeStr}</code>\n` +
                                    `📉 Đáy râu lệch EMA20: <code>${signal.lowDiffPct.toFixed(2)}%</code>\n` +
                                    `📈 Nến 15M đóng tăng: <code>+${signal.candleBodyPct.toFixed(2)}%</code>\n` +
                                    `⚡ Diff EMA20 (15M vs [20]): <code>+${signal.diffEMA.toFixed(2)}%</code> (> 3%)\n` +
                                    `👉 <a href="${link}">Đồ thị OKX</a>`;

                    console.log(`🚀 [LONG 15M] Gửi Telegram ${symbol}...`);
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID,
                        text: message,
                        parse_mode: 'HTML'
                    }).catch(err => console.error(err.message));

                    sentLog[symbol]._long15m = currentTime;
                    hasNewAlert = true;
                }
                await sleep(100);
            }
        }

        // ==================== 2. QUÉT LONG 5M & SHORT 15M (TỪ FILE statetop_5d.json) ====================
        if (fs.existsSync(STATE_TOP5D_FILE)) {
            const stateTop5dData = JSON.parse(fs.readFileSync(STATE_TOP5D_FILE, 'utf8'));
            
            // A. TOP 20 COIN TĂNG GIÁ 3D (CHO SHORT 15M) - ĐÃ ĐỔI THÀNH top20Gainers3D
            const topGainers3D = (stateTop5dData.top20Gainers3D || stateTop5dData.topGainers3d || []).slice(0, 20);
            console.log(`📋 Quét SHORT 15M (Top 20 Tăng 3D: ${topGainers3D.length} coins)...`);

            for (let i = 0; i < topGainers3D.length; i++) {
                const item = topGainers3D[i];
                const symbol = typeof item === 'object' ? item.symbol : item;

                if (!sentLog[symbol]) sentLog[symbol] = {};
                const lastSent = sentLog[symbol]._short15m || 0;
                if (currentTime - lastSent < COOLDOWN_TIME) continue;

                const shortSignal = await checkShort15MConditions(symbol);
                if (shortSignal) {
                    const coinName = symbol.replace('-USDT-SWAP', '');
                    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                    const message = `🔴 <b>SHORT #${coinName} (BB + EMA 15M)</b>\n` +
                                    `🏆 Xếp hạng: Top ${i + 1} Tăng 3D\n` +
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

            // B. TOP 20 COIN GIẢM GIÁ 3D (CHO LONG 5M)
            const topLosers3D = (stateTop5dData.top20Losers3d || stateTop5dData.topLosers3d || stateTop5dData.top20Losers || []).slice(0, 20);
            console.log(`📋 Quét LONG 5M (Top 20 Giảm 3D: ${topLosers3D.length} coins)...`);

            for (let i = 0; i < topLosers3D.length; i++) {
                const item = topLosers3D[i];
                const symbol = typeof item === 'object' ? item.symbol : item;

                if (!sentLog[symbol]) sentLog[symbol] = {};
                const lastSent = sentLog[symbol]._long5m || 0;
                if (currentTime - lastSent < COOLDOWN_TIME) continue;

                const long5mSignal = await checkLong5MConditions(symbol);
                if (long5mSignal) {
                    const coinName = symbol.replace('-USDT-SWAP', '');
                    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                    const message = `🟢 <b>LONG #${coinName} (5M)</b>\n` +
                                    `🏆 Xếp hạng: Top ${i + 1} Giảm 3D\n` +
                                    `🚀 Tăng giá 8 nến 15M: <code>+${long5mSignal.change8Candles15M.toFixed(2)}%</code> (> 2.5%)\n` +
                                    `📉 Đáy râu 5M[2] lệch EMA20: <code>${long5mSignal.diffPrice5M.toFixed(2)}%</code>\n` +
                                    `📈 Nến 5M[1] vừa đóng: <code>+${long5mSignal.candle1BodyPct.toFixed(2)}%</code>\n` +
                                    `⚡ Diff EMA20 (15M): <code>${long5mSignal.diffEMA15M.toFixed(2)}%</code> (> -0.5%)\n` +
                                    `👉 <a href="${link}">Đồ thị OKX</a>`;

                    console.log(`🚀 [LONG 5M] Gửi Telegram ${symbol}...`);
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID,
                        text: message,
                        parse_mode: 'HTML'
                    }).catch(err => console.error(err.message));

                    sentLog[symbol]._long5m = currentTime;
                    hasNewAlert = true;
                }
                await sleep(100);
            }
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- HOÀN THÀNH BÁO CÁO SCANNER ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

main();
