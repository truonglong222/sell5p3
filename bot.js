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
const STATE_FILE = path.join(__dirname, 'state.json');

function loadSentLog() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            return data.trim() ? JSON.parse(data) : {};
        }
    } catch (e) {}
    return {};
}

// Giữ Cooldown 1 giờ
function saveSentLog(logData) {
    try {
        const now = Date.now();
        const cleanedLog = {};
        for (const [coin, timestamp] of Object.entries(logData)) {
            if (now - timestamp < 1 * 60 * 60 * 1000) cleanedLog[coin] = timestamp;
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

async function getMarketMetrics5m(symbol) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=5m&limit=100`;
        const response = await axios.get(url, { timeout: 6000 });
        if (response.data && response.data.code === '0' && response.data.data.length > 25) {
            const candles = response.data.data.reverse();
            const historyPrices = candles.slice(0, candles.length - 1).map(c => parseFloat(c[4]));
            const ema20_5m = calculateEMA(historyPrices, 20);

            const currentHigh = parseFloat(candles[candles.length - 1][2]);
            const currentLow = parseFloat(candles[candles.length - 1][3]);

            const a = ema20_5m ? ((ema20_5m - currentLow) / ema20_5m) * 100 : 0;
            const b = ema20_5m ? ((ema20_5m - currentHigh) / ema20_5m) * 100 : 0;
            return { symbol, a, b };
        }
        return null;
    } catch (e) { return null; }
}

async function main() {
    try {
        // 1. Đọc dữ liệu từ file state.json
        if (!fs.existsSync(STATE_FILE)) {
            console.error('Không tìm thấy dữ liệu state.json. Hãy chạy file 7h.js trước!');
            return;
        }
        const stateData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        const openPrices7AM = stateData.openPrices || {};
        const excludedTop5 = stateData.top5Gainers24h || []; // Danh sách Top 5 cần loại trừ ở chiều Long

        // 2. Lấy Ticker tổng hiện tại
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);
        if (!response.data || response.data.code !== '0') return;

        const sentLog = loadSentLog();
        const currentTime = Date.now();

        // 3. Tính toán nhanh % biến động từ 7h sáng
        let pool = response.data.data
            .filter(t => t.instId.endsWith('-USDT-SWAP') && openPrices7AM[t.instId])
            .map(t => {
                const open7AM = openPrices7AM[t.instId];
                const lastPrice = parseFloat(t.last);
                const changeSince7AM = ((lastPrice - open7AM) / open7AM) * 100;
                return { instId: t.instId, changeSince7AM, lastPrice };
            });

        // 4. Phân chia chuẩn xác Top 5 Tăng và Top 5 Giảm từ 7h sáng
        let top5Gainers = [...pool].sort((a, b) => b.changeSince7AM - a.changeSince7AM).slice(0, 5);
        let top5Losers = [...pool].sort((a, b) => a.changeSince7AM - b.changeSince7AM).slice(0, 5);

        let finalPool = new Map();
        top5Gainers.forEach((c, i) => finalPool.set(c.instId, { ...c, mode: 'long', label: `TOP ${i+1} TĂNG` }));
        top5Losers.forEach((c, i) => {
            if (!finalPool.has(c.instId)) {
                finalPool.set(c.instId, { ...c, mode: 'short', label: `TOP ${i+1} GIẢM` });
            } else {
                finalPool.get(c.instId).mode = 'both';
            }
        });

        // 5. --- THAY ĐỔI LOGIC LOẠI TRỪ: Chỉ loại bỏ quyền LONG đối với coin thuộc Top 5 Tăng 24h ---
        for (const [symbol, coinData] of finalPool.entries()) {
            if (excludedTop5.includes(symbol)) {
                if (coinData.mode === 'long') {
                    // Nếu coin chỉ có tín hiệu LONG -> Xóa hẳn khỏi danh sách quét
                    console.log(`[Loại trừ LONG] Bỏ qua tín hiệu LONG của ${symbol} vì thuộc Top 5 Tăng 24h.`);
                    finalPool.delete(symbol);
                } else if (coinData.mode === 'both') {
                    // Nếu coin vừa thuộc nhóm Tăng vừa thuộc nhóm Giảm (hy hữu), hạ cấp chỉ cho phép SHORT
                    coinData.mode = 'short';
                    console.log(`[Hạ cấp xuống SHORT] Chặn chiều LONG của ${symbol}, giữ lại chiều SHORT.`);
                }
            }
        }

        if (finalPool.size === 0) {
            console.log('Không còn coin nào hợp lệ sau khi lọc.');
            return;
        }

        // 6. Quét song song nến 5m cho các coin còn lại
        const promises = Array.from(finalPool.keys()).map(symbol => getMarketMetrics5m(symbol));
        const techResults = await Promise.all(promises);

        let hasNewAlert = false;

        // 7. Kiểm tra dải dung sai và áp dụng bộ lọc Cooldown ở bước cuối cùng
        for (const [symbol, coinData] of finalPool) {
            if (sentLog[symbol] && (currentTime - sentLog[symbol] < 1 * 60 * 60 * 1000)) continue; 

            const metrics = techResults.find(r => r && r.symbol === symbol);
            if (!metrics) continue;

            let signal = null;
            // Chỉ check lệnh Long nếu mode là 'long' hoặc 'both'
            if ((coinData.mode === 'long' || coinData.mode === 'both') && (metrics.a >= -0.5 && metrics.a <= 1)) signal = "Long 5p";
            // Chỉ check lệnh Short nếu mode là 'short' || 'both' (Chiều Short không bao giờ bị loại trừ bởi excludedTop5)
            if ((coinData.mode === 'short' || coinData.mode === 'both') && (metrics.b >= -1 && metrics.b <= 0.5)) signal = "Short 5p";

            if (signal) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
                const icon = signal.startsWith("Long") ? "🟢" : "🔴";
                const formattedPct = coinData.changeSince7AM >= 0 ? `+${coinData.changeSince7AM.toFixed(2)}%` : `${coinData.changeSince7AM.toFixed(2)}%`;

                const message = `${icon} <b>${signal.toUpperCase()} #${coinName} ${coinData.label} (${formattedPct})</b> 👉 <a href="${link}">Giao dịch ngay</a>`;

                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML'
                }).catch(() => {});

                sentLog[symbol] = currentTime;
                hasNewAlert = true;
            }
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('Quét hoàn tất chu kỳ.');
    } catch (err) { console.error(err.message); }
}

main();
