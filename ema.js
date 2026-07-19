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
// BỔ SUNG: Đường dẫn tới file top 20 giảm 5 ngày
const STATE_5D_FILE = path.join(__dirname, 'statetop_5d.json');

const COOLDOWN_TIME = 2 * 60 * 60 * 1000; // Khóa chống trùng 4 giờ
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
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=5m&limit=60`;
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
        console.log('--- BẤT ĐẦU QUÉT TÍN HIỆU EMA CHÂN SÓNG 5M ---');

        if (!fs.existsSync(STATE_TOP3_FILE)) {
            console.log('Không tìm thấy file statetop3_4h.json!');
            return;
        }
        
        const stateData = JSON.parse(fs.readFileSync(STATE_TOP3_FILE, 'utf8'));
        const top3Gainers = stateData.top3Gainers4h || stateData.top3Gainers8h || [];
        const top3Losers = stateData.top3Losers8h || stateData.top3Losers4h || [];

        // BỔ SUNG: Đọc danh sách top 20 giảm 5 ngày để đối chiếu cho lệnh LONG
        let top20Losers5d = [];
        if (fs.existsSync(STATE_5D_FILE)) {
            try {
                const data5d = JSON.parse(fs.readFileSync(STATE_5D_FILE, 'utf8'));
                // Hỗ trợ nếu file lưu dạng mảng trực tiếp hoặc lưu trong key top20Losers5d / top3Losers8h...
                top20Losers5d = Array.isArray(data5d) ? data5d : (data5d.top20Losers5d || data5d.top3Losers8h || []);
            } catch (e) {
                console.log('Lỗi đọc cấu trúc file statetop_5d.json, tạm thời bỏ qua đối chiếu mảng 5d.');
            }
        } else {
            console.log('Cảnh báo: Không tìm thấy file statetop_5d.json để kiểm tra điều kiện LONG!');
        }

        // Chuyển mảng 5 ngày thành danh sách chỉ chứa chuỗi kí tự Symbol để dễ so khớp (.includes)
        const top20Losers5dSymbols = top20Losers5d.map(item => typeof item === 'object' ? item.symbol : item);

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        // 1. XỬ LÝ NHÓM LONG: Top 3 Tăng giá 4h + Điều kiện nằm trong Top 20 Giảm 5 Ngày
        for (let i = 0; i < top3Gainers.length; i++) {
            const item = top3Gainers[i];
            const symbol = typeof item === 'object' ? item.symbol : item;
            const changeStr = typeof item === 'object' && item.change ? `${item.change}%` : 'N/A';
            const rank = i + 1;

            // ĐIỀU KIỆN MỚI: Check xem coin này có nằm trong danh sách Top 20 giảm 5 ngày không
            const isExistIn5dLosers = top20Losers5dSymbols.includes(symbol);
            if (!isExistIn5dLosers) {
                continue; // Nếu không nằm trong top 20 giảm 5 ngày -> Bỏ qua không quét coin này
            }

            if (!sentLog[symbol]) sentLog[symbol] = { _long: 0, _short: 0 };
            
            if (currentTime - sentLog[symbol]._long >= COOLDOWN_TIME) {
                const data = await getLivePriceAndEMA20(symbol);
                if (data && data.ema20 !== null) {
                    // ĐỔI CODE: Tính tỷ lệ % lệch kỹ thuật theo công thức: (giá - ema) / ema * 100
                    const diffPct = ((data.lastPrice - data.ema20) / data.ema20) * 100;
                    
                    // ĐỔI CODE: Điều kiện phần trăm Long mới: -0.5% < lệch < 0.2%
                    if (diffPct > -0.5 && diffPct < 0.2) {
                        const coinName = symbol.replace('-USDT-SWAP', '');
                        const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
                        
                        const message = `🟢 <b>LONG #${coinName} (5M)</b>\n` +
                                        `🏆 Vị trí: <b>Top ${rank} Tăng (4H)</b>\n` +
                                        `📊 Biến động 8H: <code>${changeStr}</code>\n` +
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

        // 2. XỬ LÝ NHÓM SHORT: Top 3 Giảm giá 8h (Giữ nguyên không check file 5 ngày)
        for (let i = 0; i < top3Losers.length; i++) {
            const item = top3Losers[i];
            const symbol = typeof item === 'object' ? item.symbol : item;
            const changeStr = typeof item === 'object' && item.change ? `${item.change}%` : 'N/A';
            const rank = i + 1;

            if (!sentLog[symbol]) sentLog[symbol] = { _long: 0, _short: 0 };
            
            if (currentTime - sentLog[symbol]._short >= COOLDOWN_TIME) {
                const data = await getLivePriceAndEMA20(symbol);
                if (data && data.ema20 !== null) {
                    // ĐỔI CODE: Tính tỷ lệ % lệch kỹ thuật theo công thức: (giá - ema) / ema * 100
                    const diffPct = ((data.lastPrice - data.ema20) / data.ema20) * 100;
                    
                    // ĐỔI CODE: Điều kiện phần trăm Short mới: -0.2% < lệch < 0.5%
                    if (diffPct > -0.2 && diffPct < 0.5) {
                        const coinName = symbol.replace('-USDT-SWAP', '');
                        const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
                        
                        const message = `🔴 <b>SHORT #${coinName} (5M)</b>\n` +
                                        `🏆 Vị trí: <b>Top ${rank} Giảm (8H)</b>\n` +
                                        `📊 Biến động 8H: <code>${changeStr}</code>\n` +
                                        `👉 <a href="${link}">Đồ thị OKX</a>`;

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
        console.log('--- HOÀN THÀNH TIẾN TRÌNH QUÉT EMA 5M ---');
    } catch (err) {
        console.error('Lỗi chạy file ema.js:', err.message);
    }
}

main();
