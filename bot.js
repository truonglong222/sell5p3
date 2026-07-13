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
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=5m&limit=150`;
        const response = await axios.get(url, { timeout: 8000 });
        if (response.data && response.data.code === '0' && response.data.data.length >= 100) {
            const candles5m = response.data.data.reverse();
            const currentCandle = candles5m[candles5m.length - 1];
            const currentHigh = parseFloat(currentCandle[2]);
            const currentLow = parseFloat(currentCandle[3]);

            const closedCandles5m = candles5m.slice(0, candles5m.length - 1);
            const prices5m = closedCandles5m.map(c => parseFloat(c[4]));
            const ema20_5m = calculateEMA(prices5m, 20);

            const prices15m = [];
            for (let i = 2; i < closedCandles5m.length; i += 3) {
                prices15m.push(parseFloat(closedCandles5m[i][4]));
            }
            const ema20_15m = calculateEMA(prices15m, 20);

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

        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);
        if (!response.data || response.data.code !== '0') return;

        const sentLog = loadSentLog();
        const currentTime = Date.now();

        let calculatedPool = response.data.data
            .filter(t => t.instId.endsWith('-USDT-SWAP') && openPrices7AM[t.instId])
            .map(t => {
                const open7AM = parseFloat(openPrices7AM[t.instId]);
                const lastPrice = parseFloat(t.last);
                const vol24hQuote = parseFloat(t.vol24h); 
                const changeSince7AM = open7AM ? ((lastPrice - open7AM) / open7AM) * 100 : 0;
                return { instId: t.instId, changeSince7AM, lastPrice, vol24hQuote };
            });

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

        // Lọc Volume > 5.000.000 USD
        for (const [symbol, coinData] of rankingPool.entries()) {
            if (coinData.vol24hQuote < 5000000) {
                rankingPool.delete(symbol);
            }
        }

        // --- ĐÃ THAY ĐỔI: ĐỐI CHIẾU TIÊU CHUẨN BỘ LỌC CHIỀU LONG / SHORT ---
        for (const [symbol, coinData] of rankingPool.entries()) {
            const isGainer7D = qualified7DaysGainers.includes(symbol);
            const isHeavyLoser7D = heavy7DaysLosers.includes(symbol);

            if (coinData.mode === 'long') {
                // Lệnh Long: Bắt buộc phải nằm trong list tăng 7 ngày
                if (!isGainer7D) {
                    rankingPool.delete(symbol);
                }
            } else if (coinData.mode === 'short') {
                // Lệnh Short: Không được nằm trong list tăng VÀ không được nằm trong list giảm sâu 7 ngày
                if (isGainer7D || isHeavyLoser7D) {
                    rankingPool.delete(symbol);
                }
            } else if (coinData.mode === 'both') {
                // Xử lý coin lưỡng tính
                const allowLong = isGainer7D;
                const allowShort = !isGainer7D && !isHeavyLoser7D;

                if (allowLong && !allowShort) coinData.mode = 'long';
                else if (!allowLong && allowShort) coinData.mode = 'short';
                else if (allowLong && allowShort) coinData.mode = 'both';
                else rankingPool.delete(symbol); // Không thỏa mãn cả 2 hướng -> Hủy hẳn
            }
        }

        if (rankingPool.size === 0) return;

        const technicalPromises = Array.from(rankingPool.keys()).map(symbol => getTechnicalMetrics(symbol));
        const technicalResults = await Promise.all(technicalPromises);

        let hasNewAlert = false;

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

            if (finalSignal && triggeredFrame) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
                const icon = finalSignal.includes("Long") ? "🟢" : "🔴";
                const formattedPct = coinData.changeSince7AM >= 0 ? `+${coinData.changeSince7AM.toFixed(2)}%` : `${coinData.changeSince7AM.toFixed(2)}%`;

                const message = `${icon} <b>${finalSignal.toUpperCase()} #${coinName} ${coinData.label} (${formattedPct})</b> 👉 <a href="${link}">Giao dịch ngay</a>`;

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
    } catch (err) {}
}

main();
