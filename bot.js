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

// Dọn dẹp dữ liệu log cũ sau 1 giờ để đồng bộ với Cooldown 1h
function saveSentLog(logData) {
    try {
        const now = Date.now();
        const cleanedLog = {};
        for (const [coin, timestamp] of Object.entries(logData)) {
            if (now - timestamp < 1 * 60 * 60 * 1000) {
                cleanedLog[coin] = timestamp;
            }
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (error) {
        console.error('Lỗi khi ghi file json log:', error.message);
    }
}

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

// Khung 5m (limit 100): Tính EMA20, % giảm 30m (6 nến), hệ số a và b
async function getMarketMetrics5m(symbol, lastPrice) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=5m&limit=100`;
        const response = await axios.get(url, { timeout: 8000 });
        
        if (response.data && response.data.code === '0' && response.data.data.length > 25) {
            const candles = response.data.data.reverse();
            
            // 1. Tính EMA20 cho nến 5m vừa đóng cửa (candles.length - 2)
            const closedIndex = candles.length - 2;
            const historyPrices = candles.slice(0, closedIndex + 1).map(c => parseFloat(c[4]));
            const ema20_5m = calculateEMA(historyPrices, 20);

            // 2. Tính % biến động 30m (lùi ngược 6 cây nến 5m trước đó: 6 * 5m = 30m)
            const index30m = candles.length - 7;
            const open30mAgo = parseFloat(candles[index30m][1]);
            const change30m = open30mAgo ? ((lastPrice - open30mAgo) / open30mAgo) * 100 : 0;

            // 3. Lấy thông số giá High/Low của nến hiện tại đang chạy (candles.length - 1)
            const currentCandle = candles[candles.length - 1];
            const currentHigh = parseFloat(currentCandle[2]);
            const currentLow = parseFloat(currentCandle[3]);

            // 4. Tính toán hệ số a (Long Low) và hệ số b (Short High)
            const a = ema20_5m ? ((ema20_5m - currentLow) / ema20_5m) * 100 : 0;
            const b = ema20_5m ? ((ema20_5m - currentHigh) / ema20_5m) * 100 : 0;

            return { symbol, ema20_5m, change30m, a, b };
        }
        return null;
    } catch (error) {
        console.error(`Lỗi request dữ liệu 5m cho ${symbol}:`, error.message);
        return null;
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
        console.log('Đang quét dữ liệu tổng từ ticker OKX...');
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);

        if (!response.data || response.data.code !== '0') {
            console.error('Không thể lấy dữ liệu từ OKX');
            return;
        }

        const sentLog = loadSentLog();
        const currentTime = Date.now();

        // BƯỚC 2: Tính % thay đổi 24h từ ticker
        let tickers = response.data.data
            .filter(t => t.instId.endsWith('-USDT-SWAP'))
            .map(t => {
                const open24h = parseFloat(t.open24h);
                const lastPrice = parseFloat(t.last);
                const change24h = open24h ? ((lastPrice - open24h) / open24h) * 100 : 0;
                return { instId: t.instId, change24h, lastPrice };
            });

        // Sắp xếp danh sách 24h từ cao xuống thấp
        let sorted24hRank = [...tickers].sort((a, b) => b.change24h - a.change24h);

        // BƯỚC 3: --- THAY ĐỔI THEO YÊU CẦU MỚI: BÓC TÁCH TRỰC TIẾP TỪ THỨ HẠNG TIKER 24H ---
        // Lấy Top 10 tổng thể phục vụ đầu vào quét dữ liệu nến
        let top10Gainers24h = sorted24hRank.slice(0, 10);

        console.log(`Đang quét song song nến 5m cho toàn bộ ${top10Gainers24h.length} coin...`);
        const promises = top10Gainers24h.map(coin => getMarketMetrics5m(coin.instId, coin.lastPrice));
        const results = await Promise.all(promises);

        let validMetrics = results.filter(r => r !== null);

        // Gom nhóm tạm thời để phân phối tín hiệu
        let targetPool = new Map();

        // Duyệt toàn bộ Top 10 để phân loại nhóm theo đúng quy định mới
        top10Gainers24h.forEach((coin, index) => {
            const rank24h = index + 1; // Vị trí xếp hạng thực tế từ 1 đến 10
            const metrics = validMetrics.find(m => m.symbol === coin.instId);
            if (!metrics) return;

            let allowedSignal = 'none';

            // Chiều SHORT: Áp dụng cho TOÀN BỘ TOP 10 (từ rank 1 đến 10)
            if (metrics.change30m < -3) {
                allowedSignal = 'short';
            }

            // Chiều LONG: Chỉ áp dụng TRỰC TIẾP cho coin nằm trong khoảng từ Top 4 đến Top 10
            if (rank24h >= 4 && rank24h <= 10) {
                if (allowedSignal === 'short') {
                    allowedSignal = 'both'; // Nếu vừa giảm 30m > 3% vừa thuộc top 4-10
                } else {
                    allowedSignal = 'long';
                }
            }

            if (allowedSignal !== 'none') {
                targetPool.set(coin.instId, { 
                    ...metrics, 
                    allowedSignal, 
                    label: `TOP ${rank24h} 24h`, 
                    change24h: coin.change24h 
                });
            }
        });

        let hasNewAlert = false;

        // BƯỚC 4 & 5: SAU KHI CHỌN ĐƯỢC COIN MỚI LOẠI BỎ COOLDOWN VÀ CHECK DUNG SAI EMA
        for (const [symbol, coinMetrics] of targetPool) {
            
            // Chặn dính Cooldown 1 giờ ở cổng cuối cùng
            if (sentLog[symbol] && (currentTime - sentLog[symbol] < 1 * 60 * 60 * 1000)) {
                console.log(`-> Bỏ qua ${symbol} vì đang dính Cooldown.`);
                continue;
            }

            let signal = null;
            const a = coinMetrics.a;
            const b = coinMetrics.b;
            const mode = coinMetrics.allowedSignal;

            // Kiểm tra dải dung sai an toàn EMA20 5m
            // Nhánh xử lý LONG: -0.5% <= a <= 1%
            if ((mode === 'long' || mode === 'both') && (a >= -0.5 && a <= 1)) {
                signal = "Long 5p";
            }

            // Nhánh xử lý SHORT: -1% <= b <= 0.5%
            if ((mode === 'short' || mode === 'both') && (b >= -1 && b <= 0.5)) {
                signal = "Short 5p";
            }

            // Gửi tin nhắn về Telegram rút gọn chuẩn 1 dòng
            if (signal) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const lowerSymbol = symbol.toLowerCase();
                const link = `https://www.okx.com/trade-swap/${lowerSymbol}`;
                const icon = signal.startsWith("Long") ? "🟢" : "🔴";
                
                // Hiển thị phần trăm 24h cho đúng bản chất lọc trực tiếp từ ticker 24h
                const formattedPct = coinMetrics.change24h >= 0 ? `+${coinMetrics.change24h.toFixed(2)}%` : `${coinMetrics.change24h.toFixed(2)}%`;

                // Định dạng hiển thị mẫu: 🟢 LONG 5P #TON TOP 5 24h (+12.45%) 👉 Giao dịch ngay
                // Định dạng hiển thị mẫu: 🔴 SHORT 5P #LINK TOP 2 24h (+24.12%) 👉 Giao dịch ngay (Lúc này có thêm râu nến giảm 30m > 3%)
                const message = `${icon} <b>${signal.toUpperCase()} #${coinName} ${coinMetrics.label} (${formattedPct})</b> 👉 <a href="${link}">Giao dịch ngay</a>`;

                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML'
                }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

                sentLog[symbol] = currentTime;
                hasNewAlert = true;
            }
        }

        if (hasNewAlert) {
            saveSentLog(sentLog);
        }
        console.log('Hoàn thành chu kỳ quét siêu tốc cấu hình trực tiếp 24h.');

    } catch (error) {
        console.error('Lỗi hệ thống hàm main:', error.message);
    }
}

// Thực thi chạy chương trình chính
main();
