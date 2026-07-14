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
const COUNTDOWN_15M = 6 * 60 * 60 * 1000; 

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
            if (timeData._15m && now - timeData._15m < COUNTDOWN_15M) temp._15m = timeData._15m;
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

function calculateEMA(prices, period = 20) {
    if (prices.length < period) return 0;
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;
    for (let i = period; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
}

// Hàm lấy dữ liệu nến 15m (100 cây nến) để tính toán:
// 1. % biến động 6h qua (24 nến)
// 2. EMA20 và khoảng cách b_15m từ giá High hiện tại tới EMA20
async function getTechnicalData(symbol) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=100`;
        const response = await axios.get(url, { timeout: 6000 });
        if (response.data && response.data.code === '0' && response.data.data.length >= 40) {
            const candles15m = response.data.data; // Index 0 là nến hiện hành (chưa đóng)

            // A. Tính % giảm giá 6h vừa qua (dựa vào 24 nến 15m)
            const currentPrice = parseFloat(candles15m[0][4]); // Giá close hiện tại
            const target6hCandle = candles15m[Math.min(23, candles15m.length - 1)];
            const price6HoursAgo = parseFloat(target6hCandle[1]); // Giá open của 6h trước
            const change6h = price6HoursAgo ? ((currentPrice - price6HoursAgo) / price6HoursAgo) * 100 : 0;

            // B. Tính EMA20 khung 15 phút (Dùng danh sách nến đã đóng cửa)
            const reversedCandles = [...candles15m].reverse();
            const currentHigh = parseFloat(reversedCandles[reversedCandles.length - 1][2]); // Giá cao nhất nến hiện tại
            const closedCandles = reversedCandles.slice(0, reversedCandles.length - 1);
            
            const prices15m = closedCandles.map(c => parseFloat(c[4]));
            const ema20_15m = calculateEMA(prices15m, 20);

            // C. Tính khoảng cách: (EMA20 - High) / EMA20 * 100
            const b_15m = ema20_15m ? ((ema20_15m - currentHigh) / ema20_15m) * 100 : 999;

            return { symbol, change6h, b_15m };
        }
    } catch (error) {}
    return null;
}

async function main() {
    try {
        console.log('--- BẤT ĐẦU BOT PHỐI HỢP ĐA LỚP: TOP 30 TĂNG (24H) & TOP 50 GIẢM (30D) ---');

        // 1. Đọc danh sách Top 50 giảm trong tháng từ file state.json (do 7h.js tạo ra)
        if (!fs.existsSync(STATE_FILE)) {
            console.log('Không tìm thấy file state.json từ tiến trình 7h sáng!');
            return;
        }
        const stateData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        const top50MonthLosers = stateData.top20Losers || []; // Mảng chứa tối đa 50 coin

        if (top50MonthLosers.length === 0) {
            console.log('Danh sách Top giảm tháng rỗng.');
            return;
        }

        // 2. Tải Ticker tổng để lọc ra Top 30 tăng mạnh nhất 24h qua có volume > 2M USD
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);
        if (!response.data || response.data.code !== '0') return;

        const filteredTickers = response.data.data.filter(t => 
            t.instId.endsWith('-USDT-SWAP') && parseFloat(t.vol24h) >= 2000000
        );

        // Tính % biến động 24h dựa vào sod24h
        const poolWith24hChange = filteredTickers.map(t => {
            const open24h = parseFloat(t.sod24h);
            const lastPrice = parseFloat(t.last);
            const change24h = open24h ? ((lastPrice - open24h) / open24h) * 100 : 0;
            return { instId: t.instId, change24h };
        });

        // Trích xuất Top 30 tăng mạnh nhất 24h qua
        const top30Gainers24h = poolWith24hChange
            .sort((a, b) => b.change24h - a.change24h) // Tăng mạnh nhất xếp lên đầu
            .slice(0, 30)
            .map(item => item.instId);

        // 3. Giao thoa 2 danh sách: Lọc ra các coin nằm trong Top 30 tăng 24h VÀ có mặt trong Top 50 giảm tháng
        const targetCandidates = top30Gainers24h.filter(symbol => top50MonthLosers.includes(symbol));

        if (targetCandidates.length === 0) {
            console.log('Không có coin nào thuộc Top 30 tăng 24h đồng thời thuộc Top 50 giảm tháng.');
            return;
        }

        console.log(`Tìm thấy ${targetCandidates.length} ứng viên thỏa mãn bộ lọc xu hướng dài hạn.`);

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        // 4. Quét nến 15m cho các coin thỏa mãn để tính RSI, % giảm 6h và EMA20
        for (let i = 0; i < targetCandidates.length; i++) {
            const symbol = targetCandidates[i];
            const metrics = await getTechnicalData(symbol);
            if (!metrics) continue;

            if (!sentLog[symbol]) sentLog[symbol] = { _15m: 0 };
            const coinLog = sentLog[symbol];

            // 5. KIỂM TRA ĐIỀU KIỆN SHORT CHI TIẾT:
            // - Điều kiện 1: Giảm giá 6h qua <-4% (tức change6h âm sâu hơn -4)
            // - Điều kiện 2: EMA20 tiệm cận giá High hiện tại trong khoảng -1% < (EMA20 - High) / EMA20 < 0.3%
            const condDecline6h = metrics.change6h < -4;
            const condEmaProximity = metrics.b_15m > -1 && metrics.b_15m < 0.3;

            if (condDecline6h && condEmaProximity) {
                // Kiểm tra Countdown 6 giờ chống trùng lặp tin nhắn
                if (currentTime - (coinLog._15m || 0) >= COUNTDOWN_15M) {

                    const coinName = symbol.replace('-USDT-SWAP', '');
                    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                    // Gửi tín hiệu về Telegram
                    const message = `🔴 <b>SHORT TÍN HIỆU PHỐI HỢP 15M</b>\n` +
                                    `🔥 Coin: <b>#${coinName}</b>\n` +
                                    `📉 Giảm 6h qua: <code>${metrics.change6h.toFixed(2)}%</code> (&lt; -4%)\n` +
                                    `📏 Khoảng cách EMA20: <code>${metrics.b_15m.toFixed(2)}%</code>\n` +
                                    `📌 <i>(Thỏa mãn: Thuộc Top 30 tăng 24h & Top 50 giảm tháng)</i>\n` +
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
            // Tạo một nhịp nghỉ nhỏ giữa các request nến tuần tự
            await sleep(50);
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- HOÀN THÀNH TIẾN TRÌNH QUÉT BOT ---');
    } catch (err) {
        console.error('Lỗi chạy chính bot.js:', err.message);
    }
}

main();
