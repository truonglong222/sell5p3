import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;
const BINANCE_BASE_URL = 'https://fapi.binance.com';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'sentCoins_binance.json'); // Đọc/Ghi riêng biệt cho Binance
const STATE_FILE = path.join(__dirname, 'state_binance.json');   // Đọc riêng biệt của Binance

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
            if (timeData._5m && now - timeData._5m < 2 * 60 * 60 * 1000) temp._5m = timeData._5m;
            if (timeData._15m && now - timeData._15m < 2 * 60 * 60 * 1000) temp._15m = timeData._15m;
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

async function getTechnicalMetrics(symbol) {
    try {
        const url = `${BINANCE_BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=150`;
        const response = await axios.get(url, { timeout: 8000 });
        
        if (response.data && Array.isArray(response.data) && response.data.length >= 100) {
            const candles5m = response.data;
            
            const currentCandle = candles5m[candles5m.length - 1];
            const currentHigh = parseFloat(currentCandle[2]);
            const currentLow = parseFloat(currentCandle[3]);

            const closedCandles5m = candles5m.slice(0, candles5m.length - 1);
            
            // Tính EMA20 Khung 5M
            const prices5m = closedCandles5m.map(c => parseFloat(c[4]));
            const ema20_5m = calculateEMA(prices5m, 20);

            // Tính EMA20 Khung 15M gộp từ nến 5m
            const prices15m = [];
            for (let i = 2; i < closedCandles5m.length; i += 3) {
                prices15m.push(parseFloat(closedCandles5m[i][4]));
            }
            const ema20_15m = calculateEMA(prices15m, 20);

            // Tính độ lệch khoảng cách giá với các đường EMA
            const a_5m = ema20_5m ? ((ema20_5m - currentLow) / ema20_5m) * 100 : 999;
            const b_5m = ema20_5m ? ((ema20_5m - currentHigh) / ema20_5m) * 100 : 999;
            const a_15m = ema20_15m ? ((ema20_15m - currentLow) / ema20_15m) * 100 : 999;
            const b_15m = ema20_15m ? ((ema20_15m - currentHigh) / ema20_15m) * 100 : 999;

            return { symbol, a_5m, b_5m, a_15m, b_15m };
        }
        return null;
    } catch (error) { return null; }
}

