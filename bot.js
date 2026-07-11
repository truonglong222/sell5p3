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

// Lấy giá mở cửa lúc 7h sáng (00:00 UTC) từ nến ngày 1D
async function getOpenPriceSince7AM(symbol) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1D&limit=2`;
        const response = await axios.get(url, { timeout: 5000 });
        if (response.data && response.data.code === '0' && response.data.data.length > 0) {
            return parseFloat(response.data.data[0][1]); // Giá mở cửa nến 1D
        }
        return null;
    } catch (error) {
        return null;
    }
}

// Khung 5m (limit 100): Tính EMA20, hệ số a và b phục vụ dải dung sai
async function getMarketMetrics5m(symbol) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=5m&limit=100`;
        const response = await axios.get(url, { timeout: 8000 });
        
        if (response.data && response.data.code === '0' && response.data.data.length > 25) {
            const candles = response.data.data.reverse();
            
            // 1. Tính EMA20 cho nến 5m vừa đóng cửa (candles.length - 2)
            const closedIndex = candles.length - 2;
            const historyPrices = candles.slice(0, closedIndex + 1).map(c => parseFloat(c[4]));
            const ema20_5m = calculateEMA(historyPrices, 20);

            // 2. Lấy thông số giá High/Low của nến hiện tại đang chạy (candles.length - 1)
            const currentCandle = candles[candles.length - 1];
            const currentHigh = parseFloat(currentCandle[2]);
            const currentLow = parseFloat(currentCandle[3]);

            // 3. Tính toán hệ số a (Long Low) và hệ số b (Short High)
            const a = ema20_5m ? ((ema20_5m - currentLow) / ema20_5m) * 100 : 0;
            const b = ema20_5m ? ((ema20_5m - currentHigh) / ema20_5m) * 100 : 0;

            return { symbol, ema20_5m, a, b };
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

        // Lọc danh sách USDT-SWAP ban đầu
        let rawFutures = response.data.data.filter(t => t.instId.endsWith('-USDT-SWAP'));

        // BƯỚC 2: Tính toán song song % tăng trưởng kể từ 7H SÁNG của TOÀN BỘ coin
        console.log(`Đang quét giá mở cửa 7h sáng cho ${rawFutures.length} cặp coin...`);
        const openPricePromises = rawFutures.map(async (t) => {
            const open7AM = await getOpenPriceSince7AM(t.instId);
            const lastPrice = parseFloat(t.last);
            const changeSince7AM = open7AM ? ((lastPrice - open7AM) / open7AM) * 100 : -999;
            return { instId: t.instId, changeSince7AM, lastPrice };
        });

        const tickersWith7AM = (await Promise.all(openPricePromises)).filter(c => c.changeSince7AM !== -999);

        // BƯỚC 3: SẮP XẾP BÓC TÁCH TOP TĂNG VÀ TOP GIẢM TỪ 7H SÁNG
        // 3.1 Lọc Top 5 TĂNG mạnh nhất kể từ 7h sáng (Chiều LONG)
        let top5Gainers = [...tickersWith7AM].sort((a, b) => b.changeSince7AM - a.changeSince7AM).slice(0, 5);
        
        // 3.2 Lọc Top 5 GIẢM mạnh nhất kể từ 7h sáng (Chiều SHORT)
        let top5Losers = [...tickersWith7AM].sort((a, b) => a.changeSince7AM - b.changeSince7AM).slice(0, 5);

        // Gom nhóm tổng Pool cần check kỹ thuật (Dùng Map chặn trùng lặp coin nếu có biến động bất thường)
        let mergedPool = new Map();
        
        top5Gainers.forEach((coin, index) => {
            mergedPool.set(coin.instId, { ...coin, allowedSignal: 'long', rankLabel: `TOP ${index + 1} TĂNG` });
        });
        
        top5Losers.forEach((coin, index) => {
            if (!mergedPool.has(coin.instId)) {
                mergedPool.set(coin.instId, { ...coin, allowedSignal: 'short', rankLabel: `TOP ${index + 1} GIẢM` });
            } else {
                mergedPool.get(coin.instId).allowedSignal = 'both'; // Hy hữu coin vừa thuộc top gainer vừa top loser
            }
        });

        if (mergedPool.size === 0) return;

        // BƯỚC 4: TỐI ƯU SONG SONG KHUNG 5M CHO TẤT CẢ COIN ĐÃ LỌC ĐƯỢC
        console.log(`Đang quét song song nến 5m cho ${mergedPool.size} coin chiến lược...`);
        const promises = Array.from(mergedPool.keys()).map(symbol => getMarketMetrics5m(symbol));
        const results = await Promise.all(promises);

        let hasNewAlert = false;

        // BƯỚC 5 & 6: DUYỆT VÒNG LẶP CHECK DUNG SAI KỸ THUẬT VÀ LỌC COOLDOWN SAU CÙNG
        for (const [symbol, coinData] of mergedPool) {
            
            // THỨ TỰ: Chỉ loại bỏ coin dính Cooldown 1 giờ khi nó đã vượt qua vòng xếp hạng thành công
            if (sentLog[symbol] && (currentTime - sentLog[symbol] < 1 * 60 * 60 * 1000)) {
                continue;
            }

            const metrics = results.find(r => r && r.symbol === symbol);
            if (!metrics) continue;

            let signal = null;
            const a = metrics.a;
            const b = metrics.b;
            const mode = coinData.allowedSignal;

            // Kiểm tra bộ lọc dung sai EMA20 5m như cũ
            // Nhánh xử lý LONG: -0.5% <= a <= 1%
            if ((mode === 'long' || mode === 'both') && (a >= -0.5 && a <= 1)) {
                signal = "Long 5p";
            }

            // Nhánh xử lý SHORT: -1% <= b <= 0.5%
            if ((mode === 'short' || mode === 'both') && (b >= -1 && b <= 0.5)) {
                signal = "Short 5p";
            }

            // GỬI TIN NHẮN TELEGRAM SIÊU RÚT GỌN 1 DÒNG CHUẨN XU HƯỚNG
            if (signal) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const lowerSymbol = symbol.toLowerCase();
                const link = `https://www.okx.com/trade-swap/${lowerSymbol}`;
                const icon = signal.startsWith("Long") ? "🟢" : "🔴";
                
                const formattedPct = coinData.changeSince7AM >= 0 ? `+${coinData.changeSince7AM.toFixed(2)}%` : `${coinData.changeSince7AM.toFixed(2)}%`;

                // Định dạng hiển thị: 🟢 LONG 5P #BTC TOP 1 TĂNG (+4.12%) 👉 Giao dịch ngay
                // Định dạng hiển thị: 🔴 SHORT 5P #SOL TOP 3 GIẢM (-3.85%) 👉 Giao dịch ngay
                const message = `${icon} <b>${signal.toUpperCase()} #${coinName} ${coinData.rankLabel} (${formattedPct})</b> 👉 <a href="${link}">Giao dịch ngay</a>`;

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
        console.log('Hoàn thành chu kỳ quét siêu tốc theo cấu trúc Long/Short mốc 7h sáng.');

    } catch (error) {
        console.error('Lỗi hệ thống hàm main:', error.message);
    }
}

// Thực thi chạy chương trình chính
main();
