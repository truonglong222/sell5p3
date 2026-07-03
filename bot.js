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

// Hàm trì hoãn (ngủ cơ học) để tránh bị sàn chặn lỗi 429 Too Many Requests
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

// Gọi API lấy dữ liệu nến của OKX, trả về RSI và % thay đổi của nến vừa đóng cửa
async function getCandleData(symbol, bar) {
    try {
        await sleep(250); // Nghỉ 250ms tối ưu Rate Limit
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=70`;
        const response = await axios.get(url);
        
        if (response.data && response.data.code === '0' && response.data.data.length > 0) {
            const candles = response.data.data.reverse();
            const closePrices = candles.map(c => parseFloat(c[4]));
            
            const rsi = calculateRSI(closePrices, 20); 

            // Lấy nến vừa đóng cửa (nến sát cuối cùng index length - 2) vì nến cuối cùng (length - 1) là nến đang chạy
            // Tuy nhiên nếu bạn muốn lấy cây nến hiện tại đang nhảy giá, đổi thành candles[candles.length - 1]
            const closedCandle = candles.length >= 2 ? candles[candles.length - 2] : candles[0];
            const openPrice = parseFloat(closedCandle[1]); // Giá mở cửa
            const closePrice = parseFloat(closedCandle[4]); // Giá đóng cửa
            const candleChange = openPrice ? ((closePrice - openPrice) / openPrice) * 100 : 0;

            return { rsi, candleChange };
        }
        return { rsi: 0, candleChange: 0 };
    } catch (error) {
        console.error(`Lỗi khi lấy dữ liệu (${bar}) cho ${symbol}:`, error.message);
        return { rsi: 0, candleChange: 0 };
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

        // --- ĐỔI THÀNH LẤY TOP 20 COIN TĂNG MẠNH NHẤT ---
        tickers.sort((a, b) => b.change24h - a.change24h);
        const top20Fastest = tickers.slice(0, 20);

        console.log('Top 20 coin tăng mạnh nhất 24h qua:');
        console.table(top20Fastest);

        let hasNewAlert = false;

        // Vòng lặp quét kiểm tra đối với từng đồng coin trong danh sách top 20
        for (const coin of top20Fastest) {
            const symbol = coin.instId;

            // Kiểm tra bộ nhớ file chống trùng trong khoảng thời gian 30 phút
            if (sentLog[symbol]) {
                const lastSentTime = sentLog[symbol];
                if (currentTime - lastSentTime < 30 * 60 * 1000) {
                    console.log(`-> Bỏ qua ${symbol} vì đã gửi thông báo trong vòng 30 phút trước.`);
                    continue;
                }
            }

            console.log(`Đang kiểm tra thông số kỹ thuật cho ${symbol}...`);
            
            // Lấy dữ liệu nến 15m (RSI và % tăng giá nến vừa đóng)
            const data15m = await getCandleData(symbol, '15m');
            // Lấy dữ liệu nến 4h
            const data4h = await getCandleData(symbol, '4H');

            const rsi15m = data15m.rsi;
            const change15m = data15m.candleChange; // % tăng giá nến 15m vừa đóng
            const change4h = data4h.candleChange;   // % tăng giá nến 4h vừa đóng
            const change24h = coin.change24h;       // % tăng giá 24h từ ticker

            console.log(`> ${symbol} | RSI 15m: ${rsi15m.toFixed(2)} | Nến 15m: ${change15m.toFixed(2)}% | Nến 4h: ${change4h.toFixed(2)}% | Tăng 24h: ${change24h.toFixed(2)}%`);

            // --- THIẾT LẬP MAIN LOGIC THEO YÊU CẦU MỚI ---
            let signalType = null; // Biến lưu loại tín hiệu: "Long" hoặc "Short"

            // Điều kiện SHORT: RSI20 của 15m > 90
            if (rsi15m > 90) {
                signalType = "Short";
            } 
            // Điều kiện LONG: nến 15m vừa đóng > 5% VÀ nến 4h < 10% VÀ 10% < tăng 24h < 25%
            else if (change15m > 5 && change4h < 10 && change24h > 10 && change24h < 25) {
                signalType = "Long";
            }

            // Nếu thỏa mãn 1 trong 2 điều kiện trên thì tiến hành gửi Telegram
            if (signalType) {
                
                const lowerSymbol = symbol.toLowerCase();
                const targetLink = `https://www.okx.com/trade-swap/${lowerSymbol}`;

                // Chọn icon và màu sắc hiển thị tương ứng với loại lệnh
                const alertIcon = signalType === "Long" ? "🟢 [LONG ALERT]" : "🔴 [SHORT ALERT]";

                const message = `${alertIcon} <b>TÍN HIỆU CHIẾN LƯỢC MỚI</b>\n\n` +
                                `• <b>Coin:</b> #${symbol.replace('-SWAP', '')}\n` +
                                `• <b>Khuyến nghị:</b> <b>${signalType.toUpperCase()}</b>\n` +
                                `• <b>Giá hiện tại:</b> ${coin.lastPrice}\n` +
                                `• <b>RSI 20 (15m):</b> ${rsi15m.toFixed(2)}%\n` +
                                `• <b>Tăng nến 15m vừa đóng:</b> ${change15m.toFixed(2)}%\n` +
                                `• <b>Tăng nến 4h vừa đóng:</b> ${change4h.toFixed(2)}%\n` +
                                `• <b>Tăng trưởng 24h:</b> ${change24h.toFixed(2)}%\n\n` +
                                `👉 <a href="${targetLink}">Click để vào trực tiếp giao diện Future OKX</a>`;

                await sendTelegramMessage(message);
                
                // Đánh dấu thời gian đã gửi để chống spam
                sentLog[symbol] = currentTime;
                hasNewAlert = true;
            }
        }

        if (hasNewAlert) {
            saveSentLog(sentLog);
        }
        console.log('Hoàn thành chu kỳ kiểm tra.');

    } catch (error) {
        console.error('Lỗi hệ thống trong hàm main:', error.message);
    }
}

// Thực thi chạy chương trình chính
main();
