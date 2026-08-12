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

// Cấu hình Cooldown: 2 TIẾNG
const COOLDOWN_TIME = 2 * 60 * 60 * 1000; 
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

// Ghi file 24h.json (Lưu danh sách Nhóm A)
function save24hJson(groupedData) {
    try {
        const dataToSave = {
            updatedAt: new Date().toISOString(),
            counts: {
                groupNeg8ToNeg3: groupedData.groupNeg8ToNeg3.length
            },
            data: groupedData
        };
        fs.writeFileSync(FILE_24H, JSON.stringify(dataToSave, null, 2), 'utf8');
        console.log(`💾 Đã lưu phân loại NHÓM A SHORT diffEMA vào ${FILE_24H}`);
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

// ------------------- HÀM TÍNH BIẾN ĐỘNG 60H -------------------
function calculateVol60h(raw1H) {
    if (!raw1H || raw1H.length < 60) return null;

    // Biến động 60h (%) = (Giá đóng nến vừa qua raw1H[1] - Giá đóng nến thứ 60 raw1H[59]) / raw1H[59] * 100
    const close1 = parseFloat(raw1H[1][4]);
    const close60 = parseFloat(raw1H[59][4]);

    if (close60 === 0) return null;
    return ((close1 - close60) / close60) * 100;
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

        if (!res1H.data || res1H.data.code !== '0' || res1H.data.data.length < 60) return null;

        const raw1H = res1H.data.data;

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

// ------------------- KIỂM TRA ĐIỀU KIỆN SHORT NẾN ĐANG CHẠY (NHÓM A) -------------------

// NHÓM A (-8% < diffEMA < -3%, -8% < Vol60h < 8%) 
// -> ĐIỀU KIỆN SHORT:
// 1. Độ rộng Bollinger Band của 20 nến 1H đã đóng: Hbb = (upper - lower) / upper > 3%
// 2. Giá High nến hiện tại sát BB Upper: -0.5% < diffbbu < 2%
function checkSignalGroupA(coinData) {
    const { raw1H } = coinData;
    const candle0 = raw1H[0];
    const highPrice0 = parseFloat(candle0[2]); // Lấy giá cao nhất (high0) của nến hiện tại

    // Lấy 20 nến 1H vừa mới ĐÓNG (raw1H[1] đến raw1H[20])
    const closedForBB = raw1H.slice(1, 21).reverse().map(c => parseFloat(c[4]));
    const bb = calculateBollingerBands(closedForBB, 20);
    if (!bb || bb.upper === 0) return null;

    // Tính độ rộng Bollinger Band (Hbb)
    const hBB = ((bb.upper - bb.lower) / bb.upper) * 100;
    
    // Điều kiện 1: Hbb phải lớn hơn 3%
    if (hBB <= 3) return null;

    // Tính khoảng cách giữa High nến hiện tại và BB Upper
    const diffbbu = ((highPrice0 - bb.upper) / bb.upper) * 100;
    
    // Điều kiện 2: Dung sai: -0.5% < diffbbu < 2%
    if (diffbbu > -0.5 && diffbbu < 2) {
        return { 
            type: 'SHORT', 
            diffBB: diffbbu, 
            hBB: hBB,
            targetBB: 'BB Upper' 
        };
    }
    return null;
}

// ------------------- HÀM CHÍNH -------------------
async function main() {
    try {
        console.log('--- BẮT ĐẦU TIẾN TRÌNH QUÉT THỊ TRƯỜNG (NHÓM A SHORT) ---');

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

        // BƯỚC 3: Phân loại NHÓM A (-8% < diffEMA < -3% AND -8% < Vol60h < 8%)
        const groupA = calculatedCoins.filter(c => {
            if (c.diffEMA <= -8 || c.diffEMA >= -3) return false;

            const vol60h = calculateVol60h(c.raw1H);
            if (vol60h === null) return false;

            c.vol60h = vol60h;

            return vol60h > -8 && vol60h < 8;
        });

        // Định dạng lưu file
        const formatItemA = c => ({
            symbol: c.symbol,
            diffEMA: parseFloat(c.diffEMA.toFixed(2)),
            vol60h: parseFloat(c.vol60h.toFixed(2)),
            volCcy24h: c.volCcy24h
        });

        const groupedForSave = {
            groupNeg8ToNeg3: groupA.map(formatItemA)
        };

        // BƯỚC 4: Ghi vào file 24h.json
        save24hJson(groupedForSave);

        // BƯỚC 5: Xử lý và Báo Tín Hiệu SHORT
        const sendAlert = async (symbol, type, diffEmaVal, cooldownKey, extraData = {}) => {
            if (!sentLog[symbol]) sentLog[symbol] = {};
            const lastSent = sentLog[symbol][cooldownKey] || 0;

            if (currentTime - lastSent >= COOLDOWN_TIME) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                let message = `🔴 <b>${coinName} (${type})</b>\n` +
                              `• DiffEMA: <b>${diffEmaVal > 0 ? '+' : ''}${diffEmaVal.toFixed(2)}%</b>\n`;

                if (extraData.hBB !== undefined) {
                    message += `• Hbb (BB Width): <b>${extraData.hBB.toFixed(2)}%</b>\n`;
                }

                if (extraData.vol60h !== undefined) {
                    message += `• Vol 60h: <b>${extraData.vol60h > 0 ? '+' : ''}${extraData.vol60h.toFixed(2)}%</b>\n`;
                }

                message += `• <a href="${link}">Trade trên OKX</a>`;

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

        // BƯỚC 6: Quét NHÓM A (-8% < diffEMA < -3%, -8% < Vol60h < 8%)
        console.log(`🔍 Quét NHÓM A (-8% < diffEMA < -3%) (${groupA.length} coins)...`);
        for (const item of groupA) {
            const sig = checkSignalGroupA(item);
            if (sig) {
                await sendAlert(item.symbol, 'SHORT', item.diffEMA, '_short1h', { 
                    vol60h: item.vol60h,
                    hBB: sig.hBB 
                });
            }
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

main();
