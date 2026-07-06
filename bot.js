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

// Hàm tính Bollinger Bands (Trả về Mid, Upper Band, Lower Band)
function calculateBollingerBands(prices, period = 20, stdDevMultiplier = 2) {
    if (prices.length < period) return { mid: 0, ub: 0, lb: 0 };
    
    const targetPrices = prices.slice(-period);
    const mid = targetPrices.reduce((sum, p) => sum + p, 0) / period;
    
    const variance = targetPrices.reduce((sum, p) => sum + Math.pow(p - mid, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    
    const ub = mid + stdDevMultiplier * stdDev;
    const lb = mid - stdDevMultiplier * stdDev;
    
    return { mid, ub, lb };
}

// Gọi API lấy dữ liệu nến của OKX và bóc tách EMA20, Bollinger Bands
async function getTechnicalIndicators(symbol, bar = '15m') {
    try {
        await sleep(250); // Nghỉ 250ms tối ưu Rate Limit
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=100`;
        const response = await axios.get(url);
        
        if (response.data && response.data.code === '0' && response.data.data.length > 25) {
            const candles = response.data.data.reverse();
            const closedIndex = candles.length - 2; // Nến vừa đóng cửa
            
            const historyPrices = candles.slice(0, closedIndex + 1).map(c => parseFloat(c[4]));
            
            const ema20 = calculateEMA(historyPrices, 20);
            const bb = calculateBollingerBands(historyPrices, 20, 2);
            
            return { ema20, ub: bb.ub, lb: bb.lb };
        }
        return null;
    } catch (error) {
        console.error(`Lỗi tính chỉ báo cho ${symbol}:`, error.message);
        return null;
    }
}

// Hàm kiểm tra dải dung sai bất đối xứng theo đúng tỷ lệ % yêu cầu
// pctMin và pctMax là giá trị thực tế (Ví dụ: -0.1% -> -0.001, +1% -> 0.01)
function checkTolerance(indicatorVal, price, pctMin, pctMax) {
    if (!indicatorVal || !price) return false;
    
    // Tính khoảng cách: Chỉ báo - Giá Coin
    const diffPct = (indicatorVal - price) / indicatorVal;
    
    // Kiểm tra xem khoảng cách có nằm trong phạm vi cho phép không
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
        console.log('Đang quét tín hiệu thị trường OKX...');
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

        // 1. Tạo danh sách Top Tăng (Sắp xếp giảm dần)
        let topGainers = [...tickers].sort((a, b) => b.change24h - a.change24h);
        
        // 2. Tạo danh sách Top Giảm (Sắp xếp tăng dần)
        let topLosers = [...tickers].sort((a, b) => a.change24h - b.change24h);

        // Gom danh sách các coin cần check: Top 3 Tăng và Top 3 Giảm
        let poolToCheck = new Map();
        
        topGainers.slice(0, 3).forEach((coin, idx) => {
            poolToCheck.set(coin.instId, { ...coin, type: 'gainer', rank: idx + 1 });
        });
        
        topLosers.slice(0, 3).forEach((coin, idx) => {
            if(!poolToCheck.has(coin.instId)) {
                poolToCheck.set(coin.instId, { ...coin, type: 'loser', rank: idx + 1 });
            }
        });

        let hasNewAlert = false;

        // Vòng lặp quét kiểm tra các chỉ báo kỹ thuật
        for (const [symbol, coin] of poolToCheck) {

            if (sentLog[symbol]) {
                if (currentTime - sentLog[symbol] < 30 * 60 * 1000) continue;
            }

            const indicators = await getTechnicalIndicators(symbol, '15m');
            if (!indicators) continue;

            let signal = null;
            let reason = "";

            // --- MAIN LOGIC KIỂM TRA ĐIỀU KIỆN DUNG SAI MỚI ---
            if (coin.type === 'gainer') {
                // LONG: Top 3 Tăng. Dung sai (Chỉ báo - Giá) là: [-0.1%, +1%] tương đương [-0.001, 0.01]
                if (checkTolerance(indicators.ema20, coin.lastPrice, -0.001, 0.01)) {
                    signal = "Long";
                    reason = `Top ${coin.rank} Tăng + Sát EMA20`;
                } else if (checkTolerance(indicators.lb, coin.lastPrice, -0.001, 0.01)) {
                    signal = "Long";
                    reason = `Top ${coin.rank} Tăng + Sát BB Lower`;
                }
            } else if (coin.type === 'loser') {
                // SHORT: Top 3 Giảm. Dung sai (Chỉ báo - Giá) là: [-1%, +0.1%] tương đương [-0.01, 0.001]
                if (checkTolerance(indicators.ema20, coin.lastPrice, -0.01, 0.001)) {
                    signal = "Short";
                    reason = `Top ${coin.rank} Giảm + Sát EMA20`;
                } else if (checkTolerance(indicators.ub, coin.lastPrice, -0.01, 0.001)) {
                    signal = "Short";
                    reason = `Top ${coin.rank} Giảm + Sát BB Upper`;
                }
            }

            // Gửi thông báo ngắn gọn về Telegram nếu khớp điều kiện
            if (signal) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const lowerSymbol = symbol.toLowerCase();
                const link = `https://www.okx.com/trade-swap/${lowerSymbol}`;
                const icon = signal === "Long" ? "🟢" : "🔴";

                const message = `${icon} <b>${signal.toUpperCase()} #${coinName}</b>\n` +
                                `• Giá: ${coin.lastPrice} (${coin.change24h >= 0 ? '+' : ''}${coin.change24h.toFixed(2)}%)\n` +
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
        console.log('Hoàn thành chu kỳ quét chỉ báo.');

    } catch (error) {
        console.error('Lỗi hệ thống hàm main:', error.message);
    }
}

// Khởi chạy chương trình
main();
