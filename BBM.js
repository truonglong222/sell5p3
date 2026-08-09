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

// Cooldown 12 tiếng cho tín hiệu Short
const COOLDOWN_SHORT = 12 * 60 * 60 * 1000; 

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
            if (timeData._short && now - timeData._short < COOLDOWN_SHORT) {
                temp._short = timeData._short;
            }
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

function save24hJson(qualifiedCoins) {
    try {
        const dataToSave = {
            updatedAt: new Date().toISOString(),
            count: qualifiedCoins.length,
            data: qualifiedCoins
        };
        fs.writeFileSync(FILE_24H, JSON.stringify(dataToSave, null, 2), 'utf8');
        console.log(`💾 Đã lưu ${qualifiedCoins.length} coin đủ điều kiện vào ${FILE_24H}`);
    } catch (e) {
        console.error('Lỗi khi ghi file 24h.json:', e.message);
    }
}

// ------------------- HÀM TÍNH EMA & BOLLINGER BANDS -------------------
function calculateEMA(prices, period) {
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

// Tính Bollinger Bands (Trả về cả Upper và Lower Band dựa trên 20 nến)
function calculateBB(closedPrices, multiplier = 2) {
    if (closedPrices.length < 20) return null;
    
    const recent20 = closedPrices.slice(closedPrices.length - 20);
    
    // 1. Tính SMA 20 (Middle Band)
    const mean = recent20.reduce((a, b) => a + b, 0) / 20;
    
    // 2. Tính Standard Deviation
    const variance = recent20.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / 20;
    const stdDev = Math.sqrt(variance);
    
    // 3. Trả về Upper Band & Lower Band
    return {
        upper: mean + (multiplier * stdDev),
        lower: mean - (multiplier * stdDev)
    };
}

// Tính diffEMA cho khung 1H dựa trên 10 nến
function calculateDiffEMA1H(closedPrices) {
    if (closedPrices.length < 20) return null;
    const ema10_Current = calculateEMA(closedPrices, 10);
    
    const closedPrices10Ago = closedPrices.slice(0, closedPrices.length - 10);
    const ema10_10Ago = calculateEMA(closedPrices10Ago, 10);

    if (!ema10_Current || !ema10_10Ago) return null;
    return ((ema10_Current - ema10_10Ago) / ema10_10Ago) * 100;
}

// Tính diffEMA cho khung 15M dựa trên 20 nến
function calculateDiffEMA15M(closedPrices) {
    if (closedPrices.length < 40) return null; // Cần tối thiểu 40 nến để tính EMA20 hiện tại và EMA20 của 20 nến trước
    const ema20_Current = calculateEMA(closedPrices, 20);
    
    const closedPrices20Ago = closedPrices.slice(0, closedPrices.length - 20);
    const ema20_20Ago = calculateEMA(closedPrices20Ago, 20);

    if (!ema20_Current || !ema20_20Ago) return null;
    return ((ema20_Current - ema20_20Ago) / ema20_20Ago) * 100;
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

// ------------------- LẤY NẾN 1H VÀ 15M CHO MỖI COIN -------------------
async function fetchCoinCandles(symbol, volCcy24h) {
    try {
        // Fetch 1H Candles (50 nến)
        const url1H = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=50`;
        const res1H = await axios.get(url1H, { timeout: 5000 });
        if (!res1H.data || res1H.data.code !== '0' || res1H.data.data.length < 50) return null;
        
        // Fetch 15M Candles (50 nến)
        const url15M = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=50`;
        const res15M = await axios.get(url15M, { timeout: 5000 });
        if (!res15M.data || res15M.data.code !== '0' || res15M.data.data.length < 50) return null;

        const raw1H = res1H.data.data;
        const raw15M = res15M.data.data;

        // Tách các giá đóng cửa đã đóng (bỏ nến 0)
        const closedPrices1H = raw1H.slice(1).reverse().map(c => parseFloat(c[4]));
        const closedPrices15M = raw15M.slice(1).reverse().map(c => parseFloat(c[4]));

        const diffEMA1h = calculateDiffEMA1H(closedPrices1H);
        const diffEMA15m = calculateDiffEMA15M(closedPrices15M);

        return {
            symbol,
            volCcy24h,
            diffEMA1h,
            diffEMA15m,
            raw15M,
            closedPrices15M
        };
    } catch (error) {
        console.error(`Lỗi lấy dữ liệu nến (${symbol}):`, error.message);
        return null;
    }
}

// ------------------- KIỂM TRA ĐIỀU KIỆN SHORT -------------------
function checkShortSignal(coinData) {
    const { raw15M, closedPrices15M, diffEMA1h, diffEMA15m } = coinData;

    // 1. Lấy thông số Bollinger Bands khung 15m
    const bb15M = calculateBB(closedPrices15M);
    if (!bb15M) return null;

    const currentPrice = parseFloat(raw15M[0][4]); // Giá hiện tại (Close price nến 0)
    
    // Calculate Diff BBUpper (%) và Độ rộng BB Upper-Lower (%)
    const diffbbu15m = ((currentPrice - bb15M.upper) / bb15M.upper) * 100;
    const diffbbul15m = ((bb15M.upper - bb15M.lower) / bb15M.lower) * 100;

    // BƯỚC 1: Kiểm tra các điều kiện trên 15M
    // - -0.5% < diffbbu15m < 1%
    // - diffbbul15m > 3%
    // - -1% < diffEMA15m < 0.5% (EMA 20 nến 15M)
    const isBBUpperValid = diffbbu15m > -0.5 && diffbbu15m < 1;
    const isBBSpreadValid = diffbbul15m > 3;
    const isDiffEMA15mValid = diffEMA15m !== null && diffEMA15m > -1 && diffEMA15m < 0.5;

    if (!isBBUpperValid || !isBBSpreadValid || !isDiffEMA15mValid) return null;

    // BƯỚC 2: Kiểm tra tiếp điều kiện DiffEMA 1H (10 nến)
    // -2% < diffema1h < 2%
    if (diffEMA1h === null || diffEMA1h <= -2 || diffEMA1h >= 2) return null;

    return {
        diffbbul15m,
        diffEMA15m,
        diffEMA1h
    };
}

// ------------------- HÀM CHÍNH -------------------
async function main() {
    try {
        console.log('--- BẮT ĐẦU TIẾN TRÌNH QUÉT THỊ TRƯỜNG SHORT ---');

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        // BƯỚC 1: Lấy các coin có Volume > 5M USDT
        const highVolCoins = await getHighVolumeCoins();
        console.log(`📋 Tìm thấy ${highVolCoins.length} coins có Vol 24h >= 5M USDT...`);

        // BƯỚC 2: Lấy dữ liệu nến và phân tích
        console.log('⏳ Đang phân tích dữ liệu nến 1H & 15M...');
        const qualifiedCoins = [];

        for (const coin of highVolCoins) {
            const data = await fetchCoinCandles(coin.instId, coin.volCcy24h);
            if (data) {
                // Kiểm tra điều kiện tín hiệu
                const signal = checkShortSignal(data);
                if (signal) {
                    qualifiedCoins.push({
                        symbol: data.symbol,
                        volCcy24h: data.volCcy24h,
                        diffbbul15m: parseFloat(signal.diffbbul15m.toFixed(2)),
                        diffEMA15m: parseFloat(signal.diffEMA15m.toFixed(2)),
                        diffEMA1h: parseFloat(signal.diffEMA1h.toFixed(2))
                    });
                }
            }
            await sleep(80);
        }

        // BƯỚC 3: Lưu dữ liệu ra file 24h.json
        save24hJson(qualifiedCoins);

        // BƯỚC 4: Gửi cảnh báo Telegram
        for (const item of qualifiedCoins) {
            const symbol = item.symbol;
            if (!sentLog[symbol]) sentLog[symbol] = {};
            const lastSent = sentLog[symbol]._short || 0;

            if (currentTime - lastSent >= COOLDOWN_SHORT) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                const message = `🔴 <b>TÍN HIỆU SHORT: ${coinName}</b>\n` +
                                `• Diff BB Upper-Lower 15M: <b>${item.diffbbul15m}%</b>\n` +
                                `• DiffEMA 15M (20 nến): <b>${item.diffEMA15m}%</b>\n` +
                                `• DiffEMA 1H (10 nến): <b>${item.diffEMA1h}%</b>\n` +
                                `• <a href="${link}">Trade trên OKX</a>`;

                console.log(`🚀 Gửi Telegram cho ${symbol}...`);
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

                sentLog[symbol]._short = currentTime;
                hasNewAlert = true;
            }
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

main();
