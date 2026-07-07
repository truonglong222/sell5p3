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

// Hàm lấy dữ liệu nến 15m để tính EMA20
async function getEMA20_15m(symbol) {
    try {
        await sleep(250);
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=100`;
        const response = await axios.get(url);
        
        if (response.data && response.data.code === '0' && response.data.data.length > 25) {
            const candles = response.data.data.reverse();
            const closedIndex = candles.length - 2; // Nến vừa đóng cửa
            const historyPrices = candles.slice(0, closedIndex + 1).map(c => parseFloat(c[4]));
            return calculateEMA(historyPrices, 20);
        }
        return 0;
    } catch (error) {
        console.error(`Lỗi tính EMA20 cho ${symbol}:`, error.message);
        return 0;
    }
}

// Lấy % thay đổi giá trong 6 giờ qua dựa trên nến 2H (so với giá mở cửa 3 cây nến trước)
async function getChange6h(symbol, lastPrice) {
    try {
        await sleep(250);
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=2H&limit=5`;
        const response = await axios.get(url);
        
        if (response.data && response.data.code === '0' && response.data.data.length >= 3) {
            const candles = response.data.data.reverse();
            // Giá mở cửa của nến [length-3] chính là mốc khởi đầu của chu kỳ 6 giờ trước tính đến hiện tại.
            const open6hAgo = parseFloat(candles[candles.length - 3][1]);
            return open6hAgo ? ((lastPrice - open6hAgo) / open6hAgo) * 100 : 0;
        }
        return 0;
    } catch (error) {
        console.error(`Lỗi lấy thay đổi 6h cho ${symbol}:`, error.message);
        return 0;
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

        // BƯỚC 1: Lọc ra Top 10 Tăng 24h và Top 10 Giảm 24h từ Ticker để làm pool kiểm tra ban đầu
        let top10Gainers24h = [...tickers].sort((a, b) => b.change24h - a.change24h).slice(0, 10);
        let top10Losers24h = [...tickers].sort((a, b) => a.change24h - b.change24h).slice(0, 10);

        // Gom nhóm các coin cần check điều kiện vào một Map chung
        let finalPool = new Map();
        top10Gainers24h.forEach(coin => finalPool.set(coin.instId, { ...coin, type: 'gainer' }));
        top10Losers24h.forEach(coin => {
            if (!finalPool.has(coin.instId)) {
                finalPool.set(coin.instId, { ...coin, type: 'loser' });
            }
        });

        let hasNewAlert = false;

        // BƯỚC 2: Quét kiểm tra điều kiện khoảng % 6h và dung sai EMA20 15m
        for (const [symbol, coin] of finalPool) {

            if (sentLog[symbol]) {
                if (currentTime - sentLog[symbol] < 30 * 60 * 1000) continue;
            }

            // Lấy % thay đổi giá trong 6h qua
            const change6h = await getChange6h(symbol, coin.lastPrice);

            // --- ĐIỀU KIỆN KHOẢNG PHẦN TRĂM 6H THEO CẤU HÌNH MỚI ---
            // Long Gainer Zone: 2% < change6h < 15%
            const isLongGainerZone = coin.type === 'gainer' && change6h > 2 && change6h < 15;
            // Short Loser Zone: -15% < change6h < -2%
            const isShortLoserZone = coin.type === 'loser' && change6h > -15 && change6h < -2;

            // Nếu không nằm trong dải % 6h của cả hai chiều thì bỏ qua luôn để tiết kiệm request
            if (!isLongGainerZone && !isShortLoserZone) continue;

            // Lấy chỉ báo EMA20 khung 15m
            const ema20 = await getEMA20_15m(symbol);
            if (!ema20) continue;

            let signal = null;
            let reason = "";

            // --- MAIN LOGIC DUNG SAI BẤT ĐỐI XỨNG THEO YÊU CẦU MỚI ---
            if (isLongGainerZone) {
                // LONG: Dung sai nằm trong khoảng -0.2% < diff < +1% -> [-0.002, 0.01]
                if (checkTolerance(ema20, coin.lastPrice, -0.002, 0.01)) {
                    signal = "Long";
                    reason = `6h Tăng (${change6h.toFixed(1)}%) + Sát EMA20 (-0.2%/+1%)`;
                }
            } else if (isShortLoserZone) {
                // SHORT: Dung sai nằm trong khoảng -1% < diff < +0.3% -> [-0.01, 0.003]
                if (checkTolerance(ema20, coin.lastPrice, -0.01, 0.003)) {
                    signal = "Short";
                    reason = `6h Giảm (${change6h.toFixed(1)}%) + Sát EMA20 (-1%/+0.3%)`;
                }
            }

            // Gửi tin nhắn rút gọn nếu thỏa mãn toàn bộ hệ thống lọc
            if (signal) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const lowerSymbol = symbol.toLowerCase();
                const link = `https://www.okx.com/trade-swap/${lowerSymbol}`;
                const icon = signal === "Long" ? "🟢" : "🔴";

                const message = `${icon} <b>${signal.toUpperCase()} #${coinName}</b>\n` +
                                `• Giá: ${coin.lastPrice} (6h: ${change6h >= 0 ? '+' : ''}${change6h.toFixed(2)}% | 24h: ${coin.change24h >= 0 ? '+' : ''}${coin.change24h.toFixed(2)}%)\n` +
                                `• Cản: ${reason}\n` +
                                `👉 <a href="${link}">Giao dịch ngay</a>`;

                await sendTelegramMessage(message);
                
                sentLog[symbol] = currentTime;
                hasNewAlert = true;
            }
        }

        if (hasNewAlert) {
            saveSentLog(sentLog);
        }
        console.log('Hoàn thành chu kỳ quét.');

    } catch (error) {
        console.error('Lỗi hệ thống hàm main:', error.message);
    }
}

// Thực thi chạy chương trình chính
main();
