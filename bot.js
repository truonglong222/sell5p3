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

// Hàm tính chỉ số kĩ thuật RSI-14 tiêu chuẩn
function calculateRSI(prices, period = 14) {
    if (prices.length <= period) return 50; // Không đủ dữ liệu nến

    let gains = 0;
    let losses = 0;

    // Tính bước thay đổi ban đầu cho cây đầu tiên
    for (let i = 1; i <= period; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff > 0) gains += diff;
        else losses -= diff;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Sử dụng công thức mượt rải đều Wilder's Smoothing cho các nến tiếp theo
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

// Hàm lấy nến và tính RSI khung 15m
async function getRSI15m(symbol) {
    try {
        // Lấy khoảng 50 nến là dư sức để tính mượt RSI-14 chính xác
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=50`;
        const response = await axios.get(url, { timeout: 6000 });
        if (response.data && response.data.code === '0' && response.data.data.length >= 20) {
            const candles15m = response.data.data.reverse(); // Chuyển từ cũ đến mới

            // Lấy chuỗi giá đóng cửa (Close Price) để tính toán
            const prices15m = candles15m.map(c => parseFloat(c[4]));
            const rsi = calculateRSI(prices15m, 14);

            return { symbol, rsi, currentPrice: prices15m[prices15m.length - 1] };
        }
    } catch (error) {}
    return null;
}

async function main() {
    try {
        console.log('--- BẤT ĐẦU BOT KHUNG 15M THEO DÕI RSI TOP 20 COIN GIẢM 4D ---');
        
        // 1. Đọc danh sách 20 coin giảm mạnh từ file state.json
        if (!fs.existsSync(STATE_FILE)) {
            console.log('Không tìm thấy file trạng thái state.json!');
            return;
        }
        const stateData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        const top20Losers = stateData.top20Losers || [];

        if (top20Losers.length === 0) return;

        const sentLog = loadSentLog();
        const currentTime = Date.now();

        // 2. Lấy dữ liệu RSI song song của đúng 20 coin này (Cực kì tiết kiệm request)
        const rsiPromises = top20Losers.map(symbol => getRSI15m(symbol));
        const rsiResults = await Promise.all(rsiPromises);

        let hasNewAlert = false;

        for (let i = 0; i < top20Losers.length; i++) {
            const symbol = top20Losers[i];
            const metrics = rsiResults.find(r => r && r.symbol === symbol);
            if (!metrics) continue;

            if (!sentLog[symbol]) sentLog[symbol] = { _15m: 0 };
            const coinLog = sentLog[symbol];

            // 3. KIỂM TRA ĐIỀU KIỆN SHORT: RSI Khung 15m > 70
            if (metrics.rsi > 70) {
                // Kiểm tra Countdown chặn spam tin nhắn (6 giờ)
                if (currentTime - (coinLog._15m || 0) >= COUNTDOWN_15M) {
                    
                    const coinName = symbol.replace('-USDT-SWAP', '');
                    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
                    const labelRanking = `TOP GIẢM 4 NGÀY`;

                    // 4. Bắn tín hiệu sang Telegram
                    const message = `🔴 <b>SHORT TÍN HIỆU RSI 15M</b>\n🔥 Coin: <b>#${coinName}</b> (${labelRanking})\n📊 Chỉ số RSI: <code>${metrics.rsi.toFixed(2)}</code> (>70 Quá mua)\n👉 <a href="${link}">Giao dịch ngay</a>`;

                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID,
                        text: message,
                        parse_mode: 'HTML'
                    }).catch(() => {});

                    // 5. Cập nhật trạng thái thời gian gửi tin
                    sentLog[symbol]._15m = currentTime;
                    hasNewAlert = true;
                }
            }
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- KẾT THÚC TIẾN TRÌNH QUÉT RSI KHUNG 15M ---');
    } catch (err) {
        console.error('Lỗi chạy chính bot.js:', err.message);
    }
}

main();
