import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;
const OKX_BASE_URL = 'https://www.okx.com';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'sentCoins.json');

// Cấu hình thời gian chặn gửi lại (Countdown 15m) là 6 giờ
const COUNTDOWN_15M = 6 * 60 * 60 * 1000; 

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
            if (timeData._15m && now - timeData._15m < COUNTDOWN_15M) temp._15m = timeData._15m;
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

function calculateEMA(prices, period = 20) {
    if (prices.length < period) return 0;
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;
    for (let i = period; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
}

// Hàm quét dữ liệu nến 15m để tính biến động 6h qua (24 nến)
async function get6HoursChange(symbol) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=24`;
        const response = await axios.get(url, { timeout: 5000 });
        if (response.data && response.data.code === '0' && response.data.data.length > 0) {
            const candles = response.data.data; // index 0 là nến hiện tại
            
            const currentPrice = parseFloat(candles[0][4]); 
            const oldestCandle = candles[candles.length - 1];
            const price6HoursAgo = parseFloat(oldestCandle[1]); // Giá open của 6 tiếng trước
            
            const change6h = price6HoursAgo ? ((currentPrice - price6HoursAgo) / price6HoursAgo) * 100 : 0;
            return { symbol, change6h };
        }
    } catch (error) {}
    return { symbol, change6h: 999 };
}

// Hàm lấy 100 nến 15m tính EMA20 cho Top 5 sau cùng
async function getTechnicalMetrics15m(symbol) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=100`;
        const response = await axios.get(url, { timeout: 6000 });
        if (response.data && response.data.code === '0' && response.data.data.length >= 40) {
            const candles15m = response.data.data.reverse(); 
            const currentCandle = candles15m[candles15m.length - 1];
            const currentHigh = parseFloat(currentCandle[2]); 

            const closedCandles15m = candles15m.slice(0, candles15m.length - 1);
            const prices15m = closedCandles15m.map(c => parseFloat(c[4]));
            const ema20_15m = calculateEMA(prices15m, 20);

            const b_15m = ema20_15m ? ((ema20_15m - currentHigh) / ema20_15m) * 100 : 999;

            return { symbol, b_15m };
        }
    } catch (error) {}
    return null;
}

async function main() {
    try {
        console.log('--- BẤT ĐẦU BOT LỌC 2 BƯỚC: TOP 20 (24H) -> TOP 5 (6H) ---');
        
        // 1. Tải Ticker tổng & Lọc Volume > 5,000,000 USD trước
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);
        if (!response.data || response.data.code !== '0') return;

        const rawFutures = response.data.data.filter(t => 
            t.instId.endsWith('-USDT-SWAP') && parseFloat(t.vol24h) >= 5000000
        );

        // 2. Tính % 24h từ dữ liệu có sẵn trong Ticker
        const poolWith24hChange = rawFutures.map(t => {
            const open24h = parseFloat(t.sod24h);
            const lastPrice = parseFloat(t.last);
            const change24h = open24h ? ((lastPrice - open24h) / open24h) * 100 : 0;
            return { instId: t.instId, change24h, lastPrice };
        });

        // 3. CHẶN BƯỚC 1: Chỉ lấy Top 20 coin giảm mạnh nhất 24h qua để xét tiếp
        const top20Losers24h = poolWith24hChange
            .sort((a, b) => a.change24h - b.change24h) // Giảm nhiều nhất xếp lên đầu
            .slice(0, 20);

        if (top20Losers24h.length === 0) return;

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        const poolWith6hChange = [];

        // 4. CHẶN BƯỚC 2: Chỉ quét nến 6h đối với 20 coin đầu bảng này
        for (let i = 0; i < top20Losers24h.length; i++) {
            const symbol = top20Losers24h[i].instId;
            const data6h = await get6HoursChange(symbol);
            if (data6h.change6h !== 999) {
                poolWith6hChange.push({
                    instId: symbol,
                    change6h: data6h.change6h,
                    lastPrice: top20Losers24h[i].lastPrice
                });
            }
            await sleep(40);
        }

        // 5. ĐÃ THÀNH TOP 5: Sắp xếp và lấy chính xác Top 5 giảm mạnh nhất trong 6 giờ vừa qua
        const top5Losers6h = poolWith6hChange
            .sort((a, b) => a.change6h - b.change6h)
            .slice(0, 5);

        if (top5Losers6h.length === 0) return;

        // 6. Lấy dữ liệu 100 nến tính EMA20 song song cho Top 5 cuối cùng (Tiết kiệm thêm request)
        const technicalPromises = top5Losers6h.map(coin => getTechnicalMetrics15m(coin.instId));
        const technicalResults = await Promise.all(technicalPromises);

        let hasNewAlert = false;

        for (let i = 0; i < top5Losers6h.length; i++) {
            const coinData = top5Losers6h[i];
            const symbol = coinData.instId;
            const metrics = technicalResults.find(r => r && r.symbol === symbol);
            if (!metrics) continue;

            if (!sentLog[symbol]) sentLog[symbol] = { _15m: 0 };
            const coinLog = sentLog[symbol];

            // 7. Kiểm tra điều kiện Short khung 15m (b_15m thuộc khoảng [-1%; 0.5%])
            if (metrics.b_15m >= -1 && metrics.b_15m <= 0.5) {
                // Kiểm tra Countdown 6 giờ độc lập
                if (currentTime - (coinLog._15m || 0) >= COUNTDOWN_15M) {
                    
                    const coinName = symbol.replace('-USDT-SWAP', '');
                    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
                    const formattedPct = coinData.change6h >= 0 ? `+${coinData.change6h.toFixed(2)}%` : `${coinData.change6h.toFixed(2)}%`;
                    const labelRanking = `TOP ${i + 1} GIẢM 6H`;

                    // Gửi tin nhắn Telegram
                    const message = `🔴 <b>SHORT 15M #${coinName} ${labelRanking} (${formattedPct})</b>\n👉 <a href="${link}">Giao dịch ngay</a>`;

                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID,
                        text: message,
                        parse_mode: 'HTML'
                    }).catch(() => {});

                    sentLog[symbol]._15m = currentTime;
                    hasNewAlert = true;
                }
            }
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- KẾT THÚC TIẾN TRÌNH QUÉT KHUNG 15M ---');
    } catch (err) {
        console.error('Lỗi chạy chính:', err.message);
    }
}

main();
