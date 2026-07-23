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

const COOLDOWN_TIME = 1 * 60 * 60 * 1000; // Cooldown 1 tiếng
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
            if (timeData._long && now - timeData._long < COOLDOWN_TIME) temp._long = timeData._long;
            if (timeData._short && now - timeData._short < COOLDOWN_TIME) temp._short = timeData._short;
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

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

function calculateRSI(prices, period = 20) {
    if (prices.length <= period) return null;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        const change = prices[i] - prices[i - 1];
        if (change >= 0) gains += change;
        else losses -= change;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        if (change >= 0) {
            avgGain = (avgGain * (period - 1) + change) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) - change) / period;
        }
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// ------------------- LOGIC KIỂM TRA LONG -------------------
async function checkCandleConditions(symbol) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=60`;
        const response = await axios.get(url, { timeout: 5000 });

        if (response.data && response.data.code === '0' && response.data.data.length >= 25) { 
            const rawCandles = response.data.data;
            
            // rawCandles[0]: Nến đang chạy
            // rawCandles[1]: Nến 15M vừa đóng gần nhất
            const lastClosedCandle = rawCandles[1];
            const openPrice = parseFloat(lastClosedCandle[1]);
            const lowPrice = parseFloat(lastClosedCandle[3]);
            const closePrice = parseFloat(lastClosedCandle[4]);

            // Lấy toàn bộ các nến ĐÃ ĐÓNG CỬA (từ rawCandles[1] trở đi về quá khứ)
            const closedCandles = rawCandles.slice(1).reverse(); // Đảo lại thành: Cũ -> Mới (mới nhất là rawCandles[1])
            const closePrices = closedCandles.map(c => parseFloat(c[4])); 
            
            // Tính EMA20 dựa trên chuỗi nến đã đóng
            const ema20 = calculateEMA(closePrices, 20); 

            if (ema20 === null) return null;

            const lowDiffPct = ((lowPrice - ema20) / ema20) * 100;
            const candleBodyPct = ((closePrice - openPrice) / openPrice) * 100;

            return {
                closePrice,
                ema20,
                lowDiffPct,
                candleBodyPct,
                isLowNearEMA: lowDiffPct > -0.5 && lowDiffPct < 0.5,
                isBullishCandle: candleBodyPct > 0.5
            };
        } 
    } catch (error) {
        console.error(`Lỗi lấy nến 15M LONG OKX (${symbol}):`, error.message);
    } 
    return null; 
}

// ------------------- LOGIC KIỂM TRA SHORT -------------------
async function checkShortConditions(symbol) {
    try {
        // 1. Lấy nến 15m tính RSI20
        const url15m = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=100`;
        const res15m = await axios.get(url15m, { timeout: 5000 });

        if (!res15m.data || res15m.data.code !== '0' || res15m.data.data.length < 30) return null;

        const raw15m = res15m.data.data;
        const currentPrice = parseFloat(raw15m[0][4]); // Giá nến đang chạy (Real-time)

        // Chỉ lấy các nến 15M đã đóng để tính RSI
        const closed15m = raw15m.slice(1).reverse(); // Từ CŨ -> MỚI (mới nhất là nến vừa đóng)
        const closePrices15m = closed15m.map(c => parseFloat(c[4]));

        const rsi20_15m = calculateRSI(closePrices15m, 20);
        if (rsi20_15m === null || rsi20_15m <= 70) {
            return null; // Bỏ qua nếu RSI20 khung 15m <= 70
        }

        // 2. Tải nến ngày (1D) để tính EMA20 Nến Ngày
        const url1D = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1D&limit=60`;
        const res1D = await axios.get(url1D, { timeout: 5000 });

        if (!res1D.data || res1D.data.code !== '0' || res1D.data.data.length < 25) return null;

        // Chỉ lấy các nến D1 đã đóng cửa
        const closed1D = res1D.data.data.slice(1).reverse();
        const closePrices1D = closed1D.map(c => parseFloat(c[4]));
        const ema20_1D = calculateEMA(closePrices1D, 20);

        if (ema20_1D === null) return null;

        // Tính % độ lệch: (Giá hiện tại - EMA20 Ngày) / EMA20 Ngày * 100
        const diffPct = ((currentPrice - ema20_1D) / ema20_1D) * 100;

        // ĐIỀU KIỆN SHORT: -1% < diffPct < 5%
        if (diffPct > -1 && diffPct < 5) {
            return {
                rsi20: rsi20_15m,
                diffPct: diffPct,
                currentPrice,
                ema20_1D
            };
        }
    } catch (error) {
        console.error(`Lỗi lấy dữ liệu SHORT OKX (${symbol}):`, error.message);
    }
    return null;
}

// ------------------- HÀM CHÍNH -------------------
async function main() {
    try {
        console.log('--- BẤT ĐẦU QUÉT TÍN HIỆU LONG & SHORT ---');

        const sentLog = loadSentLog(); 
        const currentTime = Date.now(); 
        let hasNewAlert = false; 

        // ==================== 1. QUÉT TÍN HIỆU LONG ====================
        if (fs.existsSync(STATE_TOP3_FILE)) {
            const stateData = JSON.parse(fs.readFileSync(STATE_TOP3_FILE, 'utf8')); 
            const top3Gainers = stateData.top3Gainers4h || stateData.top3Gainers8h || []; 

            console.log(`📋 Số lượng coin LONG khả dụng: ${top3Gainers.length}`);

            for (let i = 0; i < top3Gainers.length; i++) { 
                const item = top3Gainers[i]; 
                const symbol = typeof item === 'object' ? item.symbol : item; 
                const changeStr = typeof item === 'object' && item.change ? `${item.change}` : 'N/A'; 
                const rank5d = typeof item === 'object' && item.rank5d ? item.rank5d : 'N/A'; 

                if (!sentLog[symbol]) sentLog[symbol] = {}; 
                
                const lastSentLong = sentLog[symbol]._long || 0;
                if (currentTime - lastSentLong < COOLDOWN_TIME) {
                    const remainingMin = Math.round((COOLDOWN_TIME - (currentTime - lastSentLong)) / 60000);
                    console.log(`⏳ [LONG] ${symbol} đang trong cooldown (còn ${remainingMin} phút).`);
                    continue;
                }

                const signal = await checkCandleConditions(symbol); 
                if (signal && signal.isLowNearEMA && signal.isBullishCandle) { 
                    const coinName = symbol.replace('-USDT-SWAP', ''); 
                    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`; 
                    
                    const message = `🟢 <b>LONG #${coinName} (15M)</b>\n` + 
                                    `🏆 Vị trí: <b>Top ${rank5d} Biến động 5D</b>\n` + 
                                    `📊 Biến động 3 nến 2H: <code>${changeStr}</code>\n` + 
                                    `📉 Đáy râu nến lệch EMA20: <code>${signal.lowDiffPct.toFixed(2)}%</code>\n` + 
                                    `🔥 Nến 15M vừa đóng tăng: <code>+${signal.candleBodyPct.toFixed(2)}%</code>\n` + 
                                    `👉 <a href="${link}">Đồ thị OKX</a>`; 
                    
                    console.log(`🚀 [LONG MATCH] Gửi Telegram cho ${symbol}...`);

                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { 
                        chat_id: TELEGRAM_CHAT_ID, 
                        text: message, 
                        parse_mode: 'HTML' 
                    }).catch((err) => console.error(`❌ Lỗi gửi Telegram (${symbol}):`, err.message)); 
                    
                    sentLog[symbol]._long = currentTime; 
                    hasNewAlert = true; 
                } 
                await sleep(100); 
            }
        } else {
            console.log('❌ Không tìm thấy file statetop3_4h.json (Bỏ qua quét LONG)');
        }

        // ==================== 2. QUÉT TÍN HIỆU SHORT ====================
        if (fs.existsSync(STATE_TOP5D_FILE)) {
            const stateTop5dData = JSON.parse(fs.readFileSync(STATE_TOP5D_FILE, 'utf8'));
            let top20Losers = Array.isArray(stateTop5dData) ? stateTop5dData : (stateTop5dData.top20Losers || stateTop5dData.topLosers5d || []);
            top20Losers = top20Losers.slice(0, 20);

            console.log(`📋 Số lượng coin SHORT khả dụng (Top 20 Giảm 5D): ${top20Losers.length}`);

            for (let i = 0; i < top20Losers.length; i++) {
                const item = top20Losers[i];
                const symbol = typeof item === 'object' ? item.symbol : item;
                const rank5d = (typeof item === 'object' && item.rank5d) ? item.rank5d : (i + 1);

                if (!sentLog[symbol]) sentLog[symbol] = {};

                const lastSentShort = sentLog[symbol]._short || 0;
                if (currentTime - lastSentShort < COOLDOWN_TIME) {
                    const remainingMin = Math.round((COOLDOWN_TIME - (currentTime - lastSentShort)) / 60000);
                    console.log(`⏳ [SHORT] ${symbol} đang trong cooldown (còn ${remainingMin} phút).`);
                    continue;
                }

                const shortSignal = await checkShortConditions(symbol);
                if (shortSignal) {
                    const coinName = symbol.replace('-USDT-SWAP', '');
                    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                    const message = `🔴 <b>SHORT #${coinName} (15M / 1D)</b>\n` +
                                    `🏆 Vị trí: <b>Top ${rank5d} Giảm Giá 5D</b>\n` +
                                    `⚡ RSI20 (15M): <code>${shortSignal.rsi20.toFixed(2)}</code>\n` +
                                    `📉 Độ lệch so với EMA20 (1D): <code>${shortSignal.diffPct.toFixed(2)}%</code>\n` +
                                    `👉 <a href="${link}">Đồ thị OKX</a>`;

                    console.log(`🚀 [SHORT MATCH] Gửi Telegram cho ${symbol}...`);

                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID,
                        text: message,
                        parse_mode: 'HTML'
                    }).catch((err) => console.error(`❌ Lỗi gửi Telegram Short (${symbol}):`, err.message));

                    sentLog[symbol]._short = currentTime;
                    hasNewAlert = true;
                }
                await sleep(100);
            }
        } else {
            console.log('⚠️ Không tìm thấy file statetop_5d.json (Bỏ qua quét SHORT)');
        }

        if (hasNewAlert) saveSentLog(sentLog); 
        console.log('--- HOÀN THÀNH TIẾN TRÌNH QUÉT EMA LONG & SHORT ---'); 
    } catch (err) { 
        console.error('Lỗi hệ thống trong ema.js:', err.message); 
    } 
}

main();
