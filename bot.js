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

// Cấu hình chặn spam tín hiệu (Countdown 6 giờ)
const COUNTDOWN_TIME = 48 * 60 * 60 * 1000; 

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
            if (timeData._15m && now - timeData._15m < COUNTDOWN_TIME) temp._15m = timeData._15m;
            if (timeData._1h && now - timeData._1h < COUNTDOWN_TIME) temp._1h = timeData._1h;
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

// Hàm tính RSI-20 chuẩn mượt Wilder
function calculateRSI(prices, period = 20) {
    if (prices.length <= period) return 50; 

    let gains = 0;
    let losses = 0;

    // Tính bước thay đổi ban đầu
    for (let i = 1; i <= period; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff > 0) gains += diff;
        else losses -= diff;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Làm mượt Wilder's Smoothing
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

// Hàm lấy nến và tính RSI-20 theo khung thời gian yêu cầu
async function getRSIForCoin(symbol, barFrame) {
    try {
        // Lấy 60 nến để đảm bảo dữ liệu tính RSI-20 đủ mượt và chính xác
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=${barFrame}&limit=60`;
        const response = await axios.get(url, { timeout: 6000 });
        if (response.data && response.data.code === '0' && response.data.data.length >= 30) {
            const candles = response.data.data.reverse(); // Chuyển từ cũ đến mới
            const prices = candles.map(c => parseFloat(c[4])); // Lấy giá đóng cửa (Close)
            const rsi = calculateRSI(prices, 20); // Tính RSI-20
            return rsi;
        }
    } catch (error) {}
    return null;
}

async function main() {
    try {
        console.log('--- BẤT ĐẦU CHẠY BOT QUÉT TÍN HIỆU RSI-20 ĐA KHUNG ---');

        // 1. Đọc dữ liệu từ state.json
        if (!fs.existsSync(STATE_FILE)) {
            console.log('Không tìm thấy file state.json!');
            return;
        }
        const stateData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        const top20Losers = stateData.top20Losers5Days || [];
        const top10Gainers = stateData.top10Gainers2Days || [];

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        // 2. XỬ LÝ NHÓM 1: Top 20 Giảm 5 ngày -> Quét RSI-20 khung 15m (Tìm điểm LONG)
        console.log(`Đang quét ${top20Losers.length} coin thuộc nhóm Top Giảm 5 Ngày (Khung 15m)...`);
        for (let i = 0; i < top20Losers.length; i++) {
            const symbol = top20Losers[i];
            const rsi = await getRSIForCoin(symbol, '15m');
            
            if (rsi !== null && rsi > 70) {
                if (!sentLog[symbol]) sentLog[symbol] = {};
                const coinLog = sentLog[symbol];

                // Kiểm tra countdown chặn lặp tín hiệu (6h) cho khung 15m
                if (currentTime - (coinLog._15m || 0) >= COUNTDOWN_TIME) {
                    const coinName = symbol.replace('-USDT-SWAP', '');
                    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
                    const rankingLabel = `TOP ${i + 1} GIẢM 5 NGÀY`;

                    const message = `🟢 <b>TÍN HIỆU LONG (15M)</b>\n` +
                                    `🔥 Coin: <b>#${coinName}</b> (${rankingLabel})\n` +
                                    `📊 Chỉ số RSI-20 (15m): <code>${rsi.toFixed(2)}</code> (&gt; 70)\n` +
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
            await sleep(50); // Khoảng nghỉ nhỏ tránh nghẽn
        }

        // 3. XỬ LÝ NHÓM 2: Top 10 Tăng 2 ngày -> Quét RSI-20 khung 1h (Tìm điểm SHORT)
        console.log(`Đang quét ${top10Gainers.length} coin thuộc nhóm Top Tăng 2 Ngày (Khung 1h)...`);
        for (let i = 0; i < top10Gainers.length; i++) {
            const symbol = top10Gainers[i];
            const rsi = await getRSIForCoin(symbol, '1H');

            if (rsi !== null && rsi < 50) {
                if (!sentLog[symbol]) sentLog[symbol] = {};
                const coinLog = sentLog[symbol];

                // Kiểm tra countdown chặn lặp tín hiệu (6h) cho khung 1h
                if (currentTime - (coinLog._1h || 0) >= COUNTDOWN_TIME) {
                    const coinName = symbol.replace('-USDT-SWAP', '');
                    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
                    const rankingLabel = `TOP ${i + 1} TĂNG 2 NGÀY`;

                    const message = `🔴 <b>TÍN HIỆU SHORT (1H)</b>\n` +
                                    `🔥 Coin: <b>#${coinName}</b> (${rankingLabel})\n` +
                                    `📊 Chỉ số RSI-20 (1h): <code>${rsi.toFixed(2)}</code> (&lt; 50)\n` +
                                    `👉 <a href="${link}">Giao dịch ngay</a>`;

                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID,
                        text: message,
                        parse_mode: 'HTML'
                    }).catch(() => {});

                    sentLog[symbol]._1h = currentTime;
                    hasNewAlert = true;
                }
            }
            await sleep(50); // Khoảng nghỉ nhỏ tránh nghẽn
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- HOÀN THÀNH TIẾN TRÌNH QUÉT BOT ---');
    } catch (err) {
        console.error('Lỗi chạy chính bot.js:', err.message);
    }
}

main();
