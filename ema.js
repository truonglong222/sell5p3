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

        // 1. Đọc danh sách top 20 giảm 5 ngày từ file JSON
        let top20Losers5d = [];
        if (fs.existsSync(STATE_5D_FILE)) {
            try {
                const data5d = JSON.parse(fs.readFileSync(STATE_5D_FILE, 'utf8'));
                top20Losers5d = Array.isArray(data5d) ? data5d : (data5d.top20Losers5d || data5d.top3Losers8h || []);
            } catch (e) {
                console.log('Lỗi đọc cấu trúc file statetop_5d.json, tạm thời bỏ qua đối chiếu mảng 5d.');
            }
        }
        const top20Losers5dSymbols = top20Losers5d.map(item => typeof item === 'object' ? item.symbol : item);

        // 2. BỔ SUNG: Lấy dữ liệu Ticker tổng trực tiếp từ OKX để lọc Top 3 Tăng/Giảm 24h
        const resTickers = await axios.get(`${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`);
        if (!resTickers.data || resTickers.data.code !== '0') {
            console.log('Không thể lấy dữ liệu ticker tổng để lọc loại bỏ Top 3 24h.');
            return;
        }

        // Lọc các cặp USDT-SWAP và parse giá trị phần trăm biến động 24h (sodUtc24h)
        const tickers24h = resTickers.data.data
            .filter(t => t.instId.endsWith('-USDT-SWAP'))
            .map(t => ({
                symbol: t.instId,
                change24h: parseFloat(t.sodUtc24h || 0) // Biên độ biến động so với giá mở cửa UTC lúc 0h
            }));

        // Tìm Top 3 Tăng giá 24h lớn nhất (Sắp xếp từ Cao xuống Thấp)
        const top3Gainers24hSymbols = [...tickers24h]
            .sort((a, b) => b.change24h - a.change24h)
            .slice(0, 3)
            .map(t => t.symbol);

        // Tìm Top 3 Giảm giá 24h lớn nhất (Sắp xếp từ Thấp lên Cao - âm nhiều nhất lên đầu)
        const top3Losers24hSymbols = [...tickers24h]
            .sort((a, b) => a.change24h - b.change24h)
            .slice(0, 3)
            .map(t => t.symbol);

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        // 1. XỬ LÝ NHÓM LONG: Thuộc Top 20 Giảm 5D VÀ KHÔNG ĐƯỢC THUỘC Top 3 Tăng 24H
        for (let i = 0; i < top3Gainers.length; i++) {
            const item = top3Gainers[i];
            const symbol = typeof item === 'object' ? item.symbol : item;
            const changeStr = typeof item === 'object' && item.change ? `${item.change}%` : 'N/A';
            const rank = i + 1;

            // Điều kiện gốc: Phải nằm trong top 20 giảm 5 ngày
            if (!top20Losers5dSymbols.includes(symbol)) {
                continue; 
            }

            // ĐIỀU KIỆN MỚI: Nếu trùng vào Top 3 Tăng giá 24h -> Loại bỏ ngay
            if (top3Gainers24hSymbols.includes(symbol)) {
                console.log(`[LONG] Bỏ qua ${symbol} vì thuộc Top 3 Tăng giá 24h`);
                continue;
            }

            if (!sentLog[symbol]) sentLog[symbol] = { _long: 0, _short: 0 };
            
            if (currentTime - sentLog[symbol]._long >= COOLDOWN_TIME) {
                const data = await getLivePriceAndEMA20(symbol);
                if (data && data.ema20 !== null) {
                    const diffPct = ((data.lastPrice - data.ema20) / data.ema20) * 100;
                    
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

        // 2. XỬ LÝ NHÓM SHORT: KHÔNG THUỘC Top 20 Giảm 5D VÀ KHÔNG ĐƯỢC THUỘC Top 3 Giảm 24H
        for (let i = 0; i < top3Losers.length; i++) {
            const item = top3Losers[i];
            const symbol = typeof item === 'object' ? item.symbol : item;
            const changeStr = typeof item === 'object' && item.change ? `${item.change}%` : 'N/A';
            const rank = i + 1;

            // Điều kiện gốc: Không được nằm trong top 20 giảm 5 ngày
            if (top20Losers5dSymbols.includes(symbol)) {
                continue; 
            }

            // ĐIỀU KIỆN MỚI: Nếu trùng vào Top 3 Giảm giá 24h -> Loại bỏ ngay
            if (top3Losers24hSymbols.includes(symbol)) {
                console.log(`[SHORT] Bỏ qua ${symbol} vì thuộc Top 3 Giảm giá 24h`);
                continue;
            }

            if (!sentLog[symbol]) sentLog[symbol] = { _long: 0, _short: 0 };
            
            if (currentTime - sentLog[symbol]._short >= COOLDOWN_TIME) {
                const data = await getLivePriceAndEMA20(symbol);
                if (data && data.ema20 !== null) {
                    const diffPct = ((data.lastPrice - data.ema20) / data.ema20) * 100;
                    
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
