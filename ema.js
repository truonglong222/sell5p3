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
const STATE_TOP3_FILE = path.join(__dirname, 'statetop3_4h.json');

const COOLDOWN_TIME = 2 * 60 * 60 * 1000; // Khóa chống trùng gửi tin 2 tiếng
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
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

function calculateEMA(prices, period = 20) {
    if (prices.length < period) return null;
    const k = 2 / (period + 1);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += prices[i];
    let ema = sum / period;
    for (let i = period; i < prices.length; i++) {
        ema = (prices[i] * k) + (ema * (1 - k));
    }
    return ema;
}

async function getLivePriceAndEMA20(symbol) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=60`;
        const response = await axios.get(url, { timeout: 5000 });

        if (response.data && response.data.code === '0' && response.data.data.length >= 25) { 
            const candles = response.data.data.reverse(); 
            const prices = candles.map(c => parseFloat(c[4])); 
            const lastPrice = prices[prices.length - 1]; 
            const ema20 = calculateEMA(prices, 20); 
            return { lastPrice, ema20 }; 
        } 
    } catch (error) {} 
    return null; 
}

async function main() {
    try {
        console.log('--- BẤT ĐẦU QUÉT TÍN HIỆU EMA CHÂN SÓNG 15M (DỰA TRÊN TÍNH TOÁN DỮ LIỆU TOP 5D) ---');

        if (!fs.existsSync(STATE_TOP3_FILE)) { 
            console.log('Không tìm thấy file statetop3_4h.json!'); 
            return; 
        } 
        const stateData = JSON.parse(fs.readFileSync(STATE_TOP3_FILE, 'utf8')); 
        const top3Gainers = stateData.top3Gainers4h || stateData.top3Gainers8h || []; 

        const sentLog = loadSentLog(); 
        const currentTime = Date.now(); 
        let hasNewAlert = false; 

        // XỬ LÝ NHÓM LONG
        for (let i = 0; i < top3Gainers.length; i++) { 
            const item = top3Gainers[i]; 
            const symbol = typeof item === 'object' ? item.symbol : item; 
            const changeStr = typeof item === 'object' && item.change ? `${item.change}` : 'N/A'; 
            
            // ĐÃ ĐỔI: Lấy thứ hạng 5 ngày từ thuộc tính rank5d trong file statetop3_4h.json
            const rank5d = typeof item === 'object' && item.rank5d ? item.rank5d : 'N/A'; 

            if (!sentLog[symbol]) sentLog[symbol] = { _long: 0 }; 
            
            // Kiểm tra cooldown
            if (currentTime - (sentLog[symbol]._long || 0) >= COOLDOWN_TIME) { 
                const data = await getLivePriceAndEMA20(symbol); 
                if (data && data.ema20 !== null) { 
                    const diffPct = ((data.lastPrice - data.ema20) / data.ema20) * 100; 
                    
                    // Điều kiện: Giá đang nằm trong vùng chạm/vừa nhúng qua EMA20 khung 15m
                    if (diffPct > -0.5 && diffPct < 0.2) { 
                        const coinName = symbol.replace('-USDT-SWAP', ''); 
                        const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`; 
                        
                        // ĐÃ ĐỔI: Đổi nội dung hiển thị sang Top Giảm / Biến động 5D
                        const message = `🟢 <b>LONG #${coinName} (15M)</b>\n` + 
                                        `🏆 Vị trí: <b>Top ${rank5d} Biến động 5D</b>\n` + 
                                        `📊 Biến động 3 nến 2H: <code>${changeStr}</code>\n` + 
                                        `👉 <a href="${link}">Đồ thị OKX</a>`; 
                        
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

        if (hasNewAlert) saveSentLog(sentLog); 
        console.log('--- HOÀN THÀNH TIẾN TRÌNH QUÉT EMA 15M ---'); 
    } catch (err) { 
        console.error('Lỗi chạy file ema.js:', err.message); 
    } 
}

main();
