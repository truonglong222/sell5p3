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

// Cấu hình Cooldown: 30 PHÚT
const COOLDOWN_TIME = 30 * 60 * 1000;

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
            for (const [key, timestamp] of Object.entries(timeData)) {
                // Giữ lại các lệnh còn trong thời gian cooldown 30 phút
                if (now - timestamp < COOLDOWN_TIME) {
                    temp[key] = timestamp;
                }
            }
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
        console.log(`💾 Đã cập nhật log gửi tin vào ${DB_FILE}`);
    } catch (e) {
        console.error('Lỗi khi ghi file sent_ema.json:', e.message);
    }
}

// ------------------- HÀM TÍNH TOÁN EMA & BOLLINGER BANDS -------------------
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

function calculateBollingerBands(prices, period = 20, stdDevMultiplier = 2) {
    if (prices.length < period) return null;
    const slice = prices.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    return {
        middle: mean,
        upper: mean + stdDevMultiplier * stdDev,
        lower: mean - stdDevMultiplier * stdDev
    };
}

// ------------------- TÍNH EMA10N TRÊN KHUNG 3M -------------------
function calculateEma10nFromCandles(rawCandles) {
    if (!rawCandles || rawCandles.length < 35) return null;

    const closedPrices1 = rawCandles.slice(1).reverse().map(c => parseFloat(c[4]));
    const ema20_Candle1 = calculateEMA(closedPrices1, 20);

    const closedPrices10 = rawCandles.slice(10).reverse().map(c => parseFloat(c[4]));
    const ema20_Candle10 = calculateEMA(closedPrices10, 20);

    if (!ema20_Candle1 || !ema20_Candle10 || ema20_Candle10 === 0) return null;

    return ((ema20_Candle1 - ema20_Candle10) / ema20_Candle10) * 100;
}

// ------------------- TÍNH TỶ LỆ X (KHUNG 1M) -------------------
function calculateXRatio(candles1m) {
    // Cần tối thiểu 11 nến (index 0 là nến đang chạy, index 1..10 là 10 nến đã đóng)
    if (!candles1m || candles1m.length < 11) return null;

    // Nến 1m vừa đóng gần nhất là index 1
    const closedCandle1 = candles1m[1];
    const open1 = parseFloat(closedCandle1[1]);
    const close1 = parseFloat(closedCandle1[4]);
    const absDiff1 = Math.abs(close1 - open1);

    // 10 nến 1m đã đóng gần nhất: index 1 đến 10
    const past10Candles = candles1m.slice(1, 11);
    const totalAbsDiff = past10Candles.reduce((sum, c) => {
        const o = parseFloat(c[1]);
        const cl = parseFloat(c[4]);
        return sum + Math.abs(cl - o);
    }, 0);

    const avgAbsDiff = totalAbsDiff / 10;
    if (avgAbsDiff === 0) return null;

    return absDiff1 / avgAbsDiff;
}

// ------------------- LẤY TOP 3 TĂNG VÀ TOP 3 GIẢM 24H -------------------
async function getTopGainersAndLosers() {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const res = await axios.get(url, { timeout: 10000 });
        if (!res.data || res.data.code !== '0') return { topGainers: [], topLosers: [] };

        const validTickers = res.data.data.filter(item => {
            if (!item.instId.endsWith('-USDT-SWAP')) return false;
            const open24h = parseFloat(item.open24h || 0);
            const last = parseFloat(item.last || 0);
            return open24h > 0 && last > 0;
        }).map(item => {
            const open = parseFloat(item.open24h);
            const last = parseFloat(item.last);
            const change24h = ((last - open) / open) * 100;
            return {
                instId: item.instId,
                change24h: change24h
            };
        });

        // Top Tăng
        validTickers.sort((a, b) => b.change24h - a.change24h);
        const topGainers = validTickers.slice(0, 3).map((item, index) => ({
            ...item,
            rank: index + 1
        }));

        // Top Giảm
        validTickers.sort((a, b) => a.change24h - b.change24h);
        const topLosers = validTickers.slice(0, 3).map((item, index) => ({
            ...item,
            rank: index + 1
        }));

        return { topGainers, topLosers };
    } catch (error) {
        console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
        return { topGainers: [], topLosers: [] };
    }
}

