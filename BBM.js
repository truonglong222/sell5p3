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

// Cấu hình Cooldown: 4 tiếng
const COOLDOWN_TIME = 4 * 60 * 60 * 1000;
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
            if (timeData._short1h && now - timeData._short1h < COOLDOWN_TIME) {
                temp._short1h = timeData._short1h;
            }
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

function save24hJson(topMaxDiffEma, topMinDiffEma) {
    try {
        const dataToSave = {
            updatedAt: new Date().toISOString(),
            totalMaxDiffEma: topMaxDiffEma.length,
            totalMinDiffEma: topMinDiffEma.length,
            top20MaxDiffEma: topMaxDiffEma,
            top40MinDiffEma: topMinDiffEma
        };
        fs.writeFileSync(FILE_24H, JSON.stringify(dataToSave, null, 2), 'utf8');
        console.log(`💾 Đã lưu Top ${topMaxDiffEma.length} Max diffEMA và Top ${topMinDiffEma.length} Min diffEMA vào ${FILE_24H}`);
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
        const validCoins = tickers.filter(item => {
            if (!item.instId.endsWith('-USDT-SWAP')) return false;
            const volCcy = parseFloat(item.volCcy24h || 0);
            return volCcy >= MIN_VOLUME_USDT;
        }).map(item => ({
            instId: item.instId,
            volCcy24h: parseFloat(item.volCcy24h || 0)
        }));

        return validCoins;
    } catch (error) {
        console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
        return [];
    }
}

