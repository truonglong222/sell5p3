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

// Cấu hình thời gian chặn gửi lại (Countdown) theo quy trình mới
const COUNTDOWN_5M = 4 * 60 * 60 * 1000;  // 4 giờ
const COUNTDOWN_15M = 6 * 60 * 60 * 1000; // 6 giờ

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
        // Dọn dẹp log dựa trên thời gian hết hạn tối đa của quy trình mới (6 giờ)
        for (const [coin, timeData] of Object.entries(logData)) {
            const temp = {};
            if (timeData._5m && now - timeData._5m < COUNTDOWN_5M) temp._5m = timeData._5m;
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

async function getTechnicalMetrics(symbol) {
    try {
        // Lấy 150 nến 5 phút theo quy trình mới
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=5m&limit=150`;
        const response = await axios.get(url, { timeout: 8000 });
        if (response.data && response.data.code === '0' && response.data.data.length >= 100) {
            const candles5m = response.data.data.reverse();
            const currentCandle = candles5m[candles5m.length - 1];
            const currentHigh = parseFloat(currentCandle[2]); // Đỉnh (High) của nến hiện tại

            // Lấy danh sách các nến đã đóng cửa để tính toán kỹ thuật
            const closedCandles5m = candles5m.slice(0, candles5m.length - 1);
            
            // 1. Tính EMA20 khung 5 phút
            const prices5m = closedCandles5m.map(c => parseFloat(c[4]));
            const ema20_5m = calculateEMA(prices5m, 20);

            // 2. Ghép nến 5m thành nến 15m (3 nến 5m tạo thành 1 nến 15m, lấy giá đóng cửa tại nến cuối mỗi cụm)
            const prices15m = [];
            for (let i = 2; i < closedCandles5m.length; i += 3) {
                prices15m.push(parseFloat(closedCandles5m[i][4]));
            }
            // 3. Tính EMA20 khung 15 phút
            const ema20_15m = calculateEMA(prices15m, 20);

            // 4. Tính khoảng cách từ EMA đến đỉnh (High) theo công thức tỷ lệ %
            const b_5m = ema20_5m ? ((ema20_5m - currentHigh) / ema20_5m) * 100 : 999;
            const b_15m = ema20_15m ? ((ema20_15m - currentHigh) / ema20_15m) * 100 : 999;

            return { symbol, b_5m, b_15m };
        }
        return null;
    } catch (error) { return null; }
}

async function main() {
    try {
        // 1. Đọc file state.json và chỉ lấy trường openPrices
        if (!fs.existsSync(STATE_FILE)) return;
        const stateData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        const openPrices7AM = stateData.openPrices || {};

        // 2. Lấy toàn bộ Futures OKX
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);
        if (!response.data || response.data.code !== '0') return;

        const sentLog = loadSentLog();
        const currentTime = Date.now();

        // 3. Tính % thay đổi kể từ giá mở cửa 7h sáng
        let calculatedPool = response.data.data
            .filter(t => t.instId.endsWith('-USDT-SWAP') && openPrices7AM[t.instId])
            .map(t => {
                const open7AM = parseFloat(openPrices7AM[t.instId]);
                const lastPrice = parseFloat(t.last);
                const vol24hQuote = parseFloat(t.vol24h); // Volume 24h quy đổi ra USD/USDT
                const changeSince7AM = open7AM ? ((lastPrice - open7AM) / open7AM) * 100 : 0;
                return { instId: t.instId, changeSince7AM, lastPrice, vol24hQuote };
            });

        // 4. Sắp xếp từ giảm mạnh nhất đến tăng (tăng dần theo %) và Lọc Volume > 5.000.000 USD
        let filteredPool = calculatedPool
            .sort((a, b) => a.changeSince7AM - b.changeSince7AM) // Giảm nhiều nhất xếp lên đầu
            .filter(c => c.vol24hQuote >= 5000000); // Lọc Volume

        // 5. Lấy Top 10 giảm mạnh nhất
        let top10Losers = filteredPool.slice(0, 10);

        // Nếu không còn coin nào thỏa mãn -> Kết thúc
        if (top10Losers.length === 0) return;

        // Lấy dữ liệu kỹ thuật song song cho các coin trong Top 10
        const technicalPromises = top10Losers.map(coin => getTechnicalMetrics(coin.instId));
        const technicalResults = await Promise.all(technicalPromises);

        let hasNewAlert = false;

        for (let i = 0; i < top10Losers.length; i++) {
            const coinData = top10Losers[i];
            const symbol = coinData.instId;
            const metrics = technicalResults.find(r => r && r.symbol === symbol);
            if (!metrics) continue;

            if (!sentLog[symbol]) sentLog[symbol] = { _5m: 0, _15m: 0 };
            const coinLog = sentLog[symbol];

            let triggeredFrame = null;

            // 6. Kiểm tra điều kiện Short & Countdown độc lập cho từng khung thời gian
            // Điều kiện: b_5m hoặc b_15m nằm trong khoảng [-1%; 0.5%]
            
            // Thử kiểm tra khung 5m trước
            if (metrics.b_5m >= -1 && metrics.b_5m <= 0.5) {
                // Kiểm tra xem đã hết thời gian countdown 4 giờ chưa
                if (currentTime - (coinLog._5m || 0) >= COUNTDOWN_5M) {
                    triggeredFrame = "5m";
                }
            } 
            
            // Nếu khung 5m chưa/không kích hoạt, thử kiểm tra tiếp khung 15m
            if (!triggeredFrame && (metrics.b_15m >= -1 && metrics.b_15m <= 0.5)) {
                // Kiểm tra xem đã hết thời gian countdown 6 giờ chưa
                if (currentTime - (coinLog._15m || 0) >= COUNTDOWN_15M) {
                    triggeredFrame = "15m";
                }
            }

            // 7. Nếu đủ điều kiện, tiến hành gửi thông báo Telegram
            if (triggeredFrame) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
                const formattedPct = coinData.changeSince7AM >= 0 ? `+${coinData.changeSince7AM.toFixed(2)}%` : `${coinData.changeSince7AM.toFixed(2)}%`;
                const labelRanking = `TOP ${i + 1} GIẢM`;

                const message = `🔴 <b>SHORT ${triggeredFrame.toUpperCase()} #${coinName} ${labelRanking} (${formattedPct})</b>\n👉 <a href="${link}">Giao dịch ngay</a>`;

                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML'
                }).catch(() => {});

                // 8. Cập nhật thời gian gửi vào hệ thống quản lý Countdown
                if (triggeredFrame === "5m") sentLog[symbol]._5m = currentTime;
                if (triggeredFrame === "15m") sentLog[symbol]._15m = currentTime;
                hasNewAlert = true;
            }
        }

        // 9. Lưu trạng thái countdown mới vào file sentCoins.json nếu có cập nhật mới
        if (hasNewAlert) saveSentLog(sentLog);
    } catch (err) {}
}

main();
