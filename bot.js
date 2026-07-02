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

// Gọi API lấy dữ liệu nến của OKX, trả về RSI và % thay đổi của nến hiện tại
async function getCandleData(symbol, bar) {
    try {
        // Nghỉ 250ms trước mỗi request để tối ưu Rate Limit của OKX
        await sleep(250); 
        // Lấy 70 nến để đảm bảo dữ liệu mượt và tính RSI-20 chuẩn xác nhất
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=70`;
        const response = await axios.get(url);
        
        if (response.data && response.data.code === '0' && response.data.data.length > 0) {
            // OKX trả về nến từ mới đến cũ, cần đảo ngược lại mảng để tính RSI theo thứ tự thời gian tăng dần
            const candles = response.data.data.reverse();
            const closePrices = candles.map(c => parseFloat(c[4])); // Giá đóng cửa nằm ở phần tử index số 4
            
            const rsi = calculateRSI(closePrices, 20); 

            // Tính % thay đổi của cây nến hiện tại (nến cuối cùng trong mảng sau khi reverse)
            const latestCandle = candles[candles.length - 1];
            const openPrice = parseFloat(latestCandle[1]); // Giá mở cửa index 1
            const closePrice = parseFloat(latestCandle[4]); // Giá đóng cửa index 4
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
        // Lấy toàn bộ Market Tickers của thị trường SWAP (Future vĩnh cửu)
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
                // Tính toán phần trăm tăng giảm giá dựa trên open24h và giá khớp lệnh cuối
                const change24h = open24h ? ((lastPrice - open24h) / open24h) * 100 : 0;
                return {
                    instId: t.instId, 
                    change24h: change24h,
                    lastPrice: lastPrice
                };
            });

        // Sắp xếp danh sách giảm dần theo tỷ lệ tăng trưởng phần trăm và cắt lấy top 10
        tickers.sort((a, b) => b.change24h - a.change24h);
        const top10Fastest = tickers.slice(0, 10);

        console.log('Top 10 coin tăng mạnh nhất 24h qua:');
        console.table(top10Fastest);

        let hasNewAlert = false;

        // Vòng lặp quét kiểm tra RSI đối với từng đồng coin trong danh sách top 10
        for (const coin of top10Fastest) {
            const symbol = coin.instId;

            // Kiểm tra bộ nhớ file chống trùng trong khoảng thời gian 30 phút
            if (sentLog[symbol]) {
                const lastSentTime = sentLog[symbol];
                if (currentTime - lastSentTime < 30 * 60 * 1000) {
                    console.log(`-> Bỏ qua ${symbol} vì đã gửi thông báo trong vòng 30 phút trước.`);
                    continue;
                }
            }

            console.log(`Đang kiểm tra dữ liệu cho ${symbol}...`);
            const data15m = await getCandleData(symbol, '15m');
            const data1h = await getCandleData(symbol, '1H');

            const rsi15m = data15m.rsi;
            const rsi1h = data1h.rsi;
            const change1h = data1h.candleChange; // % tăng trưởng của riêng cây nến 1h hiện tại

            console.log(`> ${symbol} | Nến 1h: ${change1h.toFixed(2)}% | RSI 15m (20): ${rsi15m.toFixed(2)}% | RSI 1h (20): ${rsi1h.toFixed(2)}%`);

            // --- ĐOẠN ĐỔI MAIN LOGIC THEO YÊU CẦU ---
            const condition1 = change1h > 10 && rsi15m > 85 && rsi1h > 80;
            const condition2 = change1h <= 10 && rsi15m > 80 && rsi1h > 80;

            if (condition1 || condition2) {
                
                // Định dạng chuỗi viết thường để chèn vào URL đích dạng: https://www.okx.com/trade-swap/act-usdt-swap
                const lowerSymbol = symbol.toLowerCase();
                const targetLink = `https://www.okx.com/trade-swap/${lowerSymbol}`;

                const message = `🚨 <b>BOT BÁO TÍN HIỆU CRYPTO</b> 🚨\n\n` +
                                `• <b>Coin:</b> #${symbol.replace('-SWAP', '')}\n` +
                                `• <b>Thay đổi nến 1h:</b> ${change1h >= 0 ? '+' : ''}${change1h.toFixed(2)}%\n` +
                                `• <b>Tăng 24h:</b> +${coin.change24h.toFixed(2)}%\n` +
                                `• <b>Giá hiện tại:</b> ${coin.lastPrice}\n` +
                                `• <b>RSI 20 (15m):</b> ${rsi15m.toFixed(2)}%\n` +
                                `• <b>RSI 20 (1h):</b> ${rsi1h.toFixed(2)}%\n\n` +
                                `👉 <a href="${targetLink}">Click để vào trực tiếp giao diện Future OKX</a>`;

                await sendTelegramMessage(message);
                
                // Đánh dấu thời gian đã gửi để phục vụ lần chạy tiếp theo
                sentLog[symbol] = currentTime;
                hasNewAlert = true;
            }
        }

        // Thực hiện lưu tệp JSON nếu có dữ liệu tín hiệu mới phát sinh
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