// ------------------- KIỂM TRA ĐIỀU KIỆN TÍN HIỆU -------------------
async function checkCoinSignals(symbol, type, rank) {
    try {
        // Lấy song song dữ liệu nến 3m và 1m
        const [res3m, res1m] = await Promise.all([
            axios.get(`${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=3m&limit=50`, { timeout: 5000 }),
            axios.get(`${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1m&limit=20`, { timeout: 5000 })
        ]);

        if (!res3m.data || res3m.data.code !== '0' || res3m.data.data.length < 35) return [];
        if (!res1m.data || res1m.data.code !== '0' || res1m.data.data.length < 11) return [];

        const candles3m = res3m.data.data;
        const candles1m = res1m.data.data;

        // 1. Kiểm tra điều kiện x < 3 trên khung 1m
        const xRatio = calculateXRatio(candles1m);
        if (xRatio === null || xRatio >= 3) return [];

        // 2. Kiểm tra ema10n (3m): LONG > 1%, SHORT < -1%
        const ema10n = calculateEma10nFromCandles(candles3m);
        if (ema10n === null) return [];

        if (type === 'LONG' && ema10n <= 1) return [];
        if (type === 'SHORT' && ema10n >= -1) return [];

        // 3. Tính Bollinger Bands trên khung 3m
        const currentCandle = candles3m[0];
        const high0 = parseFloat(currentCandle[2]);
        const low0 = parseFloat(currentCandle[3]);

        const closedPrices = candles3m.slice(1, 21).reverse().map(c => parseFloat(c[4]));
        const bb = calculateBollingerBands(closedPrices, 20);
        if (!bb || bb.upper === 0 || bb.lower === 0 || bb.middle === 0) return [];

        // Điều kiện độ rộng: 3% < Hbb < 15%
        const hBB = ((bb.upper - bb.lower) / bb.upper) * 100;
        if (hBB <= 3 || hBB >= 15) return [];

        const matchedSignals = [];

        // 4. Kiểm tra điều kiện vị trí nến so với BB Middle và BB Bands
        if (type === 'LONG') {
            // Điều kiện 1: Low so với BB Mid (-2% < bbm < +0.5%)
            const bbm = ((low0 - bb.middle) / bb.middle) * 100;
            if (bbm > -2 && bbm < 0.5) {
                matchedSignals.push({
                    symbol,
                    type: 'LONG',
                    subType: 'bb_mid',
                    label: 'Low so với BB Mid (bbm)',
                    diffVal: bbm,
                    rank,
                    hBB,
                    ema10n,
                    xRatio
                });
            }

            // Điều kiện 2: Low so với BB Low (-2% < bbl < +0.5%)
            const bbl = ((low0 - bb.lower) / bb.lower) * 100;
            if (bbl > -2 && bbl < 0.5) {
                matchedSignals.push({
                    symbol,
                    type: 'LONG',
                    subType: 'bb_low',
                    label: 'Low so với BB Low (bbl)',
                    diffVal: bbl,
                    rank,
                    hBB,
                    ema10n,
                    xRatio
                });
            }
        } else if (type === 'SHORT') {
            // Điều kiện 1: High so với BB Mid (-0.5% < bbm < +2%)
            const bbm = ((high0 - bb.middle) / bb.middle) * 100;
            if (bbm > -0.5 && bbm < 2) {
                matchedSignals.push({
                    symbol,
                    type: 'SHORT',
                    subType: 'bb_mid',
                    label: 'High so với BB Mid (bbm)',
                    diffVal: bbm,
                    rank,
                    hBB,
                    ema10n,
                    xRatio
                });
            }

            // Điều kiện 2: High so với BB Up (-0.5% < bbu < +2%)
            const bbu = ((high0 - bb.upper) / bb.upper) * 100;
            if (bbu > -0.5 && bbu < 2) {
                matchedSignals.push({
                    symbol,
                    type: 'SHORT',
                    subType: 'bb_up',
                    label: 'High so với BB Up (bbu)',
                    diffVal: bbu,
                    rank,
                    hBB,
                    ema10n,
                    xRatio
                });
            }
        }

        return matchedSignals;
    } catch (error) {
        console.error(`Lỗi kiểm tra nến (${symbol}):`, error.message);
        return [];
    }
}

