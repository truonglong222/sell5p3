import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;
const OKX_BASE_URL = 'https://www.okx.com';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'sentCoins.json');
const STATE_FILE = path.join(__dirname, 'state.json');

// Giữ nguyên cơ chế chặn spam tín hiệu (Countdown 6 tiếng cho khung 15m)
const COUNTDOWN_15M = 6 * 60 * 60 * 1000; 

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
            if (timeData._15m && now - timeData._15m < COUNTDOWN_15M) temp._15m = timeData._15m;
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

// Hàm tính chỉ số kĩ thuật RSI tiêu chuẩn (mặc định đã đổi sang chu kỳ 20)
function calculateRSI(prices, period = 20) {
    if (prices.length <= period) return 50; 

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff > 0) gains += diff;
        else losses -= diff;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

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

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
}

// Hàm tính toán Bollinger Bands (Chu kỳ 20, Độ lệch chuẩn 2)
function calculateBollingerBands(prices, period = 20, multiplier = 2) {
    if (prices.length < period) return null;

    const slice = prices.slice(-period);
    const sma = slice.reduce((sum, val) => sum + val, 0) / period;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    return {
        middle: sma,
        upper: sma + (multiplier * stdDev),
        lower: sma - (multiplier * stdDev)
    };
}

// Lấy nến 15m và tính RSI-20
async function getRSI15m(symbol) {
    try {
        // Lấy 60 nến để đảm bảo tính toán RSI-20 mượt mà và chuẩn xác nhất
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=60`;
        const response = await axios.get(url, { timeout: 6000 });
        if (response.data && response.data.code === '0' && response.data.data.length >= 30) {
            const candles15m = response.data.data.reverse(); 
            const prices15m = candles15m.map(c => parseFloat(c[4]));
            const rsi = calculateRSI(prices15m, 20); // Đã đổi thành RSI-20

            return { symbol, rsi, currentPrice: prices15m[prices15m.length - 1] };
        }
    } catch (error) {}
    return null;
}

// Lấy nến 4h để tính Bollinger Bands khi có yêu cầu (Lazy Load)
async function getBB4h(symbol) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=4h&limit=50`;
        const response = await axios.get(url, { timeout: 6000 });
        if (response.data && response.data.code === '0' && response.data.data.length >= 20) {
            const candles4h = response.data.data.reverse();
            const prices4h = candles4h.map(c => parseFloat(c[4]));
            
            return calculateBollingerBands(prices4h, 20, 2);
        }
    } catch (error) {}
    return null;
}

async function main() {
    try {
        console.log('--- BẤT ĐẦU QUÉT RSI-20 KHUNG 15M ---');
        
        if (!fs.existsSync(STATE_FILE)) {
            console.log('Không tìm thấy file trạng thái state.json!');
            return;
        }
        const stateData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        const top20Losers = stateData.top20Losers || [];

        if (top20Losers.length === 0) return;

        const sentLog = loadSentLog();
        const currentTime = Date.now();

        // Bước 1: Chỉ lấy RSI-20 của 20 đồng coin trước (Tiết kiệm tối đa request ban đầu)
        const rsiPromises = top20Losers.map(symbol => getRSI15m(symbol));
        const rsiResults = await Promise.all(rsiPromises);

        let hasNewAlert = false;

        for (let i = 0; i < top20Losers.length; i++) {
            const symbol = top20Losers[i];
            const metrics = rsiResults.find(r => r && r.symbol === symbol);
            if (!metrics) continue;

            if (!sentLog[symbol]) sentLog[symbol] = { _15m: 0 };
            const coinLog = sentLog[symbol];

            // ĐIỀU KIỆN 1: RSI-20 Khung 15m > 70
            if (metrics.rsi > 70) {
                
                // Kiểm tra chặn spam trước khi gọi API nặng hơn để tối ưu
                if (currentTime - (coinLog._15m || 0) < COUNTDOWN_15M) {
                    continue; 
                }

                console.log(`[Lazy Load] ${symbol} đạt RSI-20: ${metrics.rsi.toFixed(2)}. Tiến hành lấy dữ liệu BB 4h...`);
                
                // Bước 2: Chỉ lấy BB 4h cho đồng coin thỏa mãn điều kiện RSI
                const bb4h = await getBB4h(symbol);
                if (!bb4h) continue;

                const currentPrice = metrics.currentPrice;
                const upperBand4h = bb4h.upper;

                // Tính toán tỷ lệ khoảng cách: (Giá - BB Trên) / Giá
                const ratio = (currentPrice - upperBand4h) / currentPrice;

                // ĐIỀU KIỆN 2: -0.5% < ratio < 1%
                if (ratio > -0.005 && ratio < 0.01) {
                    
                    const coinName = symbol.replace('-USDT-SWAP', '');
                    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
                    const labelRanking = `TOP GIẢM 4 NGÀY`;
                    const percentDiff = (ratio * 100).toFixed(2);

                    // Gửi tin nhắn Telegram
                    const message = `🔴 <b>SHORT TÍN HIỆU RSI 20 & BB 4H</b>\n` +
                                    `🔥 Coin: <b>#${coinName}</b> (${labelRanking})\n` +
                                    `📊 Chỉ số RSI-20 (15m): <code>${metrics.rsi.toFixed(2)}</code> (>70)\n` +
                                    `📈 Giá hiện tại: <code>${currentPrice}</code>\n` +
                                    `💥 BB Upper 4h: <code>${upperBand4h.toFixed(4)}</code>\n` +
                                    `🎯 Độ lệch giá với BB: <code>${percentDiff}%</code> (Yêu cầu: -0.5% đến 1.0%)\n` +
                                    `👉 <a href="${link}">Giao dịch ngay</a>`;

                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID,
                        text: message,
                        parse_mode: 'HTML'
                    }).catch(() => {});

                    sentLog[symbol]._15m = currentTime;
                    hasNewAlert = true;
                }
            }
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- KẾT THÚC TIẾN TRÌNH QUÉT ---');
    } catch (err) {
        console.error('Lỗi chạy chính bot.js:', err.message);
    }
}

main();
