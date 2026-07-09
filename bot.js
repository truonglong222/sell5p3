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

// Dọn dẹp log cũ sau 2 giờ để nhẹ file
function saveSentLog(logData) {
    try {
        const now = Date.now();
        const cleanedLog = {};
        for (const [coin, timestamp] of Object.entries(logData)) {
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

// Lấy dữ liệu nến 15m: Trả về EMA20 và Giá cao nhất/thấp nhất của nến hiện tại đang chạy
async function getMetrics15m(symbol) {
    try {
        await sleep(250);
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=100`;
        const response = await axios.get(url);
        
        if (response.data && response.data.code === '0' && response.data.data.length > 25) {
            const candles = response.data.data.reverse();
            
            // Tính EMA20 cho nến vừa đóng cửa (candles.length - 2)
            const closedIndex = candles.length - 2;
            const historyPrices = candles.slice(0, closedIndex + 1).map(c => parseFloat(c[4]));
            const ema20 = calculateEMA(historyPrices, 20);

            // Lấy High/Low của nến hiện tại đang chạy (candles.length - 1)
            const currentCandle = candles[candles.length - 1];
            const currentHigh = parseFloat(currentCandle[2]);
            const currentLow = parseFloat(currentCandle[3]);

            return { ema20_15m: ema20, currentHigh15m: currentHigh, currentLow15m: currentLow };
        }
        return null;
    } catch (error) {
        console.error(`Lỗi lấy dữ liệu nến 15m cho ${symbol}:`, error.message);
        return null;
    }
}

// Lấy dữ liệu nến 1H: Trả về EMA20, % tăng trưởng 24h (24 nến) và % giảm giá 8h (8 nến)
async function getMetrics1H(symbol, lastPrice) {
    try {
        await sleep(250);
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=100`;
        const response = await axios.get(url);
        
        if (response.data && response.data.code === '0' && response.data.data.length > 30) {
            const candles = response.data.data.reverse();
            
            // Tính EMA20 cho nến 1h vừa đóng cửa (candles.length - 2)
            const closedIndex = candles.length - 2;
            const historyPrices = candles.slice(0, closedIndex + 1).map(c => parseFloat(c[4]));
            const ema20 = calculateEMA(historyPrices, 20);

            // Tính tăng giá 24h bằng cách lùi ngược 24 nến 1H trước đó so với hiện tại
            const index24h = candles.length - 25;
            const open24hAgo = parseFloat(candles[index24h][1]);
            const change24h = open24hAgo ? ((lastPrice - open24hAgo) / open24hAgo) * 100 : 0;

            // Tính giảm giá 8h bằng cách lùi ngược 8 nến 1H trước đó so với hiện tại
            const index8h = candles.length - 9;
            const open8hAgo = parseFloat(candles[index8h][1]);
            const change8h = open8hAgo ? ((lastPrice - open8hAgo) / open8hAgo) * 100 : 0;

            return { ema20_1h: ema20, change24h, change8h };
        }
        return null;
    } catch (error) {
        console.error(`Lỗi lấy dữ liệu nến 1H cho ${symbol}:`, error.message);
        return null;
    }
}

// Hàm kiểm tra dải dung sai bất đối xứng theo cấu trúc: (EMA20 - Giá Mục Tiêu) / EMA20
function checkTolerance(indicatorVal, testPrice, pctMin, pctMax) {
    if (!indicatorVal || !testPrice) return false;
    const diffPct = (indicatorVal - testPrice) / indicatorVal;
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

        // Lọc các cặp USDT-SWAP
        let tickers = response.data.data
            .filter(t => t.instId.endsWith('-USDT-SWAP'))
            .map(t => {
                const open24h = parseFloat(t.open24h);
                const lastPrice = parseFloat(t.last);
                const change24h = open24h ? ((lastPrice - open24h) / open24h) * 100 : 0;
                return { instId: t.instId, change24h, lastPrice };
            });

        // BƯỚC 1: Lấy chính xác Top 20 coin tăng giá mạnh nhất dựa trên dữ liệu Ticker sàn
        let top20Gainers = tickers.sort((a, b) => b.change24h - a.change24h).slice(0, 20);

        let hasNewAlert = false;

        // BƯỚC 2: Duyệt qua danh sách top 20 để bóc tách chỉ báo đa khung giờ
        for (const coin of top20Gainers) {
            const symbol = coin.instId;

            if (sentLog[symbol] && (currentTime - sentLog[symbol] < 2 * 60 * 60 * 1000)) continue;

            // Thu thập dữ liệu khung 15m
            const data15m = await getMetrics15m(symbol);
            if (!data15m) continue;

            // Thu thập dữ liệu khung 1H
            const data1h = await getMetrics1H(symbol, coin.lastPrice);
            if (!data1h) continue;

            const change24h_1h = data1h.change24h; // Tăng giá 24h tính bằng nến 1h
            const change8h_1h = data1h.change8h;   // Giảm giá 8h tính bằng nến 1h

            let signal = null;
            let reason = "";

            // --- THIẾT LẬP MAIN LOGIC THEO ĐÚNG CÔNG THỨC YÊU CẦU MỚI ---
            
            // Nhánh 1: Tín hiệu LONG (Yêu cầu tăng 24h > 15%)
            if (change24h_1h > 15) {
                // Check Long 15p: Dung sai dựa trên Giá Thấp Nhất 15m nằm trong khoảng -0.2% < diff < +1%
                if (checkTolerance(data15m.ema20_15m, data15m.currentLow15m, -0.002, 0.01)) {
                    signal = "Long 15p";
                    reason = `Tăng 24h (${change24h_1h.toFixed(1)}%) + Râu 15m chạm EMA20_15m`;
                } 
                // Check Long 1h: Dung sai dựa trên Giá Thấp Nhất 15m nằm trong khoảng -0.5% < diff < +1%
                else if (checkTolerance(data1h.ema20_1h, data15m.currentLow15m, -0.005, 0.01)) {
                    signal = "Long 1h";
                    reason = `Tăng 24h (${change24h_1h.toFixed(1)}%) + Râu 15m chạm EMA20_1H`;
                }
            } 
            
            // Nhánh 2: Tín hiệu SHORT (Yêu cầu giảm giá 8h < -10%)
            if (change8h_1h < -10) {
                // Check Short 15p: Dung sai dựa trên Giá Cao Nhất 15m nằm trong khoảng +0.2% < diff < -1% (Tức là [-1%, 0.2%] trên trục số)
                if (checkTolerance(data15m.ema20_15m, data15m.currentHigh15m, -0.01, 0.002)) {
                    signal = "Short 15p";
                    reason = `Giảm 8h (${change8h_1h.toFixed(1)}%) + Râu 15m chạm EMA20_15m`;
                } 
                // Check Short 1h: Dung sai dựa trên Giá Cao Nhất 15m nằm trong khoảng +0.5% < diff < -1% (Tức là [-1%, 0.5%] trên trục số)
                else if (checkTolerance(data1h.ema20_1h, data15m.currentHigh15m, -0.01, 0.005)) {
                    signal = "Short 1h";
                    reason = `Giảm 8h (${change8h_1h.toFixed(1)}%) + Râu 15m chạm EMA20_1H`;
                }
            }

            // Gửi tin nhắn rút gọn siêu tốc nếu thỏa mãn các lớp lọc chỉ báo
            if (signal) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const lowerSymbol = symbol.toLowerCase();
                const link = `https://www.okx.com/trade-swap/${lowerSymbol}`;
                const icon = signal.startsWith("Long") ? "🟢" : "🔴";

                const message = `${icon} <b>${signal.toUpperCase()} #${coinName}</b>\n` +
                                `• Giá hiện tại: ${coin.lastPrice}\n` +
                                `• Chỉ báo: ${reason}\n` +
                                `👉 <a href="${link}">Giao dịch ngay</a>`;

                await sendTelegramMessage(message);
                sentLog[symbol] = currentTime;
                hasNewAlert = true;
            }
        }

        if (hasNewAlert) {
            saveSentLog(sentLog);
        }
        console.log('Hoàn thành chu kỳ quét đa khung giờ.');

    } catch (error) {
        console.error('Lỗi hệ thống hàm main:', error.message);
    }
}

// Thực thi chạy chương trình chính
main();
