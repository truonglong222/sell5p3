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

// Hàm lấy % thay đổi giá trong 4 giờ qua (Dùng giá mở cửa của cây nến 4H hiện tại làm mốc)
async function getChange4h(symbol, lastPrice) {
    try {
        await sleep(250);
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=4H&limit=3`;
        const response = await axios.get(url);
        
        if (response.data && response.data.code === '0' && response.data.data.length > 0) {
            const candles = response.data.data.reverse();
            // candles[length-1] chính là cây nến 4H hiện tại đang chạy.
            // Lấy giá mở cửa của cây nến này để tính phần trăm thay đổi trong chu kỳ 4h hiện tại.
            const open4hAgo = parseFloat(candles[candles.length - 1][1]);
            return open4hAgo ? ((lastPrice - open4hAgo) / open4hAgo) * 100 : 0;
        }
        return 0;
    } catch (error) {
        console.error(`Lỗi lấy thay đổi 4h cho ${symbol}:`, error.message);
        return 0;
    }
}

// Hàm kiểm tra dải dung sai bất đối xứng theo đúng tỷ lệ % yêu cầu
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

        // BƯỚC 1: Lọc ra Top 10 Tăng 24h và Top 10 Giảm 24h
        let top10Gainers24h = [...tickers].sort((a, b) => b.change24h - a.change24h).slice(0, 10);
        let top10Losers24h = [...tickers].sort((a, b) => a.change24h - b.change24h).slice(0, 10);

        // BƯỚC 2: Tính toán % thay đổi giá 4h cho danh sách Top 10 Tăng 24h để lọc lấy Top 5 Tăng 4h
        console.log('Đang tính toán dữ liệu 4h cho Top 10 Tăng 24h...');
        let poolGainers4h = [];
        for (const coin of top10Gainers24h) {
            const change4h = await getChange4h(coin.instId, coin.lastPrice);
            poolGainers4h.push({ ...coin, change4h });
        }
        // Sắp xếp giảm dần theo tăng trưởng 4h và cắt lấy Top 5
        let top5Gainers4h = poolGainers4h.sort((a, b) => b.change4h - a.change4h).slice(0, 5);

        // BƯỚC 3: Tính toán % thay đổi giá 4h cho danh sách Top 10 Giảm 24h để lọc lấy Top 5 Giảm 4h
        console.log('Đang tính toán dữ liệu 4h cho Top 10 Giảm 24h...');
        let poolLosers4h = [];
        for (const coin of top10Losers24h) {
            const change4h = await getChange4h(coin.instId, coin.lastPrice);
            poolLosers4h.push({ ...coin, change4h });
        }
        // Sắp xếp tăng dần theo tăng trưởng 4h (âm nhất/giảm mạnh nhất lên đầu) và cắt lấy Top 5
        let top5Losers4h = poolLosers4h.sort((a, b) => a.change4h - b.change4h).slice(0, 5);

        // Gom 2 nhóm Top 5 lại để tiến hành check chỉ báo EMA20 15m
        let finalPool = new Map();
        top5Gainers4h.forEach((coin, idx) => finalPool.set(coin.instId, { ...coin, type: 'gainer', rank4h: idx + 1 }));
        top5Losers4h.forEach((coin, idx) => {
            if (!finalPool.has(coin.instId)) {
                finalPool.set(coin.instId, { ...coin, type: 'loser', rank4h: idx + 1 });
            }
        });

        let hasNewAlert = false;

        // BƯỚC 4: Quét kiểm tra điều kiện dung sai EMA20
        for (const [symbol, coin] of finalPool) {

            if (sentLog[symbol]) {
                if (currentTime - sentLog[symbol] < 30 * 60 * 1000) continue;
            }

            const ema20 = await getEMA20_15m(symbol);
            if (!ema20) continue;

            let signal = null;
            let reason = "";

            // --- MAIN LOGIC KIỂM TRA ĐIỀU KIỆN DUNG SAU CHO KHUNG 4H ---
            if (coin.type === 'gainer') {
                // LONG: Dung sai (EMA20 - Giá) nằm trong khoảng [-0.1%, +1%] -> [-0.001, 0.01]
                if (checkTolerance(ema20, coin.lastPrice, -0.001, 0.01)) {
                    signal = "Long";
                    reason = `Top ${coin.rank4h} Tăng 4H + Sát EMA20`;
                }
            } else if (coin.type === 'loser') {
                // SHORT: Dung sai (EMA20 - Giá) nằm trong khoảng [-1%, +0.1%] -> [-0.01, 0.001]
                if (checkTolerance(ema20, coin.lastPrice, -0.01, 0.001)) {
                    signal = "Short";
                    reason = `Top ${coin.rank4h} Giảm 4H + Sát EMA20`;
                }
            }

            // Gửi tin nhắn rút gọn siêu tốc nếu thỏa mãn
            if (signal) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const lowerSymbol = symbol.toLowerCase();
                const link = `https://www.okx.com/trade-swap/${lowerSymbol}`;
                const icon = signal === "Long" ? "🟢" : "🔴";

                const message = `${icon} <b>${signal.toUpperCase()} #${coinName}</b>\n` +
                                `• Giá: ${coin.lastPrice} (4h: ${coin.change4h >= 0 ? '+' : ''}${coin.change4h.toFixed(2)}% | 24h: ${coin.change24h >= 0 ? '+' : ''}${coin.change24h.toFixed(2)}%)\n` +
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
