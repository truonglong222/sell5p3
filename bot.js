// Sử dụng cú pháp ES Modules (import) theo cấu hình package.json của bạn
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Cấu hình lấy từ biến môi trường (Environment Variables trên GitHub Secrets)
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;

const OKX_BASE_URL = 'https://www.okx.com';

// Định nghĩa __dirname cho môi trường ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'sentCoins.json');

// Hàm đọc lịch sử gửi từ file JSON
function loadSentLog() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            return data.trim() ? JSON.parse(data) : {};
        }
    } catch (error) {
        console.error('Lỗi khi đọc file json log:', error.message);
    }
    return {};
}

// --- HÀM SỬA ĐỔI: Dọn dẹp log cũ sau 2 giờ để nhẹ file ---
function saveSentLog(logData) {
    try {
        const now = Date.now();
        const cleanedLog = {};
        for (const [coin, timestamp] of Object.entries(logData)) {
            // Thay đổi mốc dọn dẹp từ 30 phút thành 2 giờ (2 * 60 * 60 * 1000 ms)
            if (now - timestamp < 2 * 60 * 60 * 1000) {
                cleanedLog[coin] = timestamp;
            }
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (error) {
        console.error('Lỗi khi ghi file json log:', error.message);
    }
}

// Hàm trì hoãn để tránh bị sàn chặn lỗi 429 Too Many Requests
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Hàm tính EMA 20 chuẩn kỹ thuật
function calculateEMA(prices, period = 20) {
    if (prices.length < period) return 0;
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;
    
    for (let i = period; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
}

// Lấy dữ liệu nến 15m để tính EMA20 và % thay đổi giá trong 8h qua (lùi 32 nến)
async function getMarketMetrics15m(symbol, lastPrice) {
    try {
        await sleep(250); // Nghỉ 250ms tối ưu Rate Limit
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=100`;
        const response = await axios.get(url);
        
        if (response.data && response.data.code === '0' && response.data.data.length > 40) {
            const candles = response.data.data.reverse();
            
            // 1. Tính EMA20 của nến vừa đóng cửa (candles.length - 2)
            const closedIndex = candles.length - 2; 
            const historyPrices = candles.slice(0, closedIndex + 1).map(c => parseFloat(c[4]));
            const ema20 = calculateEMA(historyPrices, 20);

            // 2. Tính % biến động 8h bằng 32 nến 15m trước đó so với giá hiện tại
            const targetIndex = candles.length - 33;
            const open8hAgo = parseFloat(candles[targetIndex][1]); // Giá mở cửa 32 nến trước
            
            const change8h = open8hAgo ? ((lastPrice - open8hAgo) / open8hAgo) * 100 : 0;

            return { ema20, change8h };
        }
        return null;
    } catch (error) {
        console.error(`Lỗi phân tích dữ liệu 15m cho ${symbol}:`, error.message);
        return null;
    }
}

// Hàm kiểm tra dải dung sai bất đối xứng theo công thức chuẩn: (EMA20 - Giá coin) / EMA20
function checkTolerance(indicatorVal, price, pctMin, pctMax) {
    if (!indicatorVal || !price) return false;
    const diffPct = (indicatorVal - price) / indicatorVal;
    return diffPct >= pctMin && diffPct <= pctMax;
}

// Hàm gửi nội dung tin nhắn về Telegram Chat dạng rút gọn tối giản
async function sendTelegramMessage(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        console.log('Đã gửi thông báo Telegram.');
    } catch (error) {
        console.error('Lỗi khi gửi Telegram:', error.message);
    }
}

// Luồng xử lý dữ liệu chính
async function main() {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.error('Thiếu cấu hình BOT_TOKEN hoặc CHAT_ID!');
        return;
    }

    try {
        console.log('Đang quét dữ liệu thị trường OKX...');
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);

        if (!response.data || response.data.code !== '0') {
            console.error('Không thể lấy dữ liệu từ OKX');
            return;
        }

        const sentLog = loadSentLog();
        const currentTime = Date.now();

        let tickers = response.data.data
            .filter(t => t.instId.endsWith('-USDT-SWAP'))
            .map(t => {
                const open24h = parseFloat(t.open24h);
                const lastPrice = parseFloat(t.last);
                const change24h = open24h ? ((lastPrice - open24h) / open24h) * 100 : 0;
                return { instId: t.instId, change24h, lastPrice };
            });

        // BƯỚC 1: Lấy chuẩn danh sách Top 10 tăng giá và Top 10 giảm giá 24h
        let top10Gainers24h = [...tickers].sort((a, b) => b.change24h - a.change24h).slice(0, 10);
        let top10Losers24h = [...tickers].sort((a, b) => a.change24h - b.change24h).slice(0, 10);

        let poolGainers = [];
        let poolLosers = [];

        // BƯỚC 2: Tính biến động 8h dựa trên 32 nến 15m cho TOÀN BỘ 20 COIN
        console.log('Đang tính toán dữ liệu 8h cho 10 coin tăng...');
        for (const coin of top10Gainers24h) {
            const metrics = await getMarketMetrics15m(coin.instId, coin.lastPrice);
            if (metrics) {
                poolGainers.push({ ...coin, change8h: metrics.change8h, ema20: metrics.ema20 });
            }
        }

        console.log('Đang tính toán dữ liệu 8h cho 10 coin giảm...');
        for (const coin of top10Losers24h) {
            const metrics = await getMarketMetrics15m(coin.instId, coin.lastPrice);
            if (metrics) {
                poolLosers.push({ ...coin, change8h: metrics.change8h, ema20: metrics.ema20 });
            }
        }

        // BƯỚC 3: Xếp hạng lấy chuẩn Top 5 tăng và Top 5 giảm trong 8h từ pool 20 coin trên
        poolGainers.sort((a, b) => b.change8h - a.change8h);
        let top5Gainers8h = poolGainers.slice(0, 5);

        poolLosers.sort((a, b) => a.change8h - b.change8h);
        let top5Losers8h = poolLosers.slice(0, 5);

        let hasNewAlert = false;

        // BƯỚC 4: Kiểm tra dung sai EMA20 riêng cho những coin đã lọt được vào danh sách Top 5 chuẩn
        // Kiểm tra dải Long cho Top 5 tăng 8h
        for (let i = 0; i < top5Gainers8h.length; i++) {
            const coin = top5Gainers8h[i];
            const symbol = coin.instId;
            const rank8h = i + 1;

            // --- SỬA ĐỔI: Chặn gửi trùng lặp nếu khoảng cách thời gian nhỏ hơn 2 giờ ---
            if (sentLog[symbol] && (currentTime - sentLog[symbol] < 2 * 60 * 60 * 1000)) continue;

            // Kiểm tra dung sai Long: +1%, -0.1% -> [-0.001, 0.01]
            if (checkTolerance(coin.ema20, coin.lastPrice, -0.001, 0.01)) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const lowerSymbol = symbol.toLowerCase();
                const link = `https://www.okx.com/trade-swap/${lowerSymbol}`;

                const message = `🟢 <b>LONG #${coinName}</b>\n` +
                                `• Giá: ${coin.lastPrice} (8h_32n: +${coin.change8h.toFixed(2)}%)\n` +
                                `• Cản: Top ${rank8h} Tăng 8h + Sát EMA20 (+1%/-0.1%)\n` +
                                `👉 <a href="${link}">Giao dịch ngay</a>`;

                await sendTelegramMessage(message);
                sentLog[symbol] = currentTime;
                hasNewAlert = true;
            }
        }

        // Kiểm tra dải Short cho Top 5 giảm 8h
        for (let i = 0; i < top5Losers8h.length; i++) {
            const coin = top5Losers8h[i];
            const symbol = coin.instId;
            const rank8h = i + 1;

            // --- SỬA ĐỔI: Chặn gửi trùng lặp nếu khoảng cách thời gian nhỏ hơn 2 giờ ---
            if (sentLog[symbol] && (currentTime - sentLog[symbol] < 2 * 60 * 60 * 1000)) continue;

            // Kiểm tra dung sai Short: -1%, +0.3% -> [-0.01, 0.003]
            if (checkTolerance(coin.ema20, coin.lastPrice, -0.01, 0.003)) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const lowerSymbol = symbol.toLowerCase();
                const link = `https://www.okx.com/trade-swap/${lowerSymbol}`;

                const message = `🔴 <b>SHORT #${coinName}</b>\n` +
                                `• Giá: ${coin.lastPrice} (8h_32n: ${coin.change8h.toFixed(2)}%)\n` +
                                `• Cản: Top ${rank8h} Giảm 8h + Sát EMA20 (-1%/+0.3%)\n` +
                                `👉 <a href="${link}">Giao dịch ngay</a>`;

                await sendTelegramMessage(message);
                sentLog[symbol] = currentTime;
                hasNewAlert = true;
            }
        }

        if (hasNewAlert) {
            saveSentLog(sentLog);
        }
        console.log('Hoàn thành chu kỳ quét chuẩn.');

    } catch (error) {
        console.error('Lỗi hệ thống hàm main:', error.message);
    }
}

// Thực thi chạy chương trình chính
main();
