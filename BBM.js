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
const MIN_VOLUME_USDT = 10000000; // 10 Triệu USDT

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
            if (timeData._short4h && now - timeData._short4h < COOLDOWN_TIME) {
                temp._short4h = timeData._short4h;
            }
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

// Ghi file 24h.json (Lưu Nhóm A & Nhóm B)
function save24hJson(groupedData) {
    try {
        const dataToSave = {
            updatedAt: new Date().toISOString(),
            counts: {
                groupA: groupedData.groupA.length,
                groupB: groupedData.groupB.length
            },
            data: groupedData
        };
        fs.writeFileSync(FILE_24H, JSON.stringify(dataToSave, null, 2), 'utf8');
        console.log(`💾 Đã lưu phân loại Nhóm A & Nhóm B vào ${FILE_24H}`);
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

// Tính diffEMA dựa trên danh sách giá đóng cửa
function calculateDiffEMA(closedPrices) {
    if (closedPrices.length < 40) return null;
    const ema20_1 = calculateEMA(closedPrices, 20);
    const closedPrices20Ago = closedPrices.slice(0, closedPrices.length - 20);
    const ema20_20Ago = calculateEMA(closedPrices20Ago, 20);

    if (!ema20_1 || !ema20_20Ago) return null;
    return ((ema20_1 - ema20_20Ago) / ema20_20Ago) * 100;
}

// ------------------- LẤY DANH SÁCH COIN VOLUME > 10M USDT -------------------
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

// ------------------- LẤY NẾN 1H VÀ 4H DÀNH CHO MỖI COIN -------------------
async function fetchCoinCandles(symbol, volCcy24h) {
    try {
        // Fetch 1H Candles
        const url1H = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=60`;
        const res1H = await axios.get(url1H, { timeout: 5000 });

        if (!res1H.data || res1H.data.code !== '0' || res1H.data.data.length < 60) return null;
        const raw1H = res1H.data.data;
        const closedPrices1H = raw1H.slice(1).reverse().map(c => parseFloat(c[4]));
        const diffEMA1h = calculateDiffEMA(closedPrices1H);

        // Fetch 4H Candles
        const url4H = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=4H&limit=60`;
        const res4H = await axios.get(url4H, { timeout: 5000 });

        let raw4H = null;
        let diffEMA4h = null;
        if (res4H.data && res4H.data.code === '0' && res4H.data.data.length >= 60) {
            raw4H = res4H.data.data;
            const closedPrices4H = raw4H.slice(1).reverse().map(c => parseFloat(c[4]));
            diffEMA4h = calculateDiffEMA(closedPrices4H);
        }

        return {
            symbol,
            volCcy24h,
            diffEMA1h,
            diffEMA4h,
            raw1H,
            raw4H
        };
    } catch (error) {
        console.error(`Lỗi lấy dữ liệu nến (${symbol}):`, error.message);
        return null;
    }
}

// ------------------- KIỂM TRA ĐIỀU KIỆN SHORT -------------------

// Kiểm tra tín hiệu SHORT 1H (Nhóm A): -1% < diffbbm1h < 2%
function checkSignalShort1H(coinData) {
    const { raw1H } = coinData;
    const candle0 = raw1H[0];
    const highPrice0 = parseFloat(candle0[2]);

    const closedForBB = raw1H.slice(1, 21).reverse().map(c => parseFloat(c[4]));
    const bb = calculateBollingerBands(closedForBB, 20);
    if (!bb) return null;

    const diffbbm1h = ((highPrice0 - bb.middle) / bb.middle) * 100;
    
    if (diffbbm1h > -1 && diffbbm1h < 2) {
        return { type: 'SHORT 1H', diffBB: diffbbm1h };
    }
    return null;
}

// Kiểm tra tín hiệu SHORT 4H (Nhóm B): -2% < diffbbm4h < 2%
function checkSignalShort4H(coinData) {
    const { raw4H } = coinData;
    if (!raw4H) return null;

    const candle0 = raw4H[0];
    const highPrice0 = parseFloat(candle0[2]);

    const closedForBB = raw4H.slice(1, 21).reverse().map(c => parseFloat(c[4]));
    const bb = calculateBollingerBands(closedForBB, 20);
    if (!bb) return null;

    const diffbbm4h = ((highPrice0 - bb.middle) / bb.middle) * 100;

    if (diffbbm4h > -2 && diffbbm4h < 2) {
        return { type: 'SHORT 4H', diffBB: diffbbm4h };
    }
    return null;
}

// ------------------- HÀM CHÍNH -------------------
async function main() {
    try {
        console.log('--- BẮT ĐẦU TIẾN TRÌNH QUÉT THỊ TRƯỜNG ---');

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        // BƯỚC 1: Lấy các coin có Volume > 10M USDT
        const highVolCoins = await getHighVolumeCoins();
        console.log(`📋 Tìm thấy ${highVolCoins.length} coins có Vol 24h > 10M USDT...`);

        // BƯỚC 2: Lấy nến 1H & 4H cho từng coin
        console.log('⏳ Đang lấy dữ liệu nến 1H và 4H...');
        const fullDataCoins = [];

        for (const coin of highVolCoins) {
            const data = await fetchCoinCandles(coin.instId, coin.volCcy24h);
            if (data) fullDataCoins.push(data);
            await sleep(80);
        }

        // BƯỚC 3: Phân loại Nhóm A và Nhóm B
        // Nhóm A: diffEMA1h < -8%
        const groupA = fullDataCoins.filter(c => c.diffEMA1h !== null && c.diffEMA1h < -8);

        // Nhóm B: diffEMA4h < -10%
        const groupB = fullDataCoins.filter(c => c.diffEMA4h !== null && c.diffEMA4h < -10);

        // Định dạng lưu file
        const formatItem = c => ({
            symbol: c.symbol,
            diffEMA1h: c.diffEMA1h !== null ? parseFloat(c.diffEMA1h.toFixed(2)) : null,
            diffEMA4h: c.diffEMA4h !== null ? parseFloat(c.diffEMA4h.toFixed(2)) : null,
            volCcy24h: c.volCcy24h
        });

        const groupedForSave = {
            groupA: groupA.map(formatItem),
            groupB: groupB.map(formatItem)
        };

        // Ghi vào file 24h.json
        save24hJson(groupedForSave);

        // BƯỚC 4: Xử lý và Báo Tín Hiệu Telegram
        const sendAlert = async (symbol, type, diffEmaVal, cooldownKey) => {
            if (!sentLog[symbol]) sentLog[symbol] = {};
            const lastSent = sentLog[symbol][cooldownKey] || 0;

            if (currentTime - lastSent >= COOLDOWN_TIME) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                const message = `🔴 <b>${coinName} (${type})</b>\n` +
                                `• DiffEMA: <b>${diffEmaVal > 0 ? '+' : ''}${diffEmaVal.toFixed(2)}%</b>\n` +
                                `• <a href="${link}">Trade trên OKX</a>`;

                console.log(`🚀 [${type} MATCHED] Gửi Telegram cho ${symbol}...`);
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

                sentLog[symbol][cooldownKey] = currentTime;
                hasNewAlert = true;
            }
        };

        // 1. Quét NHÓM A -> Báo SHORT 1H
        console.log(`🔍 Quét NHÓM A (diffEMA 1H < -8%) (${groupA.length} coins)...`);
        for (const item of groupA) {
            const sig = checkSignalShort1H(item);
            if (sig) {
                await sendAlert(item.symbol, 'SHORT 1H', item.diffEMA1h, '_short1h');
            }
        }

        // 2. Quét NHÓM B -> Báo SHORT 4H
        console.log(`🔍 Quét NHÓM B (diffEMA 4H < -10%) (${groupB.length} coins)...`);
        for (const item of groupB) {
            const sig = checkSignalShort4H(item);
            if (sig) {
                await sendAlert(item.symbol, 'SHORT 4H', item.diffEMA4h, '_short4h');
            }
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

main();
