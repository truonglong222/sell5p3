import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;
const OKX_BASE_URL = 'https://www.okx.com';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'sent_ema.json');
const STATE_TOP3_FILE = path.join(__dirname, 'statetop3_8h.json');

// Khóa chống lặp lại tin nhắn trùng coin trong vòng 4 giờ
const COOLDOWN_TIME = 4 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadSentLog() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            return data.trim() ? JSON.parse(data) : {};
        }
    } catch (e) {}
    return {};
}

function saveSentLog(logData) {
    try {
        const now = Date.now();
        const cleanedLog = {};
        for (const [coin, timeData] of Object.entries(logData)) {
            const temp = {};
            if (timeData._long && now - timeData._long < COOLDOWN_TIME) temp._long = timeData._long;
            if (timeData._short && now - timeData._short < COOLDOWN_TIME) temp._short = timeData._short;
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

// Hàm tính mảng giá trị EMA chuẩn kỹ thuật
function calculateEMA(prices, period = 20) {
    if (prices.length < period) return null;
    
    // Hệ số làm mượt Multiplier
    const k = 2 / (period + 1);
    
    // Khởi tạo giá trị ban đầu bằng đường SMA (Trung bình cộng các nến đầu tiên)
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += prices[i];
    }
    let ema = sum / period;
    
    // Tính lũy tiến các nến tiếp theo
    for (let i = period; i < prices.length; i++) {
        ema = (prices[i] * k) + (ema * (1 - k));
    }
    
    return ema; // Trả về giá trị EMA cuối cùng (tức thời nến hiện tại)
}

// Hàm lấy dữ liệu nến khung 15m và trả về { giá hiện hành, giá ema20 }
async function getLivePriceAndEMA20(symbol) {
    try {
        // Lấy 60 nến khung 15m để đường EMA-20 có đủ lịch sử mượt mà và chuẩn xác nhất
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=60`;
        const response = await axios.get(url, { timeout: 5000 });
        
        if (response.data && response.data.code === '0' && response.data.data.length >= 25) {
            const candles = response.data.data.reverse(); // Đảo từ cũ đến mới
            const prices = candles.map(c => parseFloat(c[4])); // Lấy chuỗi giá đóng cửa (Close)
            
            const lastPrice = prices[prices.length - 1]; // Giá hiện tại của nến [0] đang chạy
            const ema20 = calculateEMA(prices, 20);
            
            return { lastPrice, ema20 };
        }
    } catch (error) {}
    return null;
}

async function main() {
    try {
        console.log('--- BẤT ĐẦU QUY TRÌNH QUÉT TÍN HIỆU EMA CHÂN SÓNG 15M ---');

        // 1. Kiểm tra dữ liệu file nguồn top3
        if (!fs.existsSync(STATE_TOP3_FILE)) {
            console.log('Không tìm thấy file statetop3_8h.json!');
            return;
        }
        
        const stateData = JSON.parse(fs.readFileSync(STATE_TOP3_FILE, 'utf8'));
        const top3Gainers = stateData.top3Gainers8h || [];
        const top3Losers = stateData.top3Losers8h || [];

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        // 2. XỬ LÝ NHÓM LONG: Top 3 Tăng giá 8h
        console.log(`Đang kiểm tra tín hiệu LONG cho ${top3Gainers.length} coin nhóm Top Tăng...`);
        for (const symbol of top3Gainers) {
            if (!sentLog[symbol]) sentLog[symbol] = { _long: 0, _short: 0 };
            
            // Kiểm tra cooldown khóa chống trùng lệnh LONG
            if (currentTime - sentLog[symbol]._long >= COOLDOWN_TIME) {
                const data = await getLivePriceAndEMA20(symbol);
                if (data && data.ema20 !== null) {
                    const diff = data.lastPrice - data.ema20;
                    
                    // Điều kiện: -1 < (Giá hiện tại - EMA20) < 0.5
                    if (diff > -1 && diff < 0.5) {
                        const coinName = symbol.replace('-USDT-SWAP', '');
                        const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
                        
                        const message = `🟢 <b>[EMA-20 ALERT] TÍN HIỆU LONG (15M)</b>\n` +
                                        `🔥 Coin: <b>#${coinName}</b> (Top 3 Tăng 8H)\n` +
                                        `💵 Giá hiện tại: <code>${data.lastPrice}</code>\n` +
                                        `📉 Đường EMA-20: <code>${data.ema20.toFixed(4)}</code>\n` +
                                        `📐 Chênh lệch (Giá - EMA): <code>${diff.toFixed(4)}</code> (-1 &lt; diff &lt; 0.5)\n` +
                                        `👉 <a href="${link}">Mở đồ thị OKX</a>`;

                        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                            chat_id: TELEGRAM_CHAT_ID,
                            text: message,
                            parse_mode: 'HTML'
                        }).catch(() => {});

                        sentLog[symbol]._long = currentTime;
                        hasNewAlert = true;
                    }
                }
                await sleep(50);
            }
        }

        // 3. XỬ LÝ NHÓM SHORT: Top 3 Giảm giá 8h
        console.log(`Đang kiểm tra tín hiệu SHORT cho ${top3Losers.length} coin nhóm Top Giảm...`);
        for (const symbol of top3Losers) {
            if (!sentLog[symbol]) sentLog[symbol] = { _long: 0, _short: 0 };
            
            // Kiểm tra cooldown khóa chống trùng lệnh SHORT
            if (currentTime - sentLog[symbol]._short >= COOLDOWN_TIME) {
                const data = await getLivePriceAndEMA20(symbol);
                if (data && data.ema20 !== null) {
                    const diff = data.lastPrice - data.ema20;
                    
                    // Điều kiện: -0.5 < (Giá hiện tại - EMA20) < 1
                    if (diff > -0.5 && diff < 1) {
                        const coinName = symbol.replace('-USDT-SWAP', '');
                        const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
                        
                        const message = `🔴 <b>[EMA-20 ALERT] TÍN HIỆU SHORT (1H)</b>\n` +
                                        `🔥 Coin: <b>#${coinName}</b> (Top 3 Giảm 8H)\n` +
                                        `💵 Giá hiện tại: <code>${data.lastPrice}</code>\n` +
                                        `📈 Đường EMA-20: <code>${data.ema20.toFixed(4)}</code>\n` +
                                        `📐 Chênh lệch (Giá - EMA): <code>${diff.toFixed(4)}</code> (-0.5 &lt; diff &lt; 1)\n` +
                                        `👉 <a href="${link}">Mở đồ thị OKX</a>`;

                        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                            chat_id: TELEGRAM_CHAT_ID,
                            text: message,
                            parse_mode: 'HTML'
                        }).catch(() => {});

                        sentLog[symbol]._short = currentTime;
                        hasNewAlert = true;
                    }
                }
                await sleep(50);
            }
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- HOÀN THÀNH TIẾN TRÌNH QUÉT CHỈ BÁO EMA ---');
    } catch (err) {
        console.error('Lỗi chạy file ema.js:', err.message);
    }
}

main();
