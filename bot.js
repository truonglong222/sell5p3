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

// Dọn dẹp log cũ sau 2 giờ để nhẹ file
function saveSentLog(logData) {
    try {
        const now = Date.now();
        const cleanedLog = {};
        for (const [coin, timestamp] of Object.entries(logData)) {
            if (now - timestamp < 2 * 60 * 60 * 1000) {
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

// Khung 15m (limit 100): Tính toán mảng EMA20 để bóc tách hệ số a, b, c
async function getMarketMetrics15m(symbol) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=100`;
        const response = await axios.get(url, { timeout: 8000 });
        
        if (response.data && response.data.code === '0' && response.data.data.length > 40) {
            const candles = response.data.data.reverse();
            
            // Xây dựng mảng lịch sử EMA20 chạy dọc theo chuỗi nến
            let emaHistory = [];
            let pricesForEma = [];
            
            for (let i = 0; i < candles.length; i++) {
                pricesForEma.push(parseFloat(candles[i][4])); // Giá đóng cửa
                if (pricesForEma.length >= 20) {
                    emaHistory.push(calculateEMA(pricesForEma, 20));
                } else {
                    emaHistory.push(0);
                }
            }

            // 1. Lấy EMA20 của nến hiện tại đang chạy (cuối mảng)
            const currentEma20 = emaHistory[emaHistory.length - 1];
            
            // 2. Lấy EMA20 của nến cách nến hiện tại 16 nến (lùi lại 16 vị trí)
            const pastEma20 = emaHistory[emaHistory.length - 17];

            // 3. Tính toán hệ số a (Biến động xu hướng % của EMA20)
            const a = pastEma20 ? ((currentEma20 - pastEma20) / pastEma20) * 100 : 0;

            // 4. Lấy thông số giá High/Low của nến hiện tại đang chạy
            const currentCandle = candles[candles.length - 1];
            const currentHigh = parseFloat(currentCandle[2]);
            const currentLow = parseFloat(currentCandle[3]);

            // 5. Tính b theo giá thấp nhất và c theo giá cao nhất
            const b = currentEma20 ? ((currentEma20 - currentLow) / currentEma20) * 100 : 0;
            const c = currentEma20 ? ((currentEma20 - currentHigh) / currentEma20) * 100 : 0;

            return { symbol, a, b, c };
        }
        return null;
    } catch (error) {
        console.error(`Lỗi request dữ liệu 15m cho ${symbol}:`, error.message);
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
        // BƯỚC 1: Lấy toàn bộ Futures USDT
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

        // BƯỚC 3: Lấy Top 10 tăng mạnh nhất và Top 20 giảm mạnh nhất
        let top10Gainers = [...tickers].sort((a, b) => b.change24h - a.change24h).slice(0, 10);
        let top20Losers = [...tickers].sort((a, b) => a.change24h - b.change24h).slice(0, 20);

        // Gom nhóm tổng thể
        let mergedPool = new Map();
        top10Gainers.forEach(coin => mergedPool.set(coin.instId, coin));
        top20Losers.forEach(coin => {
            if (!mergedPool.has(coin.instId)) {
                mergedPool.set(coin.instId, coin);
            }
        });

        // BƯỚC 4: Loại coin đang trong danh sách Cooldown 2 giờ
        let eligibleCoins = [];
        for (const [symbol, coin] of mergedPool) {
            if (sentLog[symbol] && (currentTime - sentLog[symbol] < 2 * 60 * 60 * 1000)) {
                continue;
            }
            eligibleCoins.push(coin);
        }

        if (eligibleCoins.length === 0) {
            console.log('Không có cặp coin nào vượt qua vòng lọc Cooldown.');
            return;
        }

        // BƯỚC 5: TỐI ƯU SONG SONG KHUNG 15M (Limit 100)
        console.log(`Đang quét song song nến 15m cho ${eligibleCoins.length} coin hợp lệ...`);
        const promises = eligibleCoins.map(coin => getMarketMetrics15m(coin.instId));
        const results = await Promise.all(promises);

        let hasNewAlert = false;

        // BƯỚC 6 & 7: KIỂM TRA ĐIỀU KIỆN TOÁN HỌC MỚI VÀ BẮN TELEGRAM
        for (const coin of eligibleCoins) {
            const metrics = results.find(r => r && r.symbol === coin.instId);
            if (!metrics) continue;

            let signal = null;
            let reason = "";

            const a = metrics.a;
            const b = metrics.b;
            const c = metrics.c;

            // --- MAIN LOGIC CHỈ BÁO THEO MỐC PHẦN TRĂM MỚI ---

            // Điều kiện SHORT sửa đổi: a < -3% VÀ 0.5% < c < -1% (Toán học: -1% <= c <= 0.5%)
            if (a < -3 && c >= -1 && c <= 0.5) {
                signal = "Short 15p";
                reason = `EMA xu hướng giảm (a = ${a.toFixed(1)}%) + Râu nến High quét qua EMA20`;
            }

            // Điều kiện LONG sửa đổi: a > 2% VÀ -0.5% < b < 1% (Toán học: -0.5% <= b <= 1%)
            if (a > 2 && b >= -0.5 && b <= 1) {
                signal = "Long 15p";
                reason = `EMA xu hướng tăng (a = +${a.toFixed(1)}%) + Râu nến Low quét qua EMA20`;
            }

            // Tiến hành đẩy thông báo về Telegram nếu thỏa mãn điều kiện
            if (signal) {
                const coinName = coin.instId.replace('-USDT-SWAP', '');
                const lowerSymbol = coin.instId.toLowerCase();
                const link = `https://www.okx.com/trade-swap/${lowerSymbol}`;
                const icon = signal.startsWith("Long") ? "🟢" : "🔴";

                const message = `${icon} <b>${signal.toUpperCase()} #${coinName}</b>\n` +
                                `• Giá hiện tại: ${coin.lastPrice}\n` +
                                `• Hệ số xu hướng a: ${a.toFixed(2)}%\n` +
                                `• Hệ số b (Long Low): ${b.toFixed(2)}%\n` +
                                `• Hệ số c (Short High): ${c.toFixed(2)}%\n` +
                                `• Chỉ báo: ${reason}\n` +
                                `👉 <a href="${link}">Giao dịch ngay</a>`;

                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML'
                }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

                sentLog[coin.instId] = currentTime;
                hasNewAlert = true;
            }
        }

        if (hasNewAlert) {
            saveSentLog(sentLog);
        }
        console.log('Hoàn thành chu kỳ quét siêu tốc.');

    } catch (error) {
        console.error('Lỗi hệ thống hàm main:', error.message);
    }
}

// Thực thi chạy chương trình chính
main();
