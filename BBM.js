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
            if (timeData._short1h && now - timeData._short1h < COOLDOWN_TIME) {
                temp._short1h = timeData._short1h;
            }
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

// Ghi file 24h.json (Chỉ lưu 2 nhóm SHORT)
function save24hJson(groupedData) {
    try {
        const dataToSave = {
            updatedAt: new Date().toISOString(),
            counts: {
                groupNeg15ToNeg6: groupedData.groupNeg15ToNeg6.length,
                groupBelowNeg15: groupedData.groupBelowNeg15.length
            },
            data: groupedData
        };
        fs.writeFileSync(FILE_24H, JSON.stringify(dataToSave, null, 2), 'utf8');
        console.log(`💾 Đã lưu phân loại 2 nhóm SHORT diffEMA vào ${FILE_24H}`);
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

// ------------------- TÍNH DIFF EMA BÌNH THƯỜNG CHO TẤT CẢ COIN -------------------
async function getCoinDataWithDiffEma(symbol, volCcy24h) {
    try {
        const url1H = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=60`;
        const res1H = await axios.get(url1H, { timeout: 5000 });

        if (!res1H.data || res1H.data.code !== '0' || res1H.data.data.length < 45) return null;

        const raw1H = res1H.data.data;

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

// ------------------- KIỂM TRA ĐIỀU KIỆN SHORT NẾN ĐANG CHẠY -------------------

// 1. Nhóm -15% < diffEMA < -6% -> SHORT khi High0 sát BB Upper (diffbbu > -0.7%)
function checkSignalGroupNeg15ToNeg6(coinData) {
    const { raw1H } = coinData;
    const candle0 = raw1H[0];
    const high0 = parseFloat(candle0[2]);

    const closedForBB = raw1H.slice(1, 21).reverse().map(c => parseFloat(c[4]));
    const bb = calculateBollingerBands(closedForBB, 20);
    if (!bb) return null;

    const diffbbu = ((high0 - bb.upper) / bb.upper) * 100;
    if (diffbbu > -0.7) {
        return { type: 'SHORT', diffBB: diffbbu, targetBB: 'BB Trên' };
    }
    return null;
}

// 2. Nhóm diffEMA <= -15% -> SHORT khi High0 thỏa mãn: -0.7% < diffbbm < 1%
function checkSignalGroupBelowNeg15(coinData) {
    const { raw1H } = coinData;
    const candle0 = raw1H[0];
    const high0 = parseFloat(candle0[2]);

    const closedForBB = raw1H.slice(1, 21).reverse().map(c => parseFloat(c[4]));
    const bb = calculateBollingerBands(closedForBB, 20);
    if (!bb) return null;

    const diffbbm = ((high0 - bb.middle) / bb.middle) * 100;
    
    if (diffbbm > -0.7 && diffbbm < 1) {
        return { type: 'SHORT', diffBB: diffbbm, targetBB: 'BB Giữa' };
    }
    return null;
}

// ------------------- HÀM CHÍNH -------------------
async function main() {
    try {
        console.log('--- BẮT ĐẦU TIẾN TRÌNH QUÉT THỊ TRƯỜNG (CHỈ 2 NHÓM SHORT) ---');

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
            await sleep(80);
        }

        // BƯỚC 3: Phân loại CHỈ 2 nhóm diffEMA SHORT
        const groupNeg15ToNeg6 = calculatedCoins.filter(c => c.diffEMA > -15 && c.diffEMA < -6);
        const groupBelowNeg15 = calculatedCoins.filter(c => c.diffEMA <= -15);

        // Định dạng lưu file
        const formatItem = c => ({
            symbol: c.symbol,
            diffEMA: parseFloat(c.diffEMA.toFixed(2)),
            volCcy24h: c.volCcy24h
        });

        const groupedForSave = {
            groupNeg15ToNeg6: groupNeg15ToNeg6.map(formatItem),
            groupBelowNeg15: groupBelowNeg15.map(formatItem)
        };

        // BƯỚC 4: Ghi vào file 24h.json
        save24hJson(groupedForSave);

        // BƯỚC 5: Xử lý và Báo Tín Hiệu SHORT
        const sendAlert = async (symbol, type, diffEmaVal, diffBBVal, targetBB, cooldownKey) => {
            if (!sentLog[symbol]) sentLog[symbol] = {};
            const lastSent = sentLog[symbol][cooldownKey] || 0;

            if (currentTime - lastSent >= COOLDOWN_TIME) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
                const icon = '🔴';

                const message = `${icon} <b>${type} TÍN HIỆU #${coinName} 1H (Nến đang chạy)</b>\n` +
                                `diffEMA 1H: <b>${diffEmaVal > 0 ? '+' : ''}${diffEmaVal.toFixed(2)}%</b>\n` +
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

        // 1. Quét SHORT nhóm -15% < diffEMA < -6%
        console.log(`🔍 Quét SHORT Nhóm -15% < diffEMA < -6% (${groupNeg15ToNeg6.length} coins)...`);
        for (const item of groupNeg15ToNeg6) {
            const sig = checkSignalGroupNeg15ToNeg6(item);
            if (sig) await sendAlert(item.symbol, 'SHORT', item.diffEMA, sig.diffBB, sig.targetBB, '_short1h');
        }

        // 2. Quét SHORT nhóm diffEMA <= -15%
        console.log(`🔍 Quét SHORT Nhóm diffEMA <= -15% (${groupBelowNeg15.length} coins)...`);
        for (const item of groupBelowNeg15) {
            const sig = checkSignalGroupBelowNeg15(item);
            if (sig) await sendAlert(item.symbol, 'SHORT', item.diffEMA, sig.diffBB, sig.targetBB, '_short1h');
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

main();
