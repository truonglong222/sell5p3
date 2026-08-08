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

// Cooldown cho tín hiệu SHORT là 2 TIẾNG
const COOLDOWN_15M = 2 * 60 * 60 * 1000; 

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
            // Lọc dọn dẹp log cooldown 15m
            if (timeData._short15m && now - timeData._short15m < COOLDOWN_15M) {
                temp._short15m = timeData._short15m;
            }
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

// Ghi file 24h.json (Lưu danh sách Coin lọc theo diffEMA 1H và diffEMA 15M)
function save24hJson(filteredData) {
    try {
        const dataToSave = {
            updatedAt: new Date().toISOString(),
            count: filteredData.length,
            data: filteredData
        };
        fs.writeFileSync(FILE_24H, JSON.stringify(dataToSave, null, 2), 'utf8');
        console.log(`💾 Đã lưu ${filteredData.length} coin thỏa điều kiện diffEMA 1H & 15M vào ${FILE_24H}`);
    } catch (e) {
        console.error('Lỗi khi ghi file 24h.json:', e.message);
    }
}

// ------------------- HÀM TÍNH EMA & MID BAND -------------------
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

// Tính Mid Band (SMA 20)
function calculateBBMiddle(prices, period = 20) {
    if (prices.length < period) return null;
    const slice = prices.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
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

// ------------------- LẤY NẾN 15M VÀ 1H CHO MỖI COIN -------------------
async function fetchCoinCandles(symbol, volCcy24h) {
    try {
        // 1. Fetch 15M Candles
        const url15M = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=60`;
        const res15M = await axios.get(url15M, { timeout: 5000 });
        if (!res15M.data || res15M.data.code !== '0' || res15M.data.data.length < 60) return null;
        const raw15M = res15M.data.data;
        const closedPrices15M = raw15M.slice(1).reverse().map(c => parseFloat(c[4]));
        const diffEMA15m = calculateDiffEMA(closedPrices15M);

        // 2. Fetch 1H Candles
        const url1H = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=60`;
        const res1H = await axios.get(url1H, { timeout: 5000 });
        if (!res1H.data || res1H.data.code !== '0' || res1H.data.data.length < 60) return null;
        const raw1H = res1H.data.data;
        const closedPrices1H = raw1H.slice(1).reverse().map(c => parseFloat(c[4]));
        const diffEMA1h = calculateDiffEMA(closedPrices1H);

        return {
            symbol,
            volCcy24h,
            diffEMA15m,
            diffEMA1h,
            raw15M
        };
    } catch (error) {
        console.error(`Lỗi lấy dữ liệu nến (${symbol}):`, error.message);
        return null;
    }
}

// ------------------- KIỂM TRA ĐIỀU KIỆN SHORT 15M -------------------
// Kiểm tra tín hiệu SHORT 15M: -0.5% < diffbbm15m < 1%
function checkSignalShort15M(coinData) {
    const { raw15M } = coinData;
    const candle0 = raw15M[0]; // Nến 15m hiện tại
    const highPrice0 = parseFloat(candle0[2]);

    const closedForBB = raw15M.slice(1, 21).reverse().map(c => parseFloat(c[4]));
    const bbMiddle = calculateBBMiddle(closedForBB, 20);
    if (!bbMiddle) return null;

    const diffbbm15m = ((highPrice0 - bbMiddle) / bbMiddle) * 100;
    
    if (diffbbm15m > -0.5 && diffbbm15m < 1) {
        return { type: 'SHORT 15M', diffBB: diffbbm15m };
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

        // BƯỚC 1: Lấy các coin có Volume > 5M USDT
        const highVolCoins = await getHighVolumeCoins();
        console.log(`📋 Tìm thấy ${highVolCoins.length} coins có Vol 24h > 5M USDT...`);

        // BƯỚC 2: Lấy nến 15M và 1H cho từng coin
        console.log('⏳ Đang lấy dữ liệu nến 15M và 1H...');
        const fullDataCoins = [];

        for (const coin of highVolCoins) {
            const data = await fetchCoinCandles(coin.instId, coin.volCcy24h);
            if (data) fullDataCoins.push(data);
            await sleep(80);
        }

        // BƯỚC 3: Lọc nhóm coin thỏa mãn cả 2 điều kiện:
        // 1. -25% < diffEMA1h < -4%
        // 2. diffEMA15m < -5%
        const targetCoins = fullDataCoins.filter(c => 
            c.diffEMA1h !== null && c.diffEMA1h > -25 && c.diffEMA1h < -4 &&
            c.diffEMA15m !== null && c.diffEMA15m < -5
        );

        console.log(`🎯 Tìm thấy ${targetCoins.length} coin thỏa mãn (diffEMA1h trong (-25%, -4%) VÀ diffEMA15m < -5%)`);

        // Lưu danh sách coin đủ điều kiện vào 24h.json
        const dataToSave = targetCoins.map(c => ({
            symbol: c.symbol,
            diffEMA1h: parseFloat(c.diffEMA1h.toFixed(2)),
            diffEMA15m: parseFloat(c.diffEMA15m.toFixed(2)),
            volCcy24h: c.volCcy24h
        }));
        save24hJson(dataToSave);

        // BƯỚC 4: Hàm gửi Báo Tín Hiệu Telegram
        const sendAlert = async (item, diffBB) => {
            const symbol = item.symbol;
            if (!sentLog[symbol]) sentLog[symbol] = {};
            const lastSent = sentLog[symbol]._short15m || 0;

            if (currentTime - lastSent >= COOLDOWN_15M) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                const message = `🔴 <b>TÍN HIỆU SHORT: ${coinName}</b>\n` +
                                `• DiffEMA 15M: <b>${item.diffEMA15m.toFixed(2)}%</b>\n` +
                                `• DiffEMA 1H: <b>${item.diffEMA1h.toFixed(2)}%</b>\n` +
                                `• Diff BBM 15M: <b>${diffBB > 0 ? '+' : ''}${diffBB.toFixed(2)}%</b>\n` +
                                `• Volume 24h: <b>${(item.volCcy24h / 1000000).toFixed(2)}M USDT</b>\n` +
                                `• <a href="${link}">Trade trên OKX</a>`;

                console.log(`🚀 [MATCHED] Gửi Telegram cho ${symbol}...`);
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

                sentLog[symbol]._short15m = currentTime;
                hasNewAlert = true;
            }
        };

        // BƯỚC 5: Kiểm tra tín hiệu SHORT 15M cho nhóm coin đã lọc
        console.log(`🔍 Kiểm tra điều kiện SHORT (-0.5% < diffbbm15m < 1%)...`);
        for (const item of targetCoins) {
            const sig = checkSignalShort15M(item);
            if (sig) {
                await sendAlert(item, sig.diffBB);
            }
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

main();
