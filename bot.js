import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Cấu hình từ Biến môi trường (GitHub Secrets)
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const BASE_URL = 'https://www.okx.com';

// Định nghĩa __dirname cho ES Module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COOLDOWN_FILE = path.join(__dirname, 'cooldowns.json');
const COOLDOWN_TIME = 2 * 60 * 60 * 1000; // 2 giờ tính bằng miligiây

// Hàm tính EMA
function calculateEMA(prices, period) {
    if (prices.length < period) return null;
    let k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
}

// Hàm gửi tin nhắn Telegram
async function sendTelegram(message) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('Đã gửi thông báo đến Telegram.');
    } catch (error) {
        console.error('Lỗi gửi Telegram:', error.message);
    }
}

// Quản lý Cooldown (Đọc và ghi file để giữ trạng thái trên GitHub)
function loadCooldowns() {
    if (fs.existsSync(COOLDOWN_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8'));
        } catch (e) {
            return {};
        }
    }
    return {};
}

function saveCooldowns(cooldowns) {
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(cooldowns, null, 2));
}

async function main() {
    try {
        if (!BOT_TOKEN || !CHAT_ID) {
            console.error("Thiếu cấu hình BOT_TOKEN hoặc CHAT_ID trong Environment Variables.");
            return;
        }

        console.log('1. Đang lấy dữ liệu ticker từ OKX...');
        const tickersResponse = await axios.get(`${BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const tickers = tickersResponse.data.data;

        // Tính % giảm 24h và lọc các cặp có đuôi -USDT
        let usdtPairs = tickers
            .filter(t => t.instId.endsWith('-USDT'))
            .map(t => {
                const open24h = parseFloat(t.sod24h); // Giá mở cửa 24h trước
                const last = parseFloat(t.last);
                // % Thay đổi = ((Last - Open) / Open) * 100
                const change24h = open24h ? ((last - open24h) / open24h) * 100 : 0;
                return {
                    instId: t.instId,
                    last: last,
                    change24h: change24h
                };
            });

        // Lấy Top 20 giảm mạnh nhất 24h
        usdtPairs.sort((a, b) => a.change24h - b.change24h);
        const top20Losers = usdtPairs.slice(0, 20);

        console.log(`Tìm thấy 20 coin giảm mạnh nhất 24h. Đang kiểm tra khung 4h và 15m...`);
        
        let cooldowns = loadCooldowns();
        const now = Date.now();
        let alertMessages = [];

        for (const coin of top20Losers) {
            // Kiểm tra cooldown trước để tiết kiệm số lượng gọi API
            if (cooldowns[coin.instId] && (now - cooldowns[coin.instId] < COOLDOWN_TIME)) {
                console.log(`-> ${coin.instId} đang trong thời gian cooldown, bỏ qua.`);
                continue;
            }

            // 2. Lấy nến 4h để tính % giảm
            const bar4hResponse = await axios.get(`${BASE_URL}/api/v5/market/candles?instId=${coin.instId}&bar=4H&limit=2`);
            const candles4h = bar4hResponse.data.data;
            if (!candles4h || candles4h.length < 1) continue;

            const open4h = parseFloat(candles4h[0][1]); // Giá mở cửa nến 4h hiện tại
            const close4h = parseFloat(candles4h[0][4]); // Giá hiện tại (đóng cửa tạm thời)
            const change4h = ((close4h - open4h) / open4h) * 100;

            // 3. Lọc ra những coin giảm 4h lớn hơn 4% (tức là change4h < -4)
            if (change4h > -4) {
                continue; 
            }

            // 4. Lấy nến 15m để tính EMA20
            const bar15mResponse = await axios.get(`${BASE_URL}/api/v5/market/candles?instId=${coin.instId}&bar=15m&limit=50`);
            const candles15m = bar15mResponse.data.data;
            if (!candles15m || candles15m.length < 20) continue;

            // Mảng giá đóng cửa xếp từ cũ đến mới để tính EMA
            const closePrices15m = candles15m.map(c => parseFloat(c[4])).reverse();
            const ema20_15m = calculateEMA(closePrices15m, 20);
            const currentPrice = coin.last;

            if (!ema20_15m) continue;

            // 5. Kiểm tra điều kiện: (Giá - EMA20) / Giá * 100 > -1.5
            const conditionValue = ((currentPrice - ema20_15m) / currentPrice) * 100;

            if (conditionValue > -1.5) {
                // Thỏa mãn điều kiện gửi Telegram
                alertMessages.push(
                    `🚨 *Tín hiệu OKX Đạt Điều Kiện* 🚨\n\n` +
                    `• *Coin:* ${coin.instId.replace('-USDT', '')}\n` +
                    `• *Giá hiện tại:* ${currentPrice}\n` +
                    `• *Giảm 24h:* ${coin.change24h.toFixed(2)}%\n` +
                    `• *Giảm 4h:* ${change4h.toFixed(2)}%\n` +
                    `• *EMA20 (15m):* ${ema20_15m.toFixed(4)}\n` +
                    `• *Độ lệch điều kiện:* ${conditionValue.toFixed(2)}%`
                );
                // Cập nhật thời gian cooldown cho coin này
                cooldowns[coin.instId] = now;
            }
        }

        // 6. Xử lý gửi tin nhắn tổng hợp
        if (alertMessages.length > 0) {
            const finalMessage = alertMessages.join('\n\n------------------------\n\n');
            await sendTelegram(finalMessage);
            saveCooldowns(cooldowns); // Lưu lại trạng thái cooldown mới
        } else {
            console.log('Không có coin nào thỏa mãn tất cả các điều kiện trong chu kỳ này.');
        }

    } catch (error) {
        console.error('Đã xảy ra lỗi hệ thống:', error.message);
    }
}

main();