// ------------------- HÀM CHÍNH -------------------
async function main() {
    try {
        console.log('--- BẮT ĐẦU QUÉT TOP 3 TĂNG/GIẢM ---');

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        const { topGainers, topLosers } = await getTopGainersAndLosers();
        console.log(`Top 3 Tăng: ${topGainers.map(c => `${c.instId} (#${c.rank} ${c.change24h.toFixed(2)}%)`).join(', ')}`);
        console.log(`Top 3 Giảm: ${topLosers.map(c => `${c.instId} (#${c.rank} ${c.change24h.toFixed(2)}%)`).join(', ')}`);

        const sendAlert = async (signal) => {
            // Key cooldown riêng biệt: _long_bb_mid, _long_bb_low, _short_bb_mid, _short_bb_up
            const cooldownKey = `_${signal.type.toLowerCase()}_${signal.subType}`;
            if (!sentLog[signal.symbol]) sentLog[signal.symbol] = {};
            const lastSent = sentLog[signal.symbol][cooldownKey] || 0;

            // Kiểm tra cooldown 30 phút độc lập
            if (currentTime - lastSent >= COOLDOWN_TIME) {
                const coinName = signal.symbol.replace('-USDT-SWAP', '');
                const icon = signal.type === 'LONG' ? '🟢' : '🔴';
                const rankText = signal.type === 'LONG' ? `Top ${signal.rank} Tăng 24h` : `Top ${signal.rank} Giảm 24h`;
                const link = `https://www.okx.com/trade-swap/${signal.symbol.toLowerCase()}`;

                const message = `${icon} <b>${coinName} (${signal.type})</b>\n` +
                                `• Vị trí: <b>${rankText}</b>\n` +
                                `• ema10n (3m): <b>${signal.ema10n > 0 ? '+' : ''}${signal.ema10n.toFixed(2)}%</b>\n` +
                                `• Hbb (3m): <b>${signal.hBB.toFixed(2)}%</b>\n` +
                                `• ${signal.label}: <b>${signal.diffVal > 0 ? '+' : ''}${signal.diffVal.toFixed(2)}%</b>\n` +
                                `• x (1m body ratio): <b>${signal.xRatio.toFixed(2)}</b> (&lt; 3)\n` +
                                `• <a href="${link}">Trade trên OKX</a>`;

                console.log(`🚀 [${signal.type} - ${signal.subType}] Gửi Telegram cho ${signal.symbol}...`);
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

                sentLog[signal.symbol][cooldownKey] = currentTime;
                hasNewAlert = true;
            } else {
                const remainMin = Math.ceil((COOLDOWN_TIME - (currentTime - lastSent)) / 60000);
                console.log(`⏳ Bỏ qua ${signal.symbol} (${signal.type} - ${signal.subType}) - Đang cooldown (còn ${remainMin} phút).`);
            }
        };

        // Quét Long cho Top 3 Tăng
        for (const coin of topGainers) {
            const signals = await checkCoinSignals(coin.instId, 'LONG', coin.rank);
            for (const sig of signals) {
                await sendAlert(sig);
            }
            await sleep(100);
        }

        // Quét Short cho Top 3 Giảm
        for (const coin of topLosers) {
            const signals = await checkCoinSignals(coin.instId, 'SHORT', coin.rank);
            for (const sig of signals) {
                await sendAlert(sig);
            }
            await sleep(100);
        }

        // Lưu log mới vào file nếu có gửi tin
        if (hasNewAlert) {
            saveSentLog(sentLog);
        }

        console.log('--- HOÀN THÀNH QUÉT ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

main();
