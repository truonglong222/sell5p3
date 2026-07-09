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

// GỌI ĐỒNG THỜI KHUNG 1H: Trả về EMA20 1H, % tăng 50h, % giảm 8h
async function getMetrics1H(symbol, lastPrice) {
    try {
        await sleep(250); // Giãn cách nhẹ chống nghẽn dòng chảy
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=100`;
        const response = await axios.get(url);
        
        if (response.data && response.data.code === '0' && response.data.data.length > 55) {
            const candles = response.data.data.reverse();
            
            // Tính EMA20 cho nến 1h vừa đóng cửa (candles.length - 2)
            const closedIndex = candles.length - 2;
            const historyPrices = candles.slice(0, closedIndex + 1).map(c => parseFloat(c[4]));
            const ema20_1h = calculateEMA(historyPrices, 20);

            // Tính tăng trưởng dựa trên mốc 50 cây nến 1H trước đó
            const index50h = candles.length - 51;
            const open50hAgo = parseFloat(candles[index50h][1]);
            const change50h = open50hAgo ? ((lastPrice - open50hAgo) / open50hAgo) * 100 : 0;

            // Tính giảm giá 8h bằng cách lùi ngược 8 nến 1H trước đó
            const index8h = candles.length - 9;
            const open8hAgo = parseFloat(candles[index8h][1]);
            const change8h = open8hAgo ? ((lastPrice - open8hAgo) / open8hAgo) * 100 : 0;

            return { ema20_1h, change50h, change8h };
        }
        return null;
    } catch (error) {
        console.error(`Lỗi lấy dữ liệu nến 1H cho ${symbol}:`, error.message);
        return null;
    }
}

// CHỈ GỌI KHI THỎA ĐIỀU KIỆN 1H: Lấy EMA20 nến 15m và High/Low hiện tại
async function getMetrics15m(symbol) {
    try {
        await sleep(250);
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=100`;
        const response = await axios.get(url);
        
        if (response.data && response.data.code === '0' && response.data.data.length > 25) {
            const candles = response.data.data.reverse();
            
            // Tính EMA20 cho nến 15m vừa đóng cửa
            const closedIndex = candles.length - 2;
            const historyPrices = candles.slice(0, closedIndex + 1).map(c => parseFloat(c[4]));
            const ema20_15m = calculateEMA(historyPrices, 20);

            // Lấy High/Low của nến hiện tại đang chạy (candles.length - 1)
            const currentCandle = candles[candles.length - 1];
            const currentHigh = parseFloat(currentCandle[2]);
            const currentLow = parseFloat(currentCandle[3]);

            return { ema20_15m, currentHigh15m: currentHigh, currentLow15m: currentLow };
        }
        return null;
    } catch (error) {
        console.error(`Lỗi lấy dữ liệu nến 15m cho ${symbol}:`, error.message);
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
        // BƯỚC 1: Lấy toàn bộ Futures USDT (1 request tổng)
        console.log('Đang quét dữ liệu ticker thị trường OKX...');
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);

        if (!response.data || response.data.code !== '0') {
            console.error('Không thể lấy dữ liệu từ OKX');
            return;
        }

        const sentLog = loadSentLog();
        const currentTime = Date.now();

        // BƯỚC 2: Tính % thay đổi 24h từ ticker (Xử lý mảng nội bộ không tốn request)
        let tickers = response.data.data
            .filter(t => t.instId.endsWith('-USDT-SWAP'))
            .map(t => {
                const open24h = parseFloat(t.open24h);
                const lastPrice = parseFloat(t.last);
                const change24h = open24h ? ((lastPrice - open24h) / open24h) * 100 : 0;
                return { instId: t.instId, change24h, lastPrice };
            });

        // BƯỚC 3: Sắp xếp lấy chuẩn danh sách Top 20 tăng mạnh nhất
        let top20Gainers = tickers.sort((a, b) => b.change24h - a.change24h).slice(0, 20);

        let hasNewAlert = false;

        // BƯỚC 4: Duyệt vòng lặp và loại bỏ coin đang cooldown 2 giờ ngay tại đầu cổng vào
        for (const coin of top20Gainers) {
            const symbol = coin.instId;

            // Loại bỏ không tốn request
            if (sentLog[symbol] && (currentTime - sentLog[symbol] < 2 * 60 * 60 * 1000)) {
                console.log(`-> Bỏ qua ${symbol} vì đang trong thời gian cooldown 2 giờ.`);
                continue;
            }

            // BƯỚC 5: Gọi dữ liệu nến 1H cho các coin hợp lệ vượt qua vòng chặn cooldown
            console.log(`Đang phân tích khung 1H cho ${symbol}...`);
            const data1h = await getMetrics1H(symbol, coin.lastPrice);
            if (!data1h) continue;

            const change50h_1h = data1h.change50h; // % tăng 50h
            const change8h_1h = data1h.change8h;   // % giảm 8h

            // Xác định xem coin có chạm ngầm vùng điều kiện khung 1H hay không
            const isLong1hCondition = change50h_1h > 20;
            const isShort1hCondition = change8h_1h < -10;

            // BƯỚC 6: Nếu thỏa mãn % tăng 50h > 20% HOẶC % giảm 8h < -10% thì mới gọi tiếp nến 15m
            if (!isLong1hCondition && !isShort1hCondition) continue;

            console.log(`=> Thỏa mãn khung 1H. Đang kích hoạt lấy dữ liệu nến 15m cho ${symbol}...`);
            const data15m = await getMetrics15m(symbol);
            if (!data15m) continue;

            let signal = null;
            let reason = "";

            // --- BƯỚC 7: KIỂM TRA ĐIỀU KIỆN DUNG SAI CHI TIẾT ---
            
            // Khớp lệnh LONG
            if (isLong1hCondition) {
                // Check nhánh Long 15p: -0.2% < dung sai < +1% -> [-0.002, 0.01]
                if (checkTolerance(data15m.ema20_15m, data15m.currentLow15m, -0.002, 0.01)) {
                    signal = "Long 15p";
                    reason = `Tăng 50h (${change50h_1h.toFixed(1)}%) + Râu 15m chạm EMA20_15m`;
                } 
                // Check nhánh Long 1h: -0.5% < dung sai < +1% -> [-0.005, 0.01]
                else if (checkTolerance(data1h.ema20_1h, data15m.currentLow15m, -0.005, 0.01)) {
                    signal = "Long 1h";
                    reason = `Tăng 50h (${change50h_1h.toFixed(1)}%) + Râu 15m chạm EMA20_1H`;
                }
            } 
            
            // Khớp lệnh SHORT
            if (isShort1hCondition) {
                // Check nhánh Short 15p: +0.2% < dung sai < -1% (Tức là [-1%, 0.2%] trên trục số)
                if (checkTolerance(data15m.ema20_15m, data15m.currentHigh15m, -0.01, 0.002)) {
                    signal = "Short 15p";
                    reason = `Giảm 8h (${change8h_1h.toFixed(1)}%) + Râu 15m chạm EMA20_15m`;
                } 
                // Check nhánh Short 1h: +0.5% < dung sai < -1% (Tức là [-1%, 0.5%] trên trục số)
                else if (checkTolerance(data1h.ema20_1h, data15m.currentHigh15m, -0.01, 0.005)) {
                    signal = "Short 1h";
                    reason = `Giảm 8h (${change8h_1h.toFixed(1)}%) + Râu 15m chạm EMA20_1H`;
                }
            }

            // Tiến hành bắn tín hiệu về máy Telegram
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
        console.log('Hoàn thành chu kỳ quét tối ưu hóa.');

    } catch (error) {
        console.error('Lỗi hệ thống hàm main:', error.message);
    }
}

// Thực thi chạy chương trình chính
main();
