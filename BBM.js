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
const FILE_24H = path.join(__dirname, '24h.json');

// Cấu hình Cooldown: 8 TIẾNG
const COOLDOWN_TIME = 8 * 60 * 60 * 1000; 
const MIN_VOLUME_USDT = 5000000; // 5 Triệu USDT

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
            if (timeData._long1h && now - timeData._long1h < COOLDOWN_TIME) {
                temp._long1h = timeData._long1h;
            }
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

// Ghi file 24h.json phân chia các nhóm LONG
function save24hJson(groupedData) {
    try {
        const dataToSave = {
            updatedAt: new Date().toISOString(),
            counts: {
                group6To10: groupedData.group6To10.length,
                groupAbove10: groupedData.groupAbove10.length
            },
            data: groupedData
        };
        fs.writeFileSync(FILE_24H, JSON.stringify(dataToSave, null, 2), 'utf8');
        console.log(`💾 Đã lưu các nhóm diffEMA LONG vào ${FILE_24H}`);
    } catch (e) {
        console.error('Lỗi khi ghi file 24h.json:', e.message);
    }
}

// ------------------- HÀM TÍNH EMA & BOLLINGER BANDS -------------------
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

// ------------------- LẤY DANH SÁCH COIN VOLUME > 5M USDT -------------------
async function getHighVolumeCoins() {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const res = await axios.get(url, { timeout: 10000 });
        if (!res.data || res.data.code !== '0') return [];

        const tickers = res.data.data;
        return tickers.filter(item => {
            if (!item.instId.endsWith('-USDT-SWAP')) return false;
            const volCcy = parseFloat(item.volCcy24h || 0);
            return volCcy >= MIN_VOLUME_USDT;
        }).map(item => ({
            instId: item.instId,
            volCcy24h: parseFloat(item.volCcy24h || 0)
        }));
    } catch (error) {
        console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
        return [];
    }
}

