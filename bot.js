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

// Khung 15m (gộp limit 50): Tính toán EMA20, High/Low hiện tại và biến động 4h (16 nến)
async function getMetrics15m(symbol, lastPrice) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=50`;
        const response = await axios.get(url, { timeout: 8000 });
        
        if (response.data && response.data.code === '0' && response.data.data.length > 20) {
            const candles = response.data.data.reverse();
            
            // 1. Tính EMA20 cho nến 15m vừa đóng cửa (candles.length - 2)
            const closedIndex = candles.length - 2;
            const historyPrices = candles.slice(0, closedIndex + 1).map(c => parseFloat(c[4]));
            const ema20_15m = calculateEMA(historyPrices, 20);

            // 2. Lấy High/Low của nến hiện tại đang chạy (candles.length - 1)
            const currentCandle = candles[candles.length - 1];
            const currentHigh = parseFloat(currentCandle[2]);
            const currentLow = parseFloat(currentCandle[3]);

            // 3. Tính % biến động 4h bằng cách lùi ngược lại đúng 16 cây nến 15m trước đó
            const index4h = candles.length - 17;
            const open4hAgo = parseFloat(candles[index4h][1]);
            const change4h = open4hAgo ? ((lastPrice - open4hAgo) / open4hAgo) * 100 : 0;

            return { symbol, ema20_15m, currentHigh15m: currentHigh, currentLow15m: currentLow, change4h };
        }
        return null;
    } catch (error) {
        console.error(`Lỗi request 15m cho ${symbol}:`, error.message);
        return null;
    }
}

// Hàm kiểm tra dải dung sai bất đối xứng theo cấu trúc: (EMA20 - Giá Mục Tiêu) / EMA20
function checkTolerance(indicatorVal, testPrice, pctMin, pctMax) {
    if (!indicatorVal || !testPrice) return false;
    const diffPct = (indicatorVal - testPrice) / indicatorVal;
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
        // BƯỚC 1: Lấy toàn bộ Futures USDT (1 request duy nhất)
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

        // BƯỚC 3: SỬA ĐỔI -> Lấy chuẩn danh sách Top 10 tăng mạnh nhất và Top 20 giảm mạnh nhất
        let top10Gainers = [...tickers].sort((a, b) => b.change24h - a.change24h).slice(0, 10);
        let top20Losers = [...tickers].sort((a, b) => a.change24h - b.change24h).slice(0, 20);

        // Gom nhóm tổng thể để chạy vòng lọc chung
        let mergedPool = new Map();
        top10Gainers.forEach(coin => mergedPool.set(coin.instId, { ...coin, poolType: 'long' }));
        top20Losers.forEach(coin => {
            if (!mergedPool.has(coin.instId)) {
                mergedPool.set(coin.instId, { ...coin, poolType: 'short' });
            }
        });

        // BƯỚC 4: Loại coin đang trong danh sách Cooldown 2 giờ (Xử lý nhanh nội bộ)
        let eligibleCoins = [];
        for (const [symbol, coin] of mergedPool) {
            if (sentLog[symbol] && (currentTime - sentLog[symbol] < 2 * 60 * 60 * 1000)) {
                console.log(`-> Bỏ qua ${symbol} vì đang trong thời gian cooldown 2 giờ.`);
                continue;
            }
            eligibleCoins.push(coin);
        }

        if (eligibleCoins.length === 0) {
            console.log('Không có cặp coin nào vượt qua vòng lọc Cooldown.');
            return;
        }

        // BƯỚC 5: TỐI ƯU SONG SONG KHUNG 15M (Gọi đồng thời tất cả các coin bằng Promise.all)
        console.log(`Đang quét song song nến 15m cho ${eligibleCoins.length} coin hợp lệ...`);
        const promises = eligibleCoins.map(coin => getMetrics15m(coin.instId, coin.lastPrice));
        const results = await Promise.all(promises);

        let hasNewAlert = false;

        // BƯỚC 6 & 7: TÍNH TOÁN CHỈ BÁO VÀ KIỂM TRA ĐIỀU KIỆN MIX
        for (const coin of eligibleCoins) {
            const metrics = results.find(r => r && r.symbol === coin.instId);
            if (!metrics) continue;

            let signal = null;
            let reason = "";

            // --- MAIN LOGIC THỎA MÃN HỆ THỐNG ---

            // Nhánh xử lý Lệnh LONG (Phát triển từ Top 10 Tăng)
            if (coin.poolType === 'long' && metrics.change4h > 5) {
                // Check dung sai râu nến: -0.2% < (ema20 - low) / ema20 < +1% -> [-0.002, 0.01]
                if (checkTolerance(metrics.ema20_15m, metrics.currentLow15m, -0.002, 0.01)) {
                    signal = "Long 15p";
                    reason = `4h Tăng (${metrics.change4h.toFixed(1)}%) + Râu 15m chạm EMA20`;
                }
            }

            // Nhánh xử lý Lệnh SHORT (Phát triển từ Top 20 Giảm)
            if (coin.poolType === 'short' && metrics.change4h < -5) {
                // Check dung sai râu nến: +0.2% < (ema20 - high) / ema20 < -1% -> [-0.01, 0.002] trên trục số
                if (checkTolerance(metrics.ema20_15m, metrics.currentHigh15m, -0.01, 0.002)) {
                    signal = "Short 15p";
                    reason = `4h Giảm (${metrics.change4h.toFixed(1)}%) + Râu 15m chạm EMA20`;
                }
            }

            // Bắn tín hiệu về máy nếu đầy đủ các điều kiện
            if (signal) {
                const coinName = coin.instId.replace('-USDT-SWAP', '');
                const lowerSymbol = coin.instId.toLowerCase();
                const link = `https://www.okx.com/trade-swap/${lowerSymbol}`;
                const icon = signal.startsWith("Long") ? "🟢" : "🔴";

                const message = `${icon} <b>${signal.toUpperCase()} #${coinName}</b>\n` +
                                `• Giá hiện tại: ${coin.lastPrice}\n` +
                                `• Chỉ báo: ${reason}\n` +
                                `👉 <a href="${link}">Giao dịch ngay</a>`;

                await sendTelegramMessage(message);
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
