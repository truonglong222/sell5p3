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

// Khung 5m (limit 100): Tính EMA20, % tăng 4h (48 nến), % giảm 30m (6 nến), hệ số a và b
async function getMarketMetrics5m(symbol, lastPrice) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=5m&limit=100`;
        const response = await axios.get(url, { timeout: 8000 });
        
        if (response.data && response.data.code === '0' && response.data.data.length > 55) {
            const candles = response.data.data.reverse();
            
            // 1. Tính EMA20 cho nến 5m vừa đóng cửa (candles.length - 2)
            const closedIndex = candles.length - 2;
            const historyPrices = candles.slice(0, closedIndex + 1).map(c => parseFloat(c[4]));
            const ema20_5m = calculateEMA(historyPrices, 20);

            // 2. Tính % biến động 4h (lùi ngược 48 cây nến 5m trước đó)
            const index4h = candles.length - 49;
            const open4hAgo = parseFloat(candles[index4h][1]);
            const change4h = open4hAgo ? ((lastPrice - open4hAgo) / open4hAgo) * 100 : 0;

            // 3. --- SỬA ĐỔI: Tính % biến động 30m (lùi ngược 6 cây nến 5m trước đó: 6 * 5m = 30m) ---
            const index30m = candles.length - 7;
            const open30mAgo = parseFloat(candles[index30m][1]);
            const change30m = open30mAgo ? ((lastPrice - open30mAgo) / open30mAgo) * 100 : 0;

            // 4. Lấy thông số giá High/Low của nến hiện tại đang chạy (candles.length - 1)
            const currentCandle = candles[candles.length - 1];
            const currentHigh = parseFloat(currentCandle[2]);
            const currentLow = parseFloat(currentCandle[3]);

            // 5. Tính toán hệ số a (Long Low) và hệ số b (Short High)
            const a = ema20_5m ? ((ema20_5m - currentLow) / ema20_5m) * 100 : 0;
            const b = ema20_5m ? ((ema20_5m - currentHigh) / ema20_5m) * 100 : 0;

            return { symbol, ema20_5m, change4h, change30m, a, b };
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

        // BƯỚC 3: Lấy Top 20 tăng mạnh nhất 24h từ sàn
        let top20Gainers = [...tickers].sort((a, b) => b.change24h - a.change24h).slice(0, 20);

        // --- QUY TRÌNH SỬA ĐỔI: Gọi nến 5m cho TOÀN BỘ Top 20 trước khi lọc cooldown ---
        console.log(`Đang quét song song nến 5m cho toàn bộ ${top20Gainers.length} coin từ Pool...`);
        const promises = top20Gainers.map(coin => getMarketMetrics5m(coin.instId, coin.lastPrice));
        const results = await Promise.all(promises);

        let validMetrics = results.filter(r => r !== null);

        // BƯỚC 4: Phân tích kỹ thuật lọc theo điều kiện Tăng 4h và Giảm 30m
        // 4.1. Lấy chuẩn Top 3 tăng mạnh nhất trong 4h
        let top3Gainers4h = [...validMetrics].sort((a, b) => b.change4h - a.change4h).slice(0, 3);
        
        // 4.2. Lọc toàn bộ coin có mức giảm trong 30 phút nhiều hơn 3% (change30m < -3)
        let losersMoreThan3Pct30m = validMetrics.filter(coin => coin.change30m < -3);

        // Gom nhóm tạm thời các cặp coin thỏa mãn tín hiệu thị trường
        let targetPool = new Map();
        
        top3Gainers4h.forEach((coin, idx) => {
            targetPool.set(coin.symbol, { ...coin, allowedSignal: 'long', label: `TOP ${idx + 1}`, displayPct: coin.change4h });
        });
        
        losersMoreThan3Pct30m.forEach((coin) => {
            if (!targetPool.has(coin.symbol)) {
                targetPool.set(coin.symbol, { ...coin, allowedSignal: 'short', label: 'GIẢM 30m >3%', displayPct: coin.change30m });
            } else {
                targetPool.get(coin.symbol).allowedSignal = 'both';
            }
        });

        let hasNewAlert = false;

        // BƯỚC 5 & 6: KIỂM TRA COOLDOWN VÀ ĐỐI CHIẾU DUNG SAI KỸ THUẬT
        for (const [symbol, coinMetrics] of targetPool) {
            
            // --- THAY ĐỔI VỊ TRÍ: Sau khi chọn được coin thỏa mãn mới loại bỏ coin dính countdown 1h ---
            if (sentLog[symbol] && (currentTime - sentLog[symbol] < 1 * 60 * 60 * 1000)) {
                console.log(`-> Loại bỏ ${symbol} ở bước cuối cùng vì đang dính Cooldown 1 giờ.`);
                continue;
            }

            const coinTicker = top20Gainers.find(c => c.instId === symbol);
            if (!coinTicker) continue;

            let signal = null;
            const a = coinMetrics.a;
            const b = coinMetrics.b;
            const mode = coinMetrics.allowedSignal;

            // Kiểm tra dung sai
            // Nhánh xử lý LONG: -0.5% <= a <= 1%
            if ((mode === 'long' || mode === 'both') && (a >= -0.5 && a <= 1)) {
                signal = "Long 5p";
            }

            // Nhánh xử lý SHORT: -1% <= b <= 0.5%
            if ((mode === 'short' || mode === 'both') && (b >= -1 && b <= 0.5)) {
                signal = "Short 5p";
            }

            // Gửi tin nhắn Telegram rút gọn 1 dòng duy nhất
            if (signal) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const lowerSymbol = symbol.toLowerCase();
                const link = `https://www.okx.com/trade-swap/${lowerSymbol}`;
                const icon = signal.startsWith("Long") ? "🟢" : "🔴";
                
                const formattedPct = coinMetrics.displayPct >= 0 ? `+${coinMetrics.displayPct.toFixed(2)}%` : `${coinMetrics.displayPct.toFixed(2)}%`;

                // Bản tin chuẩn dòng: 🟢 LONG 5P #BTC TOP 1 (+4.12%) 👉 Giao dịch ngay
                // Bản tin chuẩn dòng: 🔴 SHORT 5P #AVAX GIẢM 30m >3% (-3.54%) 👉 Giao dịch ngay
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
        console.log('Hoàn thành chu kỳ quét tối ưu quy trình.');

    } catch (error) {
        console.error('Lỗi hệ thống hàm main:', error.message);
    }
}

// Thực thi chạy chương trình chính
main();
