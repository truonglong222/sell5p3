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

// Gộp chung 1 request: Lấy nến 15m tính cả EMA20 và biến động 6h từ 24 nến trước
async function getMarketMetrics15m(symbol, lastPrice) {
    try {
        await sleep(250); // Nghỉ 250ms tối ưu Rate Limit
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=100`;
        const response = await axios.get(url);
        
        if (response.data && response.data.code === '0' && response.data.data.length > 30) {
            const candles = response.data.data.reverse();
            
            // 1. Tính EMA20 của nến vừa đóng cửa (candles.length - 2)
            const closedIndex = candles.length - 2; 
            const historyPrices = candles.slice(0, closedIndex + 1).map(c => parseFloat(c[4]));
            const ema20 = calculateEMA(historyPrices, 20);

            // 2. Tính biến động 6h bằng chính mảng nến 15m (Lùi lại 24 cây nến)
            const targetIndex = candles.length - 25;
            const open6hAgo = parseFloat(candles[targetIndex][1]); // Giá mở cửa 24 nến trước
            
            const change6h = open6hAgo ? ((lastPrice - open6hAgo) / open6hAgo) * 100 : 0;

            return { ema20, change6h };
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

        // Lấy Top 25 tăng mạnh nhất và Top 25 giảm mạnh nhất từ Ticker
        let top25Gainers24h = [...tickers].sort((a, b) => b.change24h - a.change24h).slice(0, 25);
        let top25Losers24h = [...tickers].sort((a, b) => a.change24h - b.change24h).slice(0, 25);

        // Gom nhóm các coin cần check điều kiện vào một Map chung
        let finalPool = new Map();
        top25Gainers24h.forEach(coin => finalPool.set(coin.instId, { ...coin, type: 'gainer' }));
        top25Losers24h.forEach(coin => {
            if (!finalPool.has(coin.instId)) {
                finalPool.set(coin.instId, { ...coin, type: 'loser' });
            }
        });

        let hasNewAlert = false;

        // Duyệt kiểm tra điều kiện dung sai EMA20 và lọc biến động 6h bằng 24 nến 15m
        for (const [symbol, coin] of finalPool) {

            if (sentLog[symbol]) {
                if (currentTime - sentLog[symbol] < 30 * 60 * 1000) continue;
            }

            // Gọi API lấy dữ liệu nến 15m (Chỉ 1 request duy nhất cho cả 2 chỉ báo)
            const metrics = await getMarketMetrics15m(symbol, coin.lastPrice);
            if (!metrics) continue;

            const ema20 = metrics.ema20;
            const change6h = metrics.change6h;

            let signal = null;
            let reason = "";

            // --- MAIN LOGIC KIỂM TRA ĐIỀU KIỆN ---
            const isLongTolerance = checkTolerance(ema20, coin.lastPrice, -0.002, 0.01);
            const isShortTolerance = checkTolerance(ema20, coin.lastPrice, -0.01, 0.003);

            if (isLongTolerance) {
                if (change6h > 4 && change6h < 10) {
                    signal = "Long";
                    reason = `Sát EMA20 + Biến động 24 nến 15m tăng (${change6h.toFixed(1)}%)`;
                }
            } else if (isShortTolerance) {
                if (change6h > -10 && change6h < -4) {
                    signal = "Short";
                    reason = `Sát EMA20 + Biến động 24 nến 15m giảm (${change6h.toFixed(1)}%)`;
                }
            }

            // Gửi tin nhắn rút gọn nếu thỏa mãn toàn bộ hệ thống lọc
            if (signal) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const lowerSymbol = symbol.toLowerCase();
                const link = `https://www.okx.com/trade-swap/${lowerSymbol}`;
                const icon = signal === "Long" ? "🟢" : "🔴";

                const message = `${icon} <b>${signal.toUpperCase()} #${coinName}</b>\n` +
                                `• Giá: ${coin.lastPrice} (6h_15m: ${change6h >= 0 ? '+' : ''}${change6h.toFixed(2)}%)\n` +
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
