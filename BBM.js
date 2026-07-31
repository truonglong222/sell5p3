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

// Ghi file 24h.json (Lưu 3 nhóm SHORT)
function save24hJson(groupedData) {
    try {
        const dataToSave = {
            updatedAt: new Date().toISOString(),
            counts: {
                groupNeg15ToNeg6: groupedData.groupNeg15ToNeg6.length,
                groupBelowNeg15: groupedData.groupBelowNeg15.length,
                groupNeg6ToPos5: groupedData.groupNeg6ToPos5.length
            },
            data: groupedData
        };
        fs.writeFileSync(FILE_24H, JSON.stringify(dataToSave, null, 2), 'utf8');
        console.log(`💾 Đã lưu phân loại 3 nhóm SHORT diffEMA vào ${FILE_24H}`);
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

// 1. Nhóm A (-15% < diffEMA < -6%) -> SHORT khi High0 sát BB Upper: -0.7% < diffbbu < 1%
function checkSignalGroupNeg15ToNeg6(coinData) {
    const { raw1H } = coinData;
    const candle0 = raw1H[0];
    const high0 = parseFloat(candle0[2]);

    const closedForBB = raw1H.slice(1, 21).reverse().map(c => parseFloat(c[4]));
    const bb = calculateBollingerBands(closedForBB, 20);
    if (!bb) return null;

    const diffbbu = ((high0 - bb.upper) / bb.upper) * 100;
    
    if (diffbbu > -0.7 && diffbbu < 1) {
        return { type: 'SHORT', diffBB: diffbbu, targetBB: 'BB Trên' };
    }
    return null;
}

// 2. Nhóm B (diffEMA <= -15%) -> SHORT khi High0 sát BB Middle: -0.5% < diffbbm < 1%
function checkSignalGroupBelowNeg15(coinData) {
    const { raw1H } = coinData;
    const candle0 = raw1H[0];
    const high0 = parseFloat(candle0[2]);

    const closedForBB = raw1H.slice(1, 21).reverse().map(c => parseFloat(c[4]));
    const bb = calculateBollingerBands(closedForBB, 20);
    if (!bb) return null;

    const diffbbm = ((high0 - bb.middle) / bb.middle) * 100;
    
    if (diffbbm > -0.5 && diffbbm < 1) {
        return { type: 'SHORT', diffBB: diffbbm, targetBB: 'BB Giữa' };
    }
    return null;
}

// 3. Nhóm C (-6% < diffEMA < 5%) -> SHORT khi:
// - Sát BB Upper (-0.7% < diffbbu < 1%)
// - Tỷ số x > 3
// - Biến động 60h > 10%
function checkSignalGroupNeg6ToPos5(coinData) {
    const { raw1H } = coinData;
    const candle0 = raw1H[0];
    const high0 = parseFloat(candle0[2]);

    // ------------------- ĐIỀU KIỆN 1: BIẾN ĐỘNG 60H > 10% -------------------
    // Giá cao nhất của nến vừa đóng (index 1)
    const highClosed = parseFloat(raw1H[1][2]);

    // Giá thấp nhất trong 60 nến (index 0 -> 59)
    let minLow60 = Infinity;
    for (let i = 0; i < raw1H.length; i++) {
        const low = parseFloat(raw1H[i][3]);
        if (low < minLow60) {
            minLow60 = low;
        }
    }

    if (minLow60 === 0 || minLow60 === Infinity) return null;

    const vol60h = ((highClosed - minLow60) / minLow60) * 100;
    if (vol60h <= 10) return null; // Loại nếu biến động <= 10%

    // ------------------- ĐIỀU KIỆN 2: SÁT BB UPPER -------------------
    const closedForBB = raw1H.slice(1, 21).reverse().map(c => parseFloat(c[4]));
    const bb = calculateBollingerBands(closedForBB, 20);
    if (!bb) return null;

    const diffbbu = ((high0 - bb.upper) / bb.upper) * 100;
    if (diffbbu <= -0.7 || diffbbu >= 1) return null;

    // ------------------- ĐIỀU KIỆN 3: TỶ SỐ X > 3 -------------------
    // Mẫu số: Trị tuyệt đối trung bình biến động (|High - Low|) 20 nến gần nhất (từ nến 1 đến 20)
    let sumVol20 = 0;
    for (let i = 1; i <= 20 && i < raw1H.length; i++) {
        const h = parseFloat(raw1H[i][2]);
        const l = parseFloat(raw1H[i][3]);
        sumVol20 += Math.abs(h - l);
    }
    const avgVol20 = sumVol20 / 20;
    if (avgVol20 === 0) return null;

    // Tử số: Trị tuyệt đối nến giảm giá lớn nhất (|Open - Close|) trong 60 nến
    let maxBearishBody = 0;
    for (let i = 0; i < raw1H.length; i++) {
        const open = parseFloat(raw1H[i][1]);
        const close = parseFloat(raw1H[i][4]);
        if (close < open) { // Chỉ xét nến giảm
            const body = open - close;
            if (body > maxBearishBody) {
                maxBearishBody = body;
            }
        }
    }

    const x = maxBearishBody / avgVol20;
    if (x <= 3) return null;

    return { 
        type: 'SHORT', 
        diffBB: diffbbu, 
        targetBB: 'BB Trên', 
        ratioX: x, 
        vol60h: vol60h 
    };
}

// ------------------- HÀM CHÍNH -------------------
async function main() {
    try {
        console.log('--- BẮT ĐẦU TIẾN TRÌNH QUÉT THỊ TRƯỜNG (3 NHÓM SHORT) ---');

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

        // BƯỚC 3: Phân loại 3 nhóm diffEMA SHORT
        const groupNeg15ToNeg6 = calculatedCoins.filter(c => c.diffEMA > -15 && c.diffEMA < -6);
        const groupBelowNeg15 = calculatedCoins.filter(c => c.diffEMA <= -15);
        const groupNeg6ToPos5 = calculatedCoins.filter(c => c.diffEMA > -6 && c.diffEMA < 5);

        // Định dạng lưu file
        const formatItem = c => ({
            symbol: c.symbol,
            diffEMA: parseFloat(c.diffEMA.toFixed(2)),
            volCcy24h: c.volCcy24h
        });

        const groupedForSave = {
            groupNeg15ToNeg6: groupNeg15ToNeg6.map(formatItem),
            groupBelowNeg15: groupBelowNeg15.map(formatItem),
            groupNeg6ToPos5: groupNeg6ToPos5.map(formatItem)
        };

        // BƯỚC 4: Ghi vào file 24h.json
        save24hJson(groupedForSave);

        // BƯỚC 5: Xử lý và Báo Tín Hiệu SHORT
        const sendAlert = async (symbol, type, diffEmaVal, diffBBVal, targetBB, cooldownKey, extraData = {}) => {
            if (!sentLog[symbol]) sentLog[symbol] = {};
            const lastSent = sentLog[symbol][cooldownKey] || 0;

            if (currentTime - lastSent >= COOLDOWN_TIME) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
                const icon = '🔴';

                let extraInfo = '';
                if (extraData.ratioX !== undefined) {
                    extraInfo += `Tỷ số X (MaxBear/AvgVol20): <b>${extraData.ratioX.toFixed(2)}</b>\n`;
                }
                if (extraData.vol60h !== undefined) {
                    extraInfo += `Biến động 60h: <b>+${extraData.vol60h.toFixed(2)}%</b>\n`;
                }

                const message = `${icon} <b>${type} TÍN HIỆU #${coinName} 1H (Nến đang chạy)</b>\n` +
                                `diffEMA 1H: <b>${diffEmaVal > 0 ? '+' : ''}${diffEmaVal.toFixed(2)}%</b>\n` +
                                `Nến đang chạy sát ${targetBB}: <code>${diffBBVal.toFixed(2)}%</code>\n` +
                                extraInfo +
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

        // 1. Quét SHORT Nhóm A (-15% < diffEMA < -6%)
        console.log(`🔍 Quét SHORT Nhóm A (-15% < diffEMA < -6%) (${groupNeg15ToNeg6.length} coins)...`);
        for (const item of groupNeg15ToNeg6) {
            const sig = checkSignalGroupNeg15ToNeg6(item);
            if (sig) await sendAlert(item.symbol, 'SHORT', item.diffEMA, sig.diffBB, sig.targetBB, '_short1h');
        }

        // 2. Quét SHORT Nhóm B (diffEMA <= -15%)
        console.log(`🔍 Quét SHORT Nhóm B (diffEMA <= -15%) (${groupBelowNeg15.length} coins)...`);
        for (const item of groupBelowNeg15) {
            const sig = checkSignalGroupBelowNeg15(item);
            if (sig) await sendAlert(item.symbol, 'SHORT', item.diffEMA, sig.diffBB, sig.targetBB, '_short1h');
        }

        // 3. Quét SHORT Nhóm C (-6% < diffEMA < 5%)
        console.log(`🔍 Quét SHORT Nhóm C (-6% < diffEMA < 5%) (${groupNeg6ToPos5.length} coins)...`);
        for (const item of groupNeg6ToPos5) {
            const sig = checkSignalGroupNeg6ToPos5(item);
            if (sig) await sendAlert(item.symbol, 'SHORT', item.diffEMA, sig.diffBB, sig.targetBB, '_short1h', { ratioX: sig.ratioX, vol60h: sig.vol60h });
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

main();
