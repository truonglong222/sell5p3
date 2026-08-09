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

// Cooldown 2 tiếng cho tín hiệu 1H
const COOLDOWN_1H = 2 * 60 * 60 * 1000; 

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
            if (timeData._short1h && now - timeData._short1h < COOLDOWN_1H) {
                temp._short1h = timeData._short1h;
            }
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

// Ghi file 24h.json (Lưu danh sách coin thỏa mãn các tiêu chuẩn lọc)
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

// Tính Upper Band của Bollinger Bands khung 1H (dùng 20 nến đã đóng)
function calculateBBUpper1H(closedPrices, multiplier = 2) {
    if (closedPrices.length < 20) return null;
    
    // Lấy 20 nến đóng cửa gần nhất
    const recent20 = closedPrices.slice(closedPrices.length - 20);
    
    // 1. Tính SMA 20 (Middle Band)
    const mean = recent20.reduce((a, b) => a + b, 0) / 20;
    
    // 2. Tính Standard Deviation
    const variance = recent20.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / 20;
    const stdDev = Math.sqrt(variance);
    
    // 3. Tra về Upper Band
    return mean + (multiplier * stdDev);
}

// Tính diffEMA 1H (so sánh EMA20 hiện tại với EMA20 của 10 nến trước)
function calculateDiffEMA(closedPrices) {
    if (closedPrices.length < 30) return null;
    const ema20_Current = calculateEMA(closedPrices, 20);
    
    // Lấy mảng giá cắt bớt 10 nến gần nhất để tính EMA20 ở thời điểm 10 nến trước
    const closedPrices10Ago = closedPrices.slice(0, closedPrices.length - 10);
    const ema20_10Ago = calculateEMA(closedPrices10Ago, 20);

    if (!ema20_Current || !ema20_10Ago) return null;
    return ((ema20_Current - ema20_10Ago) / ema20_10Ago) * 100;
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

// ------------------- LẤY NẾN 1H CHO MỖI COIN -------------------
async function fetchCoinCandles(symbol, volCcy24h) {
    try {
        // Fetch 1H Candles -> Lấy 50 nến (Đủ tính DiffEMA 1H và Bollinger Upper)
        const url1H = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=50`;
        const res1H = await axios.get(url1H, { timeout: 5000 });
        if (!res1H.data || res1H.data.code !== '0' || res1H.data.data.length < 50) return null;
        
        const raw1H = res1H.data.data;

        // Tách các giá đóng cửa 1H đã đóng (bỏ nến 0)
        const closedPrices1H = raw1H.slice(1).reverse().map(c => parseFloat(c[4]));
        const diffEMA1h = calculateDiffEMA(closedPrices1H);

        return {
            symbol,
            volCcy24h,
            diffEMA1h,
            raw1H,
            closedPrices1H
        };
    } catch (error) {
        console.error(`Lỗi lấy dữ liệu nến (${symbol}):`, error.message);
        return null;
    }
}

// ------------------- KIỂM TRA ĐIỀU KIỆN SHORT MỚI (KHUNG 1H) -------------------
function checkShortSignal(coinData) {
    const { raw1H, closedPrices1H, diffEMA1h } = coinData;

    // 1. Kiểm tra DiffEMA 1H < -3%
    if (diffEMA1h === null || diffEMA1h >= -3) return null;

    // 2. Tính diffbbu1h với Giá cao nhất của nến 0 khung 1H
    const candle0 = raw1H[0]; // Nến 1H hiện tại
    const highPrice0 = parseFloat(candle0[2]); // Giá cao nhất nến hiện tại

    const bbUpper1H = calculateBBUpper1H(closedPrices1H);
    if (!bbUpper1H) return null;

    const diffbbu1h = ((highPrice0 - bbUpper1H) / bbUpper1H) * 100;

    // 3. Kiểm tra điều kiện -0.5% < diffbbu1h < 1%
    if (diffbbu1h > -0.5 && diffbbu1h < 1) {
        return { diffbbu1h };
    }

    return null;
}

// ------------------- HÀM CHÍNH -------------------
async function main() {
    try {
        console.log('--- BẮT ĐẦU TIẾN TRÌNH QUÉT THỊ TRƯỜNG SHORT (KHUNG 1H) ---');

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        // BƯỚC 1: Lấy các coin có Volume > 5M USDT
        const highVolCoins = await getHighVolumeCoins();
        console.log(`📋 Tìm thấy ${highVolCoins.length} coins có Vol 24h >= 5M USDT...`);

        // BƯỚC 2: Lấy dữ liệu nến 1H và phân tích
        console.log('⏳ Đang phân tích dữ liệu nến 1H...');
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
                        diffEMA1h: parseFloat(data.diffEMA1h.toFixed(2)),
                        diffbbu1h: parseFloat(signal.diffbbu1h.toFixed(2))
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
            const lastSent = sentLog[symbol]._short1h || 0;

            if (currentTime - lastSent >= COOLDOWN_1H) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                const message = `🔴 <b>TÍN HIỆU SHORT 1H: ${coinName}</b>\n` +
                                `• DiffEMA 1H: <b>${item.diffEMA1h}%</b> (< -3%)\n` +
                                `• Diff BB Upper 1H: <b>${item.diffbbu1h > 0 ? '+' : ''}${item.diffbbu1h}%</b>\n` +
                                `• Volume 24h: <b>${(item.volCcy24h / 1000000).toFixed(2)}M USDT</b>\n` +
                                `• <a href="${link}">Trade trên OKX</a>`;

                console.log(`🚀 Gửi Telegram cho ${symbol}...`);
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

                sentLog[symbol]._short1h = currentTime;
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