// ------------------- TÍNH DIFF EMA BÌNH THƯỜNG DÀNH CHO TẤT CẢ COIN -------------------
async function getCoinDataWithDiffEma(symbol, volCcy24h) {
    try {
        // Lấy 60 nến 1H
        const url1H = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=60`;
        const res1H = await axios.get(url1H, { timeout: 5000 });

        if (!res1H.data || res1H.data.code !== '0' || res1H.data.data.length < 45) return null;

        const raw1H = res1H.data.data; // Index 0 là nến đang chạy, 1 là nến vừa đóng...

        // Lấy giá đóng cửa từ nến n=1 trở về quá khứ (đảo ngược để tính EMA theo thứ tự thời gian)
        const closedPrices = raw1H.slice(1).reverse().map(c => parseFloat(c[4]));

        // EMA20 tại nến số 1
        const ema20_1 = calculateEMA(closedPrices, 20);

        // EMA20 tại nến cách đó 20 phiên (bỏ đi 20 nến gần nhất)
        const closedPrices20Ago = closedPrices.slice(0, closedPrices.length - 20);
        const ema20_20Ago = calculateEMA(closedPrices20Ago, 20);

        if (!ema20_1 || !ema20_20Ago) return null;

        const diffEMA = ((ema20_1 - ema20_20Ago) / ema20_20Ago) * 100;

        return {
            symbol,
            volCcy24h,
            diffEMA,
            raw1H // Giữ lại raw1H để dùng kiểm tra điều kiện Long/Short sau này
        };
    } catch (error) {
        console.error(`Lỗi tính diffEMA (${symbol}):`, error.message);
        return null;
    }
}

// ------------------- KIỂM TRA ĐIỀU KIỆN LONG -------------------
function checkLongCondition(coinData) {
    const { raw1H } = coinData;

    // 1. Nến vừa đóng (nến số 1) là nến tăng (close1 > open1)
    const candle1 = raw1H[1];
    const open1 = parseFloat(candle1[1]);
    const close1 = parseFloat(candle1[4]);
    if (close1 <= open1) return null;

    // 2. Nến số 2 (index 2): Low2 sát Bollinger Bands Dưới (diffbbl < 0.5%)
    const candle2 = raw1H[2];
    const low2 = parseFloat(candle2[3]);

    const closedForBB2 = raw1H.slice(2, 22).reverse().map(c => parseFloat(c[4]));
    const bb2 = calculateBollingerBands(closedForBB2, 20);
    if (!bb2) return null;

    // diffbbl = ((low2 - lower2) / lower2) * 100
    const diffbbl = ((low2 - bb2.lower) / bb2.lower) * 100;

    if (diffbbl < 0.5) {
        return {
            type: 'LONG',
            diffBB: diffbbl,
            low2,
            bbLower: bb2.lower
        };
    }
    return null;
}

// ------------------- KIỂM TRA ĐIỀU KIỆN SHORT -------------------
function checkShortCondition(coinData) {
    const { raw1H } = coinData;

    // 1. Nến vừa đóng (nến số 1) là nến giảm (close1 < open1)
    const candle1 = raw1H[1];
    const open1 = parseFloat(candle1[1]);
    const close1 = parseFloat(candle1[4]);
    if (close1 >= open1) return null;

    // 2. Nến số 2 (index 2): High2 sát Bollinger Bands Trên (diffbbu > -0.5%)
    const candle2 = raw1H[2];
    const high2 = parseFloat(candle2[2]);

    const closedForBB2 = raw1H.slice(2, 22).reverse().map(c => parseFloat(c[4]));
    const bb2 = calculateBollingerBands(closedForBB2, 20);
    if (!bb2) return null;

    // diffbbu = ((high2 - upper2) / upper2) * 100
    const diffbbu = ((high2 - bb2.upper) / bb2.upper) * 100;

    if (diffbbu > -0.5) {
        return {
            type: 'SHORT',
            diffBB: diffbbu,
            high2,
            bbUpper: bb2.upper
        };
    }
    return null;
}

// ------------------- HÀM CHÍNH -------------------
async function main() {
    try {
        console.log('--- BẤT ĐẦU TIẾN TRÌNH QUÉT THỊ TRƯỜNG ---');

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        // BƯỚC 1: Lấy các coin có Volume > 5M USDT
        const highVolCoins = await getHighVolumeCoins();
        console.log(`📋 Tìm thấy ${highVolCoins.length} coins có Vol 24h > 5M USDT...`);

        // BƯỚC 2: Tính diffEMA cho tất cả coin vừa lọc được
        console.log('⏳ Đang tính diffEMA cho danh sách coin...');
        const calculatedCoins = [];

        for (const coin of highVolCoins) {
            const data = await getCoinDataWithDiffEma(coin.instId, coin.volCcy24h);
            if (data) calculatedCoins.push(data);
            await sleep(80); // Tránh rate limit API OKX
        }

        // BƯỚC 3: Chọn Top 20 diffEMA LỚN NHẤT và Top 40 diffEMA NHỎ NHẤT
        const sortedMaxDiff = [...calculatedCoins].sort((a, b) => b.diffEMA - a.diffEMA);
        const sortedMinDiff = [...calculatedCoins].sort((a, b) => a.diffEMA - b.diffEMA);

        const top20MaxDiffEma = sortedMaxDiff.slice(0, 20);
        const top40MinDiffEma = sortedMinDiff.slice(0, 40);

        // BƯỚC 4: Lưu thông tin vào 24h.json (loại bỏ raw1H để file nhẹ và gọn)
        const formatForSave = item => ({
            symbol: item.symbol,
            diffEMA: parseFloat(item.diffEMA.toFixed(2)),
            volCcy24h: item.volCcy24h
        });

        save24hJson(
            top20MaxDiffEma.map(formatForSave),
            top40MinDiffEma.map(formatForSave)
        );

        // BƯỚC 5: Kiểm tra báo LONG cho Top 20 diffEMA lớn nhất
        console.log('🔍 Kiểm tra báo LONG trong Top 20 diffEMA lớn nhất...');
        for (const item of top20MaxDiffEma) {
            const symbol = item.symbol;
            const longResult = checkLongCondition(item);

            if (longResult) {
                if (!sentLog[symbol]) sentLog[symbol] = {};
                const lastSent = sentLog[symbol]._long1h || 0;

                if (currentTime - lastSent >= COOLDOWN_TIME) {
                    const coinName = symbol.replace('-USDT-SWAP', '');
                    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                    const message = `🟢 <b>LONG TÍN HIỆU #${coinName} 1H</b>\n` +
                                    `diffEMA 1H: <b>+${item.diffEMA.toFixed(2)}%</b>\n` +
                                    `Nến 1: <b>Nến Tăng</b>\n` +
                                    `Nến 2 Low sát BB Dưới (diffbbl): <code>${longResult.diffBB.toFixed(2)}%</code> (< 0.5%)\n` +
                                    `👉 <a href="${link}">Trade trên OKX</a>`;

                    console.log(`🚀 [LONG MATCHED] Gửi Telegram cho ${symbol}...`);
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID,
                        text: message,
                        parse_mode: 'HTML'
                    }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

                    sentLog[symbol]._long1h = currentTime;
                    hasNewAlert = true;
                }
            }
        }

        // BƯỚC 6: Kiểm tra báo SHORT cho Top 40 diffEMA nhỏ nhất
        console.log('🔍 Kiểm tra báo SHORT trong Top 40 diffEMA nhỏ nhất...');
        for (const item of top40MinDiffEma) {
            const symbol = item.symbol;
            const shortResult = checkShortCondition(item);

            if (shortResult) {
                if (!sentLog[symbol]) sentLog[symbol] = {};
                const lastSent = sentLog[symbol]._short1h || 0;

                if (currentTime - lastSent >= COOLDOWN_TIME) {
                    const coinName = symbol.replace('-USDT-SWAP', '');
                    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                    const message = `🔴 <b>SHORT TÍN HIỆU #${coinName} 1H</b>\n` +
                                    `diffEMA 1H: <b>${item.diffEMA.toFixed(2)}%</b>\n` +
                                    `Nến 1: <b>Nến Giảm</b>\n` +
                                    `Nến 2 High sát BB Trên (diffbbu): <code>${shortResult.diffBB.toFixed(2)}%</code> (> -0.5%)\n` +
                                    `👉 <a href="${link}">Trade trên OKX</a>`;

                    console.log(`🚀 [SHORT MATCHED] Gửi Telegram cho ${symbol}...`);
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID,
                        text: message,
                        parse_mode: 'HTML'
                    }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

                    sentLog[symbol]._short1h = currentTime;
                    hasNewAlert = true;
                }
            }
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

main();
