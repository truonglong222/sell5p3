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

// Đọc log an toàn từ file
function loadSentLog() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            return data.trim() ? JSON.parse(data) : {};
        }
    } catch (e) {
        console.error('Lỗi khi đọc file sent_ema.json:', e.message);
    }
    return {};
}

// Cập nhật timestamp cho từng điều kiện và lưu ngay
function updateAndSaveLog(symbol, cooldownKey, timestamp) {
    try {
        const logData = loadSentLog();
        const now = Date.now();

        if (!logData[symbol]) logData[symbol] = {};
        logData[symbol][cooldownKey] = timestamp;

        // Dọn dẹp các mốc thời gian đã quá hạn 30 phút
        const cleanedLog = {};
        for (const [coin, timeData] of Object.entries(logData)) {
            const validKeys = {};
            for (const [key, time] of Object.entries(timeData)) {
                if (now - time < COOLDOWN_TIME) {
                    validKeys[key] = time;
                }
            }
            if (Object.keys(validKeys).length > 0) {
                cleanedLog[coin] = validKeys;
            }
        }

        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
        console.log(`💾 [LONG] Đã lưu log (${symbol} -> ${cooldownKey}) vào ${DB_FILE}`);
    } catch (e) {
        console.error('Lỗi khi ghi file sent_ema.json:', e.message);
    }
}

// ------------------- HÀM TÍNH TOÁN CHỈ BÁO -------------------
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

function calculateEma10nFromCandles(rawCandles) {
    if (!rawCandles || rawCandles.length < 35) return null;

    const closedPrices1 = rawCandles.slice(1).reverse().map(c => parseFloat(c[4]));
    const ema20_Candle1 = calculateEMA(closedPrices1, 20);

    const closedPrices10 = rawCandles.slice(10).reverse().map(c => parseFloat(c[4]));
    const ema20_Candle10 = calculateEMA(closedPrices10, 20);

    if (!ema20_Candle1 || !ema20_Candle10 || ema20_Candle10 === 0) return null;

    return ((ema20_Candle1 - ema20_Candle10) / ema20_Candle10) * 100;
}

function calculateXRatio(candles1m) {
    if (!candles1m || candles1m.length < 11) return null;

    const closedCandle1 = candles1m[1];
    const open1 = parseFloat(closedCandle1[1]);
    const close1 = parseFloat(closedCandle1[4]);
    const absDiff1 = Math.abs(close1 - open1);

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

// ------------------- LẤY TOP 3 TĂNG 24H -------------------
async function getTopGainers() {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const res = await axios.get(url, { timeout: 10000 });
        if (!res.data || res.data.code !== '0') return [];

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

        validTickers.sort((a, b) => b.change24h - a.change24h);
        return validTickers.slice(0, 3).map((item, index) => ({
            ...item,
            rank: index + 1
        }));
    } catch (error) {
        console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
        return [];
    }
}

// ------------------- KIỂM TRA ĐIỀU KIỆN LONG -------------------
async function checkLongSignals(symbol, rank) {
    try {
        const [res3m, res1m] = await Promise.all([
            axios.get(`${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=3m&limit=50`, { timeout: 5000 }),
            axios.get(`${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1m&limit=20`, { timeout: 5000 })
        ]);

        if (!res3m.data || res3m.data.code !== '0' || res3m.data.data.length < 35) return [];
        if (!res1m.data || res1m.data.code !== '0' || res1m.data.data.length < 11) return [];

        const candles3m = res3m.data.data;
        const candles1m = res1m.data.data;

        // 1. Điều kiện x < 3
        const xRatio = calculateXRatio(candles1m);
        if (xRatio === null || xRatio >= 3) return [];

        // 2. Điều kiện ema10n > 1%
        const ema10n = calculateEma10nFromCandles(candles3m);
        if (ema10n === null || ema10n <= 1) return [];

        // 3. Bollinger Bands: 3% < Hbb < 15%
        const currentCandle = candles3m[0];
        const low0 = parseFloat(currentCandle[3]);

        const closedPrices = candles3m.slice(1, 21).reverse().map(c => parseFloat(c[4]));
        const bb = calculateBollingerBands(closedPrices, 20);
        if (!bb || bb.upper === 0 || bb.lower === 0 || bb.middle === 0) return [];

        const hBB = ((bb.upper - bb.lower) / bb.upper) * 100;
        if (hBB <= 3 || hBB >= 15) return [];

        const matchedSignals = [];

        // Trường hợp 1: Low so với BB Mid (-2% < bbm < +0.5%)
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

        // Trường hợp 2: Low so với BB Low (-2% < bbl < +0.5%)
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

        return matchedSignals;
    } catch (error) {
        console.error(`Lỗi kiểm tra nến (${symbol}):`, error.message);
        return [];
    }
}

// ------------------- HÀM CHÍNH -------------------
async function main() {
    try {
        console.log('--- BẮT ĐẦU QUÉT CHIỀU LONG ---');

        const topGainers = await getTopGainers();
        console.log(`Top 3 Tăng: ${topGainers.map(c => `${c.instId} (#${c.rank} ${c.change24h.toFixed(2)}%)`).join(', ')}`);

        for (const coin of topGainers) {
            const signals = await checkLongSignals(coin.instId, coin.rank);

            for (const sig of signals) {
                // Key countdown riêng biệt: _long_bb_mid hoặc _long_bb_low
                const cooldownKey = `_long_${sig.subType}`;
                
                // Đọc file mới nhất để kiểm tra cooldown
                const currentLog = loadSentLog();
                const lastSent = currentLog[sig.symbol]?.[cooldownKey] || 0;
                const now = Date.now();

                if (now - lastSent >= COOLDOWN_TIME) {
                    const coinName = sig.symbol.replace('-USDT-SWAP', '');
                    const rankText = `Top ${sig.rank} Tăng 24h`;
                    const link = `https://www.okx.com/trade-swap/${sig.symbol.toLowerCase()}`;

                    const message = `🟢 <b>${coinName} (LONG)</b>\n` +
                                    `• Vị trí: <b>${rankText}</b>\n` +
                                    `• ema10n (3m): <b>+${sig.ema10n.toFixed(2)}%</b>\n` +
                                    `• Hbb (3m): <b>${sig.hBB.toFixed(2)}%</b>\n` +
                                    `• ${sig.label}: <b>${sig.diffVal > 0 ? '+' : ''}${sig.diffVal.toFixed(2)}%</b>\n` +
                                    `• x (1m body ratio): <b>${sig.xRatio.toFixed(2)}</b> (&lt; 3)\n` +
                                    `• <a href="${link}">Trade trên OKX</a>`;

                    console.log(`🚀 [LONG - ${sig.subType}] Gửi Telegram cho ${sig.symbol}...`);
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID,
                        text: message,
                        parse_mode: 'HTML',
                        disable_web_page_preview: true
                    }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

                    // Lưu ngay thời gian gửi vào file sent_ema.json
                    updateAndSaveLog(sig.symbol, cooldownKey, now);
                } else {
                    const remainMin = Math.ceil((COOLDOWN_TIME - (now - lastSent)) / 60000);
                    console.log(`⏳ Bỏ qua ${sig.symbol} (LONG - ${sig.subType}) - Đang cooldown (còn ${remainMin} phút).`);
                }
            }
            await sleep(100);
        }

        console.log('--- HOÀN THÀNH QUÉT LONG ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

main();
