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

// Cooldown mặc định 2 tiếng cho tín hiệu 15M
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
            if (timeData._short15m && now - timeData._short15m < COOLDOWN_15M) {
                temp._short15m = timeData._short15m;
            }
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

// Ghi file 24h.json (Lưu danh sách phân loại Nhóm A và B)
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
        console.log(`💾 Đã lưu phân loại Nhóm A (${groupedData.groupA.length}) & B (${groupedData.groupB.length}) vào ${FILE_24H}`);
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

// Tính Bollinger Bands (Middle và Upper) từ 20 nến đã đóng cửa
function calculateBollingerBands15M(closedPrices, multiplier = 2) {
    const period = closedPrices.length;
    if (period < 20) return null;

    // 1. Tính Middle Band (SMA 20)
    const mean = closedPrices.reduce((a, b) => a + b, 0) / period;
    
    // 2. Tính Standard Deviation
    const variance = closedPrices.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    
    // 3. Tính Upper Band
    const upper = mean + (multiplier * stdDev);

    return { middle: mean, upper };
}

// Tính diffEMA dựa trên danh sách giá đóng cửa (Đã đổi thành so sánh với 10 nến trước)
function calculateDiffEMA(closedPrices) {
    if (closedPrices.length < 30) return null;
    const ema20_1 = calculateEMA(closedPrices, 20);
    
    // Lấy mảng giá cắt bớt 10 nến gần nhất để tính EMA20 ở thời điểm 10 nến trước
    const closedPrices10Ago = closedPrices.slice(0, closedPrices.length - 10);
    const ema20_10Ago = calculateEMA(closedPrices10Ago, 20);

    if (!ema20_1 || !ema20_10Ago) return null;
    return ((ema20_1 - ema20_10Ago) / ema20_10Ago) * 100;
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

// ------------------- LẤY NẾN 15M (21 nến) VÀ 1H (50 nến) CHO MỖI COIN -------------------
async function fetchCoinCandles(symbol, volCcy24h) {
    try {
        // 1. Fetch 15M Candles -> Chỉ lấy 21 nến
        const url15M = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=21`;
        const res15M = await axios.get(url15M, { timeout: 5000 });
        if (!res15M.data || res15M.data.code !== '0' || res15M.data.data.length < 21) return null;
        const raw15M = res15M.data.data;

        // 2. Fetch 1H Candles (Cần tối thiểu 30 nến để tính EMA20 trước đó 10 nến)
        const url1H = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=50`;
        const res1H = await axios.get(url1H, { timeout: 5000 });
        if (!res1H.data || res1H.data.code !== '0' || res1H.data.data.length < 50) return null;
        const raw1H = res1H.data.data;
        const closedPrices1H = raw1H.slice(1).reverse().map(c => parseFloat(c[4]));
        const diffEMA1h = calculateDiffEMA(closedPrices1H);

        return {
            symbol,
            volCcy24h,
            diffEMA1h,
            raw15M
        };
    } catch (error) {
        console.error(`Lỗi lấy dữ liệu nến (${symbol}):`, error.message);
        return null;
    }
}

// ------------------- KIỂM TRA ĐIỀU KIỆN SHORT -------------------

// Nhóm A: Kiểm tra sát Bollinger Band TRÊN 15M
function checkSignalGroupA(coinData) {
    const { raw15M } = coinData;
    const candle0 = raw15M[0]; // Nến hiện tại
    const highPrice0 = parseFloat(candle0[2]);

    // Lấy 20 nến đã đóng cửa trước đó
    const closedForBB = raw15M.slice(1, 21).reverse().map(c => parseFloat(c[4]));
    const bb = calculateBollingerBands15M(closedForBB, 2);
    if (!bb) return null;

    const diffBB = ((highPrice0 - bb.upper) / bb.upper) * 100;
    
    if (diffBB > -0.5 && diffBB < 1) {
        return { type: 'SHORT TRÊN', diffBB };
    }
    return null;
}

// Nhóm B: Kiểm tra sát Bollinger Band GIỮA 15M
function checkSignalGroupB(coinData) {
    const { raw15M } = coinData;
    const candle0 = raw15M[0]; // Nến hiện tại
    const highPrice0 = parseFloat(candle0[2]);

    // Lấy 20 nến đã đóng cửa trước đó
    const closedForBB = raw15M.slice(1, 21).reverse().map(c => parseFloat(c[4]));
    const bb = calculateBollingerBands15M(closedForBB, 2);
    if (!bb) return null;

    const diffBB = ((highPrice0 - bb.middle) / bb.middle) * 100;
    
    if (diffBB > -0.5 && diffBB < 1) {
        return { type: 'SHORT GIỮA', diffBB };
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

        // BƯỚC 2: Lấy nến 15M (21 nến) và 1H cho từng coin
        console.log('⏳ Đang lấy dữ liệu nến 15M và 1H...');
        const fullDataCoins = [];

        for (const coin of highVolCoins) {
            const data = await fetchCoinCandles(coin.instId, coin.volCcy24h);
            if (data) fullDataCoins.push(data);
            await sleep(80);
        }

        // BƯỚC 3: Phân loại Nhóm A và Nhóm B theo diffEMA 1H
        // Nhóm A: -6% < diffEMA1h < -4%
        const groupA = fullDataCoins.filter(c => c.diffEMA1h !== null && c.diffEMA1h > -6 && c.diffEMA1h < -4);
        
        // Nhóm B: -25% < diffEMA1h < -6%
        const groupB = fullDataCoins.filter(c => c.diffEMA1h !== null && c.diffEMA1h > -25 && c.diffEMA1h < -6);

        const formatItem = c => ({
            symbol: c.symbol,
            diffEMA1h: parseFloat(c.diffEMA1h.toFixed(2)),
            volCcy24h: c.volCcy24h
        });

        save24hJson({
            groupA: groupA.map(formatItem),
            groupB: groupB.map(formatItem)
        });

        // BƯỚC 4: Hàm gửi Báo Tín Hiệu Telegram
        const sendAlert = async (item, signalType, diffBB) => {
            const symbol = item.symbol;
            if (!sentLog[symbol]) sentLog[symbol] = {};
            const lastSent = sentLog[symbol]._short15m || 0;

            if (currentTime - lastSent >= COOLDOWN_15M) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                const message = `🔴 <b>TÍN HIỆU ${signalType.toUpperCase()}: ${coinName}</b>\n` +
                                `• DiffEMA 1H (10 nến): <b>${item.diffEMA1h.toFixed(2)}%</b>\n` +
                                `• Diff BB 15M: <b>${diffBB > 0 ? '+' : ''}${diffBB.toFixed(2)}%</b>\n` +
                                `• Volume 24h: <b>${(item.volCcy24h / 1000000).toFixed(2)}M USDT</b>\n` +
                                `• <a href="${link}">Trade trên OKX</a>`;

                console.log(`🚀 [${signalType}] Gửi Telegram cho ${symbol}...`);
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

        // BƯỚC 5: Kiểm tra tín hiệu cho từng nhóm
        
        // 1. Quét Nhóm A -> Tín hiệu "Short Trên" (Band Trên 15m)
        console.log(`🔍 Quét NHÓM A (-6 < diffEMA1h < -4) -> "Short Trên" (${groupA.length} coins)...`);
        for (const item of groupA) {
            const sig = checkSignalGroupA(item);
            if (sig) {
                await sendAlert(item, sig.type, sig.diffBB);
            }
        }

        // 2. Quét Nhóm B -> Tín hiệu "Short Giữa" (Band Giữa 15m)
        console.log(`🔍 Quét NHÓM B (-25 < diffEMA1h < -6) -> "Short Giữa" (${groupB.length} coins)...`);
        for (const item of groupB) {
            const sig = checkSignalGroupB(item);
            if (sig) {
                await sendAlert(item, sig.type, sig.diffBB);
            }
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

main();