// ------------------- TÍNH DIFF EMA CHO TẤT CẢ COIN -------------------
async function getCoinDataWithDiffEma(symbol, volCcy24h) {
    try {
        const url1H = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=60`;
        const res1H = await axios.get(url1H, { timeout: 5000 });

        if (!res1H.data || res1H.data.code !== '0' || res1H.data.data.length < 45) return null;

        const raw1H = res1H.data.data; // Index 0: nến đang chạy

        // Bỏ nến 0 đang chạy, đảo ngược chuỗi các nến ĐÃ ĐÓNG để tính EMA
        const closedPrices = raw1H.slice(1).reverse().map(c => parseFloat(c[4]));

        const ema20_1 = calculateEMA(closedPrices, 20);

        const closedPrices20Ago = closedPrices.slice(0, closedPrices.length - 20);
        const ema20_20Ago = calculateEMA(closedPrices20Ago, 20);

        if (!ema20_1 || !ema20_20Ago) return null;

        const diffEMA = ((ema20_1 - ema20_20Ago) / ema20_20Ago) * 100;

        return {
            symbol,
            volCcy24h,
            diffEMA,
            raw1H
        };
    } catch (error) {
        console.error(`Lỗi tính diffEMA (${symbol}):`, error.message);
        return null;
    }
}

// ------------------- KIỂM TRA ĐIỀU KIỆN LONG NẾN ĐANG CHẠY (INDEX 0) -------------------

// 1. Nhóm 6% < diffEMA < 10% -> LONG khi Low0 (nến đang chạy) sát BB Lower (diffbbl < 0.7%)
function checkSignalGroup6To10(coinData) {
    const { raw1H } = coinData;
    const candle0 = raw1H[0]; // Nến HIỆN TẠI ĐANG CHẠY
    const low0 = parseFloat(candle0[3]);

    // Tính BB20 từ 20 nến vừa đóng (Index 1 đến 20)
    const closedForBB = raw1H.slice(1, 21).reverse().map(c => parseFloat(c[4]));
    const bb = calculateBollingerBands(closedForBB, 20);
    if (!bb) return null;

    const diffbbl = ((low0 - bb.lower) / bb.lower) * 100;

    // Cập nhật điều kiện: -0.7% < diffbbu < 1% (áp dụng kiểm tra biên độ sát dải BB)
    if (diffbbl > -0.7 && diffbbl < 1.0) {
        return { type: 'LONG', diffBB: diffbbl, targetBB: 'BB Dưới' };
    }
    return null;
}

// 2. Nhóm diffEMA >= 10% -> LONG khi Low0 (nến đang chạy) sát BB Middle (diffbbm < 0.7%)
function checkSignalGroupAbove10(coinData) {
    const { raw1H } = coinData;
    const candle0 = raw1H[0]; // Nến HIỆN TẠI ĐANG CHẠY
    const low0 = parseFloat(candle0[3]);

    const closedForBB = raw1H.slice(1, 21).reverse().map(c => parseFloat(c[4]));
    const bb = calculateBollingerBands(closedForBB, 20);
    if (!bb) return null;

    const diffbbm = ((low0 - bb.middle) / bb.middle) * 100;

    // Cập nhật điều kiện: -0.7% < diffbbm < 1%
    if (diffbbm > -0.7 && diffbbm < 1.0) {
        return { type: 'LONG', diffBB: diffbbm, targetBB: 'BB Giữa' };
    }
    return null;
}

// ------------------- HÀM CHÍNH -------------------
async function main() {
    try {
        console.log('--- BẤT ĐẦU TIẾN TRÌNH QUÉT THỊ TRƯỜNG (CHỈ LONG) ---');

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        // BƯỚC 1: Lấy các coin có Volume > 5M USDT
        const highVolCoins = await getHighVolumeCoins();
        console.log(`📋 Tìm thấy ${highVolCoins.length} coins có Vol 24h > 5M USDT...`);

        // BƯỚC 2: Tính diffEMA cho tất cả coin vừa lọc được
        console.log('⏳ Đang tính diffEMA cho các coin...');
        const calculatedCoins = [];

        for (const coin of highVolCoins) {
            const data = await getCoinDataWithDiffEma(coin.instId, coin.volCcy24h);
            if (data) calculatedCoins.push(data);
            await sleep(80); // Rate limit API OKX
        }

        // BƯỚC 3: Phân loại nhóm diffEMA LONG
        const group6To10 = calculatedCoins.filter(c => c.diffEMA > 6 && c.diffEMA < 10);
        const groupAbove10 = calculatedCoins.filter(c => c.diffEMA >= 10);

        // Dữ liệu định dạng lưu file JSON
        const formatItem = c => ({
            symbol: c.symbol,
            diffEMA: parseFloat(c.diffEMA.toFixed(2)),
            volCcy24h: c.volCcy24h
        });

        const groupedForSave = {
            group6To10: group6To10.map(formatItem),
            groupAbove10: groupAbove10.map(formatItem)
        };

        // BƯỚC 4: Ghi vào file 24h.json
        save24hJson(groupedForSave);

        // BƯỚC 5: Xử lý và Báo Tín Hiệu LONG

        const sendAlert = async (symbol, type, diffEmaVal, diffBBVal, targetBB, cooldownKey) => {
            if (!sentLog[symbol]) sentLog[symbol] = {};
            const lastSent = sentLog[symbol][cooldownKey] || 0;

            if (currentTime - lastSent >= COOLDOWN_TIME) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                const message = `🟢 <b>${type} TÍN HIỆU #${coinName} 1H (Nến đang chạy)</b>\n` +
                                `diffEMA 1H: <b>+${diffEmaVal.toFixed(2)}%</b>\n` +
                                `Nến đang chạy sát ${targetBB}: <code>${diffBBVal.toFixed(2)}%</code>\n` +
                                `👉 <a href="${link}">Trade trên OKX</a>`;

                console.log(`🚀 [${type} MATCHED] Gửi Telegram cho ${symbol}...`);
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML'
                }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

                sentLog[symbol][cooldownKey] = currentTime;
                hasNewAlert = true;
            }
        };

        // 1. Quét LONG nhóm 6% < diffEMA < 10%
        console.log(`🔍 Quét LONG Nhóm 6% < diffEMA < 10% (${group6To10.length} coins)...`);
        for (const item of group6To10) {
            const sig = checkSignalGroup6To10(item);
            if (sig) await sendAlert(item.symbol, 'LONG', item.diffEMA, sig.diffBB, sig.targetBB, '_long1h');
        }

        // 2. Quét LONG nhóm diffEMA >= 10%
        console.log(`🔍 Quét LONG Nhóm diffEMA >= 10% (${groupAbove10.length} coins)...`);
        for (const item of groupAbove10) {
            const sig = checkSignalGroupAbove10(item);
            if (sig) await sendAlert(item.symbol, 'LONG', item.diffEMA, sig.diffBB, sig.targetBB, '_long1h');
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

main();
