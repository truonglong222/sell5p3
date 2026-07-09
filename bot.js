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

// Khung 1H: Trả về dữ liệu EMA20 1H và % tăng trưởng 24h (24 nến)
async function getMetrics1H(symbol, lastPrice) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=50`;
        const response = await axios.get(url, { timeout: 8000 });
        
        if (response.data && response.data.code === '0' && response.data.data.length > 25) {
            const candles = response.data.data.reverse();
            
            const closedIndex = candles.length - 2;
            const historyPrices = candles.slice(0, closedIndex + 1).map(c => parseFloat(c[4]));
            const ema20_1h = calculateEMA(historyPrices, 20);

            // Tính tăng trưởng dựa trên mốc 24 cây nến 1H trước đó
            const index24h = candles.length - 25;
            const open24hAgo = parseFloat(candles[index24h][1]);
            const change24h = open24hAgo ? ((lastPrice - open24hAgo) / open24hAgo) * 100 : 0;

            return { symbol, ema20_1h, change24h };
        }
        return null;
    } catch (error) {
        console.error(`Lỗi request 1H cho ${symbol}:`, error.message);
        return null;
    }
}

// Khung 15m: Trả về EMA20 15m, giá High/Low hiện tại và % giảm 6h (24 nến 15m)
async function getMetrics15m(symbol, lastPrice) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=50`;
        const response = await axios.get(url, { timeout: 8000 });
        
        if (response.data && response.data.code === '0' && response.data.data.length > 25) {
            const candles = response.data.data.reverse();
            
            const closedIndex = candles.length - 2;
            const historyPrices = candles.slice(0, closedIndex + 1).map(c => parseFloat(c[4]));
            const ema20_15m = calculateEMA(historyPrices, 20);

            const currentCandle = candles[candles.length - 1];
            const currentHigh = parseFloat(currentCandle[2]);
            const currentLow = parseFloat(currentCandle[3]);

            // --- SỬA ĐỔI: Tính giảm giá dựa trên mốc 24 cây nến 15m trước đó ---
            const index24n15m = candles.length - 25;
            const open6hAgo = parseFloat(candles[index24n15m][1]);
            const change24n15m = open6hAgo ? ((lastPrice - open6hAgo) / open6hAgo) * 100 : 0;

            return { symbol, ema20_15m, currentHigh15m: currentHigh, currentLow15m: currentLow, change24n15m };
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
        console.log('BƯỚC 1: Đang lấy dữ liệu tổng từ ticker OKX...');
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);

        if (!response.data || response.data.code !== '0') {
            console.error('Không thể lấy dữ liệu từ OKX');
            return;
        }

        const sentLog = loadSentLog();
        const currentTime = Date.now();

        // BƯỚC 2: Phân tách mảng nội bộ
        let tickers = response.data.data
            .filter(t => t.instId.endsWith('-USDT-SWAP'))
            .map(t => {
                const open24h = parseFloat(t.open24h);
                const lastPrice = parseFloat(t.last);
                const change24h = open24h ? ((lastPrice - open24h) / open24h) * 100 : 0;
                return { instId: t.instId, change24h, lastPrice };
            });

        // BƯỚC 3: Lấy Top 20 tăng mạnh nhất làm pool quét cốt lõi
        let top20Gainers = tickers.sort((a, b) => b.change24h - a.change24h).slice(0, 20);

        // BƯỚC 4: Lọc nhanh loại bỏ coin đang cooldown 2 giờ (Không tốn request)
        let eligibleCoins = top20Gainers.filter(coin => {
            return !(sentLog[coin.instId] && (currentTime - sentLog[coin.instId] < 2 * 60 * 60 * 1000));
        });

        if (eligibleCoins.length === 0) {
            console.log('Không có coin nào nằm ngoài thời gian Cooldown.');
            return;
        }

        // BƯỚC 5: TỐI ƯU SONG SONG KHUNG 1H & KHUNG 15M ĐỒNG THỜI
        console.log(`Đang quét song song dữ liệu chỉ báo cho ${eligibleCoins.length} coin...`);
        
        const promises1h = eligibleCoins.map(coin => getMetrics1H(coin.instId, coin.lastPrice));
        const promises15m = eligibleCoins.map(coin => getMetrics15m(coin.instId, coin.lastPrice));
        
        // Chạy đồng thời toàn bộ các luồng request dữ liệu
        const [results1h, results15m] = await Promise.all([
            Promise.all(promises1h),
            Promise.all(promises15m)
        ]);

        let hasNewAlert = false;

        // BƯỚC 6: DUYỆT VÒNG LẶP KIỂM TRA ĐIỀU KIỆN MIX THEO QUY TRÌNH MỚI
        for (const coin of eligibleCoins) {
            const data1h = results1h.find(r => r && r.symbol === coin.instId);
            const data15m = results15m.find(r => r && r.symbol === coin.instId);
            
            if (!data1h || !data15m) continue;

            let signal = null;
            let reason = "";

            // --- KIỂM TRA ĐIỀU KIỆN BIÊN ĐỘ VÀ DUNG SAI CHI TIẾT ---

            // Nhánh Lệnh LONG: Thỏa mãn 24 cây nến 1H > 10%
            if (data1h.change24h > 10) {
                // Check Long 15p: -0.2% < dung sai < +1%
                if (checkTolerance(data15m.ema20_15m, data15m.currentLow15m, -0.002, 0.01)) {
                    signal = "Long 15p";
                    reason = `Tăng 24h_1H (${data1h.change24h.toFixed(1)}%) + Râu 15m chạm EMA20_15m`;
                } 
                // Check Long 1h: -0.5% < dung sai < +1%
                else if (checkTolerance(data1h.ema20_1h, data15m.currentLow15m, -0.005, 0.01)) {
                    signal = "Long 1h";
                    reason = `Tăng 24h_1H (${data1h.change24h.toFixed(1)}%) + Râu 15m chạm EMA20_1H`;
                }
            }

            // Nhánh Lệnh SHORT: Thỏa mãn 24 cây nến 15m < -7%
            if (data15m.change24n15m < -7) {
                // Check Short 15p: +0.2% < dung sai < -1% (Tức là [-1%, 0.2%] trên trục số)
                if (checkTolerance(data15m.ema20_15m, data15m.currentHigh15m, -0.01, 0.002)) {
                    signal = "Short 15p";
                    reason = `Giảm 24n_15m (${data15m.change24n15m.toFixed(1)}%) + Râu 15m chạm EMA20_15m`;
                } 
                // Check Short 1h: +0.5% < dung sai < -1% (Tức là [-1%, 0.5%] trên trục số)
                else if (checkTolerance(data1h.ema20_1h, data15m.currentHigh15m, -0.01, 0.005)) {
                    signal = "Short 1h";
                    reason = `Giảm 24n_15m (${data15m.change24n15m.toFixed(1)}%) + Râu 15m chạm EMA20_1H`;
                }
            }

            // Tiến hành bắn tín hiệu về máy Telegram
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
