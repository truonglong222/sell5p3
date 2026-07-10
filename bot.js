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

// Điều chỉnh dọn dẹp log cũ sau 30 phút để phù hợp với cooldown
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

// Khung 5m (limit 100): Tính toán EMA20, % biến động 4h (48 nến), hệ số a và b
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

            // 2. Tính % biến động 4h bằng cách lùi ngược lại đúng 48 cây nến 5m trước đó
            const index4h = candles.length - 49;
            const open4hAgo = parseFloat(candles[index4h][1]);
            const change4h = open4hAgo ? ((lastPrice - open4hAgo) / open4hAgo) * 100 : 0;

            // 3. Lấy thông số giá High/Low của nến hiện tại đang chạy (candles.length - 1)
            const currentCandle = candles[candles.length - 1];
            const currentHigh = parseFloat(currentCandle[2]);
            const currentLow = parseFloat(currentCandle[3]);

            // 4. Tính toán hệ số a (Long Low) và hệ số b (Short High)
            const a = ema20_5m ? ((ema20_5m - currentLow) / ema20_5m) * 100 : 0;
            const b = ema20_5m ? ((ema20_5m - currentHigh) / ema20_5m) * 100 : 0;

            return { symbol, ema20_5m, change4h, a, b };
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

        // BƯỚC 2: Tính % thay đổi 24h từ ticker (Xử lý mảng nội bộ)
        let tickers = response.data.data
            .filter(t => t.instId.endsWith('-USDT-SWAP'))
            .map(t => {
                const open24h = parseFloat(t.open24h);
                const lastPrice = parseFloat(t.last);
                const change24h = open24h ? ((lastPrice - open24h) / open24h) * 100 : 0;
                return { instId: t.instId, change24h, lastPrice };
            });

        // BƯỚC 3: Lấy Top 20 tăng mạnh nhất
        let top20Gainers = [...tickers].sort((a, b) => b.change24h - a.change24h).slice(0, 20);

        // BƯỚC 4: Loại coin đang cooldown 30 phút (Xử lý nhanh không tốn request)
        let eligibleCoins = top20Gainers.filter(coin => {
            return !(sentLog[coin.instId] && (currentTime - sentLog[coin.instId] < 30 * 60 * 1000));
        });

        if (eligibleCoins.length === 0) {
            console.log('Không có cặp coin nào vượt qua vòng lọc Cooldown.');
            return;
        }

        // BƯỚC 5: TỐI ƯU SONG SONG KHUNG 5M - Gọi đồng thời toàn bộ danh sách coin còn lại
        console.log(`Đang quét song song nến 5m cho ${eligibleCoins.length} coin hợp lệ...`);
        const promises = eligibleCoins.map(coin => getMarketMetrics5m(coin.instId, coin.lastPrice));
        const results = await Promise.all(promises);

        // Lọc bỏ các kết quả rỗng
        let validMetrics = results.filter(r => r !== null);

        // BƯỚC 6: Xếp hạng tìm ra Top 1, Top 2 tăng/giảm dựa trên biến động 4h (48 nến 5m)
        // Sắp xếp giảm dần để lấy Top 1 và Top 2 Tăng giá 4h
        let top2Gainers4h = [...validMetrics].sort((a, b) => b.change4h - a.change4h).slice(0, 2);
        // Sắp xếp tăng dần để lấy Top 1 và Top 2 Giảm giá 4h
        let top2Losers4h = [...validMetrics].sort((a, b) => a.change4h - b.change4h).slice(0, 2);

        // Gom nhóm 4 coin chiến lược này vào danh sách cuối cùng để đối chiếu bộ dung sai
        let finalSelection = new Map();
        top2Gainers4h.forEach((coin, idx) => finalSelection.set(coin.symbol, { ...coin, type: 'gainer', rank4h: idx + 1 }));
        top2Losers4h.forEach((coin, idx) => {
            if (!finalSelection.has(coin.symbol)) {
                finalSelection.set(coin.symbol, { ...coin, type: 'loser', rank4h: idx + 1 });
            }
        });

        let hasNewAlert = false;

        // BƯỚC 7: DUYỆT VÒNG LẶP KIỂM TRA ĐIỀU KIỆN HỆ SỐ TOÁN HỌC VÀ BẮN TELEGRAM
        for (const [symbol, coinMetrics] of finalSelection) {
            const coinTicker = eligibleCoins.find(c => c.instId === symbol);
            if (!coinTicker) continue;

            let signal = null;

            const a = coinMetrics.a;
            const b = coinMetrics.b;

            // --- KIỂM TRA ĐIỀU KIỆN CHỈ BÁO ---
            // Nhánh xử lý LONG: Thỏa mãn điều kiện -0.5% <= a <= 1%
            if (a >= -0.5 && a <= 1) {
                signal = "Long 5p";
            }

            // Nhánh xử lý SHORT: Thỏa mãn điều kiện -1% <= b <= 0.5%
            if (b >= -1 && b <= 0.5) {
                signal = "Short 5p";
            }

            // --- SỬA ĐỔI: ĐẨY THÔNG BÁO SIÊU RÚT GỌN CHỈ TRÊN 1 DÒNG ---
            if (signal) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const lowerSymbol = symbol.toLowerCase();
                const link = `https://www.okx.com/trade-swap/${lowerSymbol}`;
                const icon = signal.startsWith("Long") ? "🟢" : "🔴";
                
                // Chuẩn hóa chuỗi hiển thị dấu tăng (+) hoặc giảm (-) cho phần trăm 4h
                const formattedChange = coinMetrics.change4h >= 0 ? `+${coinMetrics.change4h.toFixed(2)}%` : `${coinMetrics.change4h.toFixed(2)}%`;

                // Định dạng chuẩn: 🟢 LONG 5P #BTC TOP 1 (+5.34%) 👉 Giao dịch ngay
                const message = `${icon} <b>${signal.toUpperCase()} #${coinName} TOP ${coinMetrics.rank4h} (${formattedChange})</b> 👉 <a href="${link}">Giao dịch ngay</a>`;

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
        console.log('Hoàn thành chu kỳ quét siêu tốc khung 5m.');

    } catch (error) {
        console.error('Lỗi hệ thống hàm main:', error.message);
    }
}

// Thực thi chạy chương trình chính
main();