async function main() {
    try {
        if (!fs.existsSync(STATE_FILE)) return;
        const stateData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        const openPrices7AM = stateData.openPrices || {};
        const qualified7DaysGainers = stateData.qualified7DaysGainers || [];
        const heavy7DaysLosers = stateData.heavy7DaysLosers || [];

        const tickersUrl = `${BINANCE_BASE_URL}/fapi/v1/ticker/24hr`;
        const response = await axios.get(tickersUrl);
        if (!response.data || !Array.isArray(response.data)) return;

        const sentLog = loadSentLog();
        const currentTime = Date.now();

        // 1. Tính toán % tăng giảm kể từ mốc 7h sáng dựa vào state_binance.json
        let calculatedPool = response.data
            .filter(t => t.symbol.endsWith('USDT') && openPrices7AM[t.symbol])
            .map(t => {
                const open7AM = parseFloat(openPrices7AM[t.symbol]);
                const lastPrice = parseFloat(t.lastPrice);
                const vol24hQuote = parseFloat(t.quoteVolume); 
                const changeSince7AM = open7AM ? ((lastPrice - open7AM) / open7AM) * 100 : 0;
                return { instId: t.symbol, changeSince7AM, lastPrice, vol24hQuote };
            });

        // 2. Lấy Top 5 tăng và Top 5 giảm từ 7h sáng
        let top5Gainers = [...calculatedPool].sort((a, b) => b.changeSince7AM - a.changeSince7AM).slice(0, 5);
        let top5Losers = [...calculatedPool].sort((a, b) => a.changeSince7AM - b.changeSince7AM).slice(0, 5);

        let rankingPool = new Map();
        
        top5Gainers.forEach((c, i) => {
            rankingPool.set(c.instId, { ...c, mode: 'long', label: `TOP ${i + 1} TĂNG` });
        });
        
        top5Losers.forEach((c, i) => {
            if (!rankingPool.has(c.instId)) {
                rankingPool.set(c.instId, { ...c, mode: 'short', label: `TOP ${i + 1} GIẢM` });
            } else {
                rankingPool.get(c.instId).mode = 'both';
                rankingPool.get(c.instId).label = `TOP ${i + 1} GIẢM`; 
            }
        });

        // 3. Bộ lọc khối lượng giao dịch USDT > 5.000.000 USD
        for (const [symbol, coinData] of rankingPool.entries()) {
            if (coinData.vol24hQuote < 5000000) {
                rankingPool.delete(symbol);
            }
        }

        // 4. Đối chiếu điều kiện danh sách 7 ngày
        for (const [symbol, coinData] of rankingPool.entries()) {
            const isGainer7D = qualified7DaysGainers.includes(symbol);
            const isHeavyLoser7D = heavy7DaysLosers.includes(symbol);

            if (coinData.mode === 'long') {
                if (!isGainer7D) rankingPool.delete(symbol);
            } else if (coinData.mode === 'short') {
                if (isGainer7D || isHeavyLoser7D) rankingPool.delete(symbol);
            } else if (coinData.mode === 'both') {
                const allowLong = isGainer7D;
                const allowShort = !isGainer7D && !isHeavyLoser7D;

                if (allowLong && !allowShort) coinData.mode = 'long';
                else if (!allowLong && allowShort) coinData.mode = 'short';
                else if (allowLong && allowShort) coinData.mode = 'both';
                else rankingPool.delete(symbol);
            }
        }

        if (rankingPool.size === 0) return;

        // 5. Quét kỹ thuật đa khung song song
        const technicalPromises = Array.from(rankingPool.keys()).map(symbol => getTechnicalMetrics(symbol));
        const technicalResults = await Promise.all(technicalPromises);

        let hasNewAlert = false;

        // 6. Kiểm tra điều kiện nến & đối chiếu Cooldown 2h riêng biệt từ sentCoins_binance.json
        for (const [symbol, coinData] of rankingPool) {
            const metrics = technicalResults.find(r => r && r.symbol === symbol);
            if (!metrics) continue;

            if (!sentLog[symbol]) sentLog[symbol] = { _5m: 0, _15m: 0 };
            const coinLog = sentLog[symbol];
            const mode = coinData.mode;

            let finalSignal = null;
            let triggeredFrame = null;

            if (mode === 'long' || mode === 'both') {
                const closeToEma5m = (metrics.a_5m >= -0.5 && metrics.a_5m <= 1);
                const closeToEma15m = (metrics.a_15m >= -0.5 && metrics.a_15m <= 1);
                
                if (closeToEma5m && (currentTime - (coinLog._5m || 0) >= 2 * 60 * 60 * 1000)) {
                    finalSignal = "Long 5p";
                    triggeredFrame = "5m";
                } else if (closeToEma15m && (currentTime - (coinLog._15m || 0) >= 2 * 60 * 60 * 1000)) {
                    finalSignal = "Long 15p";
                    triggeredFrame = "15m";
                }
            }

            if (!finalSignal && (mode === 'short' || mode === 'both')) {
                const closeToEma5m = (metrics.b_5m >= -1 && metrics.b_5m <= 0.5);
                const closeToEma15m = (metrics.b_15m >= -1 && metrics.b_15m <= 0.5);

                if (closeToEma5m && (currentTime - (coinLog._5m || 0) >= 2 * 60 * 60 * 1000)) {
                    finalSignal = "Short 5p";
                    triggeredFrame = "5m";
                } else if (closeToEma15m && (currentTime - (coinLog._15m || 0) >= 2 * 60 * 60 * 1000)) {
                    finalSignal = "Short 15p";
                    triggeredFrame = "15m";
                }
            }

            // 7. Thỏa mãn -> Gửi Telegram
            if (finalSignal && triggeredFrame) {
                const coinName = symbol.replace('USDT', '');
                const link = `https://www.binance.com/vi/futures/${symbol}`;
                const icon = finalSignal.includes("Long") ? "🟢" : "🔴";
                const formattedPct = coinData.changeSince7AM >= 0 ? `+${coinData.changeSince7AM.toFixed(2)}%` : `${coinData.changeSince7AM.toFixed(2)}%`;

                const message = `${icon} <b>BINANCE ${finalSignal.toUpperCase()} #${coinName} ${coinData.label} (${formattedPct})</b> 👉 <a href="${link}">Giao dịch ngay</a>`;

                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML'
                }).catch(() => {});

                if (triggeredFrame === "5m") sentLog[symbol]._5m = currentTime;
                if (triggeredFrame === "15m") sentLog[symbol]._15m = currentTime;
                hasNewAlert = true;
            }
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('Quét hoàn tất chu kỳ Binance Futures.');
    } catch (err) {}
}

main();
