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
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Lỗi khi đọc file json log:', error.message);
    }
    return {};
}

// Hàm ghi lịch sử gửi vào file JSON (Xóa bớt log cũ sau 30 phút để nhẹ file)
function saveSentLog(logData) {
    try {
        const now = Date.now();
        const cleanedLog = {};
        for (const [coin, timestamp] of Object.entries(logData)) {
            if (now - timestamp < 30 * 60 * 1000) {
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

// Công thức tính RSI chuẩn kỹ thuật với chu kỳ mặc định là 20
function calculateRSI(prices, period = 20) {
    if (prices.length <= period) return 0;
    
    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        let difference = prices[i] - prices[i - 1];
        if (difference >= 0) gains += difference;
        else losses -= difference;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < prices.length; i++) {
        let difference = prices[i] - prices[i - 1];
        let gain = difference >= 0 ? difference : 0;
        let loss = difference < 0 ? -difference : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) return 100;
    let rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// Gọi API lấy dữ liệu nến của OKX và tính toán các thông số theo logic mới
async function getMarketMetrics(symbol, bar = '15m') {
    try {
        await sleep(250); // Nghỉ 250ms tối ưu Rate Limit
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=75`;
        const response = await axios.get(url);
        
        if (response.data && response.data.code === '0' && response.data.data.length > 25) {
            // Đảo mảng từ cũ đến mới
            const candles = response.data.data.reverse();
            
            // Nến cuối cùng (candles.length - 1) là nến đang chạy, nến vừa đóng là (candles.length - 2)
            const closedIndex = candles.length - 2;
            
            // 1. Tính RSI 20 cho nến 15m vừa đóng
            const historyForRSI = candles.slice(0, closedIndex + 1).map(c => parseFloat(c[4]));
            const rsi20 = calculateRSI(historyForRSI, 20);

            // 2. Tính biến động nến vừa đóng: |Close - Open| / Open * 100
            const closedCandle = candles[closedIndex];
            const cOpen = parseFloat(closedCandle[1]);
            const cClose = parseFloat(closedCandle[4]);
            const currentVol = cOpen ? (Math.abs(cClose - cOpen) / cOpen) * 100 : 0;

            // 3. SỬA ĐỔI: Tính biến động trung bình của 20 nến trước đó dựa trên |Close - Open|
            let totalVol20 = 0;
            for (let i = closedIndex - 20; i < closedIndex; i++) {
                const o = parseFloat(candles[i][1]);
                const c = parseFloat(candles[i][4]);
                totalVol20 += o ? (Math.abs(c - o) / o) * 100 : 0;
            }
            const avgVol20 = totalVol20 / 20;

            // Tính tổng biến động tích lũy (độ rộng vùng giá) của 20 nến trước để check điều kiện < 7%
            const initialOpen = parseFloat(candles[closedIndex - 20][1]);
            let highestIn20 = -Infinity;
            let lowestIn20 = Infinity;
            for (let i = closedIndex - 20; i < closedIndex; i++) {
                const h = parseFloat(candles[i][2]); // Vẫn giữ High/Low cho biên độ vùng tích lũy
                const l = parseFloat(candles[i][3]);
                if (h > highestIn20) highestIn20 = h;
                if (l < lowestIn20) lowestIn20 = l;
            }
            const rangeVol20 = initialOpen ? ((highestIn20 - lowestIn20) / initialOpen) * 100 : 0;

            // 4. Tính toán hệ số đột biến x
            const x = avgVol20 > 0 ? (currentVol / avgVol20) : 0;

            return { rsi20, x, rangeVol20 };
        }
        return { rsi20: 0, x: 0, rangeVol20: 0 };
    } catch (error) {
        console.error(`Lỗi khi phân tích dữ liệu kỹ thuật cho ${symbol}:`, error.message);
        return { rsi20: 0, x: 0, rangeVol20: 0 };
    }
}

// Hàm gửi nội dung tin nhắn về Telegram Chat thông qua HTTP POST
async function sendTelegramMessage(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: false
        });
        console.log('Đã gửi thông báo Telegram thành công.');
    } catch (error) {
        console.error('Lỗi khi gửi Telegram:', error.message);
    }
}

// Luồng xử lý dữ liệu chính
async function main() {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.error('Thiếu cấu hình BOT_TOKEN hoặc CHAT_ID trong Environment Variables!');
        return;
    }

    try {
        console.log('Đang lấy danh sách các cặp coin Future trên OKX...');
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);

        if (!response.data || response.data.code !== '0') {
            console.error('Không thể lấy dữ liệu từ OKX');
            return;
        }

        const sentLog = loadSentLog();
        const currentTime = Date.now();

        // Lọc ra các cặp phái sinh thanh toán bằng cặp USDT (Ví dụ: BTC-USDT-SWAP)
        let tickers = response.data.data
            .filter(t => t.instId.endsWith('-USDT-SWAP'))
            .map(t => {
                const open24h = parseFloat(t.open24h);
                const lastPrice = parseFloat(t.last);
                const change24h = open24h ? ((lastPrice - open24h) / open24h) * 100 : 0;
                return {
                    instId: t.instId, 
                    change24h: change24h,
                    lastPrice: lastPrice
                };
            });

        // --- ĐÃ ĐỔI THÀNH LẤY TOP 50 CẶP TĂNG MẠNH NHẤT ---
        tickers.sort((a, b) => b.change24h - a.change24h);
        const top50Fastest = tickers.slice(0, 50);

        console.log('Top 50 coin tăng mạnh nhất 24h qua:');
        console.table(top50Fastest);

        let hasNewAlert = false;

        // Vòng lặp quét kiểm tra đối với từng đồng coin trong danh sách top 50
        for (const coin of top50Fastest) {
            const symbol = coin.instId;

            // Kiểm tra bộ nhớ file chống trùng trong khoảng thời gian 30 phút
            if (sentLog[symbol]) {
                const lastSentTime = sentLog[symbol];
                if (currentTime - lastSentTime < 30 * 60 * 1000) {
                    console.log(`-> Bỏ qua ${symbol} vì đã gửi thông báo trong vòng 30 phút trước.`);
                    continue;
                }
            }

            console.log(`Đang phân tích chỉ số đột biến Volatility cho ${symbol}...`);
            const metrics = await getMarketMetrics(symbol, '15m');

            const x = metrics.x;
            const rsi15m = metrics.rsi20;
            const rangeVol20 = metrics.rangeVol20; 
            const change24h = coin.change24h;     

            console.log(`> ${symbol} | Hệ số x: ${x.toFixed(2)} | BĐ vùng 20 nến trước: ${rangeVol20.toFixed(2)}% | RSI 15m: ${rsi15m.toFixed(2)} | Tăng 24h: ${change24h.toFixed(2)}%`);

            // --- MAIN LOGIC BÁO LỆNH ---
            let signalType = null;

            // Điều kiện LONG: x > 4 VÀ biến động giá vùng 20 nến trước < 7% VÀ 5% < tăng 24h < 25%
            if (x > 4 && rangeVol20 < 7 && change24h > 5 && change24h < 25) {
                signalType = "Long";
            } 
            // Điều kiện SHORT: x > 4 VÀ rsi20 của 15m > 75 VÀ tăng giá 24h < 5%
            else if (x > 4 && rsi15m > 75 && change24h < 5) {
                signalType = "Short";
            }

            // Gửi tin nhắn nếu thỏa mãn
            if (signalType) {
                const lowerSymbol = symbol.toLowerCase
