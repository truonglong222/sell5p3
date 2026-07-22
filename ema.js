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

const COOLDOWN_TIME = 1 * 60 * 60 * 1000; // Khóa chống trùng gửi tin 1 tiếng
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

async function checkCandleConditions(symbol) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=60`;
        const response = await axios.get(url, { timeout: 5000 });

        if (response.data && response.data.code === '0' && response.data.data.length >= 25) { 
            const rawCandles = response.data.data; // OKX trả về từ MỚI NHẤT -> CŨ NHẤT

            // Nến vừa mới đóng cửa chính là phần tử index [1] (index [0] là nến đang chạy)
            // Cấu trúc OKX Candle: [ts, open, high, low, close, ...]
            const lastClosedCandle = rawCandles[1];
            const openPrice = parseFloat(lastClosedCandle[1]);
            const lowPrice = parseFloat(lastClosedCandle[3]);
            const closePrice = parseFloat(lastClosedCandle[4]);

            // Chuẩn bị mảng giá đóng cửa từ CŨ -> MỚI để tính EMA20 chính xác
            const candles = rawCandles.slice().reverse(); 
            const closePrices = candles.map(c => parseFloat(c[4])); 
            
            // Tính EMA20 tính đến điểm nến vừa đóng (bỏ nến đang chạy ra)
            const closePricesUntilLastClosed = closePrices.slice(0, closePrices.length - 1);
            const ema20 = calculateEMA(closePricesUntilLastClosed, 20); 

            if (ema20 === null) return null;

            // 1. % Độ lệch giữa râu nến dưới (Low) và đường EMA20
            const lowDiffPct = ((lowPrice - ema20) / ema20) * 100;

            // 2. % Tăng giá của nến vừa đóng (Close so với Open)
            const candleBodyPct = ((closePrice - openPrice) / openPrice) * 100;

            return {
                closePrice,
                ema20,
                lowDiffPct,
                candleBodyPct,
                // CẬP NHẬT: Điều kiện 1: -0.5% < (Low - EMA20) / EMA20 < 0.5%
                isLowNearEMA: lowDiffPct > -0.5 && lowDiffPct < 0.5,
                // Điều kiện 2: Nến 15m vừa đóng tăng > 0.5%
                isBullishCandle: candleBodyPct > 0.5
            };
        } 
    } catch (error) {
        console.error(`Lỗi lấy nến OKX (${symbol}):`, error.message);
    } 
    return null; 
}

async function main() {
    try {
        console.log('--- BẤT ĐẦU QUÉT TÍN HIỆU EMA CHÂN SÓNG 15M ---');

        if (!fs.existsSync(STATE_TOP3_FILE)) { 
            console.log('❌ Không tìm thấy file statetop3_4h.json!'); 
            return; 
        } 

        const stateData = JSON.parse(fs.readFileSync(STATE_TOP3_FILE, 'utf8')); 
        const top3Gainers = stateData.top3Gainers4h || stateData.top3Gainers8h || []; 

        console.log(`📋 Số lượng coin khả dụng trong file statetop3_4h.json: ${top3Gainers.length}`);
        if (top3Gainers.length === 0) {
            console.log('⚠️ Không có coin nào trong danh sách cần quét.');
            return;
        }

        const sentLog = loadSentLog(); 
        const currentTime = Date.now(); 
        let hasNewAlert = false; 

        // XỬ LÝ NHÓM LONG
        for (let i = 0; i < top3Gainers.length; i++) { 
            const item = top3Gainers[i]; 
            const symbol = typeof item === 'object' ? item.symbol : item; 
            const changeStr = typeof item === 'object' && item.change ? `${item.change}` : 'N/A'; 
            const rank5d = typeof item === 'object' && item.rank5d ? item.rank5d : 'N/A'; 

            if (!sentLog[symbol]) sentLog[symbol] = { _long: 0 }; 
            
            // Kiểm tra cooldown
            const lastSent = sentLog[symbol]._long || 0;
            if (currentTime - lastSent < COOLDOWN_TIME) {
                const remainingMin = Math.round((COOLDOWN_TIME - (currentTime - lastSent)) / 60000);
                console.log(`⏳ ${symbol} đang trong cooldown (còn ${remainingMin} phút). Bỏ qua.`);
                continue;
            }

            const signal = await checkCandleConditions(symbol); 
            if (signal) { 
                console.log(`🔍 [${symbol}] Râu dưới lệch EMA20: ${signal.lowDiffPct.toFixed(2)}% | % Tăng nến 15M: ${signal.candleBodyPct.toFixed(2)}%`);
                
                // KIỂM TRA ĐỦ CẢ 2 ĐIỀU KIỆN
                if (signal.isLowNearEMA && signal.isBullishCandle) { 
                    const coinName = symbol.replace('-USDT-SWAP', ''); 
                    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`; 
                    
                    const message = `🟢 <b>LONG #${coinName} (15M)</b>\n` + 
                                    `🏆 Vị trí: <b>Top ${rank5d} Biến động 5D</b>\n` + 
                                    `📊 Biến động 3 nến 2H: <code>${changeStr}</code>\n` + 
                                    `📉 Đáy râu nến lệch EMA20: <code>${signal.lowDiffPct.toFixed(2)}%</code>\n` + 
                                    `🔥 Nến 15M vừa đóng tăng: <code>+${signal.candleBodyPct.toFixed(2)}%</code>\n` + 
                                    `👉 <a href="${link}">Đồ thị OKX</a>`; 
                    
                    console.log(`🚀 BÁO ĐỘNG MATCH: Gửi tin nhắn Telegram cho ${symbol}...`);

                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { 
                        chat_id: TELEGRAM_CHAT_ID, 
                        text: message, 
                        parse_mode: 'HTML' 
                    }).catch((err) => {
                        console.error(`❌ Lỗi gửi Telegram (${symbol}):`, err.message);
                    }); 
                    
                    sentLog[symbol]._long = currentTime; 
                    hasNewAlert = true; 
                } 
            } 
            await sleep(100); 
        } 

        if (hasNewAlert) saveSentLog(sentLog); 
        console.log('--- HOÀN THÀNH TIẾN TRÌNH QUÉT EMA 15M ---'); 
    } catch (err) { 
        console.error('Lỗi hệ thống trong ema.js:', err.message); 
    } 
}

main();
