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

// Ghi file 24h.json (Lưu 2 nhóm SHORT)
function save24hJson(groupedData) {
    try {
        const dataToSave = {
            updatedAt: new Date().toISOString(),
            counts: {
                groupBelowNeg8: groupedData.groupBelowNeg8.length,
                groupNeg8ToNeg4: groupedData.groupNeg8ToNeg4.length
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

// ------------------- HÀM TÍNH TỶ SỐ X VÀ BIẾN ĐỘNG 60H -------------------
function calculateXAndVol60h(raw1H) {
    if (!raw1H || raw1H.length < 60) return null;

    // 1. Biến động 60h (%) = (Giá đóng nến vừa qua raw1H[1] - Giá đóng nến thứ 60 raw1H[59]) / raw1H[59] * 100
    const close1 = parseFloat(raw1H[1][4]);
    const close60 = parseFloat(raw1H[59][4]);

    if (close60 === 0) return null;
    const vol60h = ((close1 - close60) / close60) * 100;

    // 2. Tính Tỷ số X = (Low - High) của nến giảm âm nhất trong 40 NẾN GẦN NHẤT / Trung bình |Open - Close| 20 nến
    let sumBody20 = 0;
    for (let i = 1; i <= 20 && i < raw1H.length; i++) {
        const open = parseFloat(raw1H[i][1]);
        const close = parseFloat(raw1H[i][4]);
        sumBody20 += Math.abs(open - close);
    }
    const avgBody20 = sumBody20 / 20;
    if (avgBody20 === 0) return null;

    let minLowHighBearish = 0; 
    const maxCandlesToCheck = Math.min(40, raw1H.length);

    for (let i = 0; i < maxCandlesToCheck; i++) {
        const open = parseFloat(raw1H[i][1]);
        const high = parseFloat(raw1H[i][2]);
        const low = parseFloat(raw1H[i][3]);
        const close = parseFloat(raw1H[i][4]);

        if (close < open) { // Chỉ xét nến giảm
            const lowMinusHigh = low - high; // Luôn <= 0
            if (lowMinusHigh < minLowHighBearish) {
                minLowHighBearish = lowMinusHigh;
            }
        }
    }

    const ratioX = minLowHighBearish / avgBody20;

    return { vol60h, ratioX };
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

// ------------------- KIỂM TRA ĐIỀU KIỆN SHORT NẾN ĐANG CHẠY -------------------

// 1. NHÓM A (-24% < diffEMA < -8%) -> SHORT khi Giá High nến hiện tại sát BB Middle: -0.5% < diffbbm < 1%
function checkSignalGroupBelowNeg8(coinData) {
    const { raw1H } = coinData;
    const candle0 = raw1H[0];
    const highPrice0 = parseFloat(candle0[2]); // Lấy giá cao nhất (high0) của nến hiện tại

    const closedForBB = raw1H.slice(1, 21).reverse().map(c => parseFloat(c[4]));
    const bb = calculateBollingerBands(closedForBB, 20);
    if (!bb) return null;

    const diffbbm = ((highPrice0 - bb.middle) / bb.middle) * 100;
    
    // Điều kiện mới: -0.5% < diffbbm < 1%
    if (diffbbm > -0.5 && diffbbm < 1) {
        return { type: 'SHORT', diffBB: diffbbm, targetBB: 'BB Mid' };
    }
    return null;
}

// 2. NHÓM B (-8% < diffEMA < -4%, Vol60h > -10%, X < -3) -> SHORT khi Giá High nến hiện tại sát BB Upper: -0.5% < diffbbu < 1%
function checkSignalGroupNeg8ToNeg4(coinData) {
    const { raw1H } = coinData;
    const candle0 = raw1H[0];
    const highPrice0 = parseFloat(candle0[2]); // Lấy giá cao nhất (high0) của nến hiện tại

    const closedForBB = raw1H.slice(1, 21).reverse().map(c => parseFloat(c[4]));
    const bb = calculateBollingerBands(closedForBB, 20);
    if (!bb) return null;

    const diffbbu = ((highPrice0 - bb.upper) / bb.upper) * 100;
    
    // Điều kiện mới: -0.5% < diffbbu < 1%
    if (diffbbu > -0.5 && diffbbu < 1) {
        return { type: 'SHORT', diffBB: diffbbu, targetBB: 'BB Upper' };
    }
    return null;
}

// ------------------- HÀM CHÍNH -------------------
async function main() {
    try {
        console.log('--- BẮT ĐẦU TIẾN TRÌNH QUÉT THỊ TRƯỜNG (2 NHÓM SHORT) ---');

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

        // BƯỚC 3: Phân loại 2 nhóm diffEMA SHORT
        
        // NHÓM A: -24% < diffEMA < -8%
        const groupBelowNeg8 = calculatedCoins.filter(c => c.diffEMA > -24 && c.diffEMA < -8);

        // NHÓM B: -8% < diffEMA < -4% AND Vol60h > -10% AND X < -3
        const groupNeg8ToNeg4 = calculatedCoins.filter(c => {
            if (c.diffEMA <= -8 || c.diffEMA >= -4) return false;

            const metrics = calculateXAndVol60h(c.raw1H);
            if (!metrics) return false;

            c.vol60h = metrics.vol60h;
            c.ratioX = metrics.ratioX;

            return metrics.vol60h > -10 && metrics.ratioX < -3;
        });

        // Định dạng lưu file
        const formatItemA = c => ({
            symbol: c.symbol,
            diffEMA: parseFloat(c.diffEMA.toFixed(2)),
            volCcy24h: c.volCcy24h
        });

        const formatItemB = c => ({
            symbol: c.symbol,
            diffEMA: parseFloat(c.diffEMA.toFixed(2)),
            vol60h: parseFloat(c.vol60h.toFixed(2)),
            ratioX: parseFloat(c.ratioX.toFixed(2)),
            volCcy24h: c.volCcy24h
        });

        const groupedForSave = {
            groupBelowNeg8: groupBelowNeg8.map(formatItemA),
            groupNeg8ToNeg4: groupNeg8ToNeg4.map(formatItemB)
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
                              `• DiffEMA: <b>${diffEmaVal > 0 ? '+' : ''}${diffEmaVal.toFixed(2)}%</b>\n` +
                              `• <a href="${link}">Trade trên OKX</a>`;

                if (extraData.ratioX !== undefined && extraData.vol60h !== undefined) {
                    message += `\n• X: <b>${extraData.ratioX.toFixed(2)}</b> | Vol 60h: <b>+${extraData.vol60h.toFixed(2)}%</b>`;
                }

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

        // 1. Quét NHÓM A (-24% < diffEMA < -8% & giá sát BB Mid)
        console.log(`🔍 Quét NHÓM A (-24% < diffEMA < -8%) (${groupBelowNeg8.length} coins)...`);
        for (const item of groupBelowNeg8) {
            const sig = checkSignalGroupBelowNeg8(item);
            if (sig) {
                await sendAlert(item.symbol, 'SHORT', item.diffEMA, '_short1h');
            }
        }

        // 2. Tiếp tục quét NHÓM B (-8% < diffEMA < -4%, Vol60h > -10%, X < -3)
        console.log(`🔍 Quét NHÓM B (-8% < diffEMA < -4%) (${groupNeg8ToNeg4.length} coins)...`);
        for (const item of groupNeg8ToNeg4) {
            const sig = checkSignalGroupNeg8ToNeg4(item);
            if (sig) {
                await sendAlert(item.symbol, 'SHORT', item.diffEMA, '_short1h', { ratioX: item.ratioX, vol60h: item.vol60h });
            }
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

main();
