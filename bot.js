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

// Khung 1H: Trả về dữ liệu kỹ thuật
async function getMetrics1H(symbol, lastPrice) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=100`;
        const response = await axios.get(url, { timeout: 8000 }); // Thêm timeout tránh treo request
        
        if (response.data && response.data.code === '0' && response.data.data.length > 55) {
            const candles = response.data.data.reverse();
            
            const closedIndex = candles.length - 2;
            const historyPrices = candles.slice(0, closedIndex + 1).map(c => parseFloat(c[4]));
            const ema20_1h = calculateEMA(historyPrices, 20);

            const index50h = candles.length - 51;
            const open50hAgo = parseFloat(candles[index50h][1]);
            const change50h = open50hAgo ? ((lastPrice - open50hAgo) / open50hAgo) * 100 : 0;

            const index8h = candles.length - 9;
            const open8hAgo = parseFloat(candles[index8h][1]);
            const change8h = open8hAgo ? ((lastPrice - open8hAgo) / open8hAgo) * 100 : 0;

            return { symbol, ema20_1h, change50h, change8h };
        }
        return null;
    } catch (error) {
        console.error(`Lỗi request 1H cho ${symbol}:`, error.message);
        return null;
    }
}

// Khung 15m: Trả về dữ liệu kỹ thuật
async function getMetrics15m(symbol) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=100`;
        const response = await axios.get(url, { timeout: 8000 });
        
        if (response.data && response.data.code === '0' && response.data.data.length > 25) {
            const candles = response.data.data.reverse();
            
            const closedIndex = candles.length - 2;
            const historyPrices = candles.slice(0, closedIndex + 1).map(c => parseFloat(c[4]));
            const ema20_15m = calculateEMA(historyPrices, 20);

            const currentCandle = candles[candles.length - 1];
            const currentHigh = parseFloat(currentCandle[2]);
            const currentLow = parseFloat(currentCandle[3]);

            return { symbol, ema20_15m, currentHigh15m: currentHigh, currentLow15m: currentLow };
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

        // BƯỚC 2: Tính % thay đổi nội bộ mảng
        let tickers = response.data.data
            .filter(t => t.instId.endsWith('-USDT-SWAP'))
            .map(t => {
                const open24h = parseFloat(t.open24h);
                const lastPrice = parseFloat(t.last);
                const change24h = open24h ? ((lastPrice - open24h) / open24h) * 100 : 0;
                return { instId: t.instId, change24h, lastPrice };
            });

        // BƯỚC 3: Lấy Top 20 tăng mạnh nhất
        let top20Gainers = tickers.sort((a, b) => b.change24h - a.change24h).slice(0, 20);

        // BƯỚC 4: Lọc nhanh danh sách vượt qua cổng Cooldown (Không tốn request)
        let eligibleCoins = top20Gainers.filter(coin => {
            return !(sentLog[coin.instId] && (currentTime - sentLog[coin.instId] < 2 * 60 * 60 * 1000));
        });

        if (eligibleCoins.length === 0) {
            console.log('Không có coin nào nằm ngoài thời gian Cooldown.');
            return;
        }

        // BƯỚC 5: TỐI ƯU SONG SONG KHUNG 1H - Gọi đồng thời toàn bộ danh sách coin
        console.log(`Đang quét song song dữ liệu 1H cho ${eligibleCoins.length} coin...`);
        const promises1h = eligibleCoins.map(coin => getMetrics1H(coin.instId, coin.lastPrice));
        const results1h = await Promise.all(promises1h);

        // Lọc các kết quả 1H hợp lệ và phân tích điều kiện
        let final1hData = results1h.filter(r => r !== null);
        let coinsNeed15m = [];

        for (const data of final1hData) {
            const coinTicker = eligibleCoins.find(c => c.instId === data.symbol);
            if (!coinTicker) continue;

            const isLongCondition = data.change50h > 20;
            const isShortCondition = data.change8h < -10;

            if (isLongCondition || isShortCondition) {
                coinsNeed15m.push({
                    ...coinTicker,
                    ema20_1h: data.ema20_1h,
                    change50h: data.change50h,
                    change8h: data.change8h,
                    isLongCondition,
                    isShortCondition
                });
            }
        }

        if (coinsNeed15m.length === 0) {
            console.log('Chu kỳ này không có cặp coin nào thỏa mãn điều kiện biên độ khung 1H.');
            return;
        }

        // BƯỚC 6: TỐI ƯU SONG SONG KHUNG 15M - Chỉ gọi cho những coin thỏa mãn khung 1H
        console.log(`Đang quét song song dữ liệu 15m cho ${coinsNeed15m.length} coin thỏa mãn...`);
        const promises15m = coinsNeed15m.map(coin => getMetrics15m(coin.instId));
        const results15m = await Promise.all(promises15m);

        const final15mData = results15m.filter(r => r !== null);
        let hasNewAlert = false;

        // BƯỚC 7: KIỂM TRA ĐIỀU KIỆN DUNG SAI VÀ BẮN TIN NHẮN TELEGRAM
        for (const coin of coinsNeed15m) {
            const data15m = final15mData.find(d => d.symbol === coin.instId);
            if (!data15m) continue;

            let signal = null;
            let reason = "";

            // Xử lý nhánh lệnh LONG
            if (coin.isLongCondition) {
                if (checkTolerance(data15m.ema20_15m, data15m.currentLow15m, -0.002, 0.01)) {
                    signal = "Long 15p";
                    reason = `Tăng 50h (${coin.change50h.toFixed(1)}%) + Râu 15m chạm EMA20_15m`;
                } else if (checkTolerance(coin.ema20_1h, data15m.currentLow15m, -0.005, 0.01)) {
                    signal = "Long 1h";
                    reason = `Tăng 50h (${coin.change50h.toFixed(1)}%) + Râu 15m chạm EMA20_1H`;
                }
            }

            // Xử lý nhánh lệnh SHORT
            if (coin.isShortCondition) {
                if (checkTolerance(data15m.ema20_15m, data15m.currentHigh15m, -0.01, 0.002)) {
                    signal = "Short 15p";
                    reason = `Giảm 8h (${coin.change8h.toFixed(1)}%) + Râu 15m chạm EMA20_15m`;
                } else if (checkTolerance(coin.ema20_1h, data15m.currentHigh15m, -0.01, 0.005)) {
                    signal = "Short 1h";
                    reason = `Giảm 8h (${coin.change8h.toFixed(1)}%) + Râu 15m chạm EMA20_1H`;
                }
            }

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
