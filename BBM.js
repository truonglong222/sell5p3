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

// Lưu danh sách Top 10 Tăng & Top 30 Giảm vào file 24h.json với định dạng hiển thị mới
function save24hJson(topGainers, topLosers) {
    try {
        const dataToSave = {
            updatedAt: new Date().toISOString(),
            top10Gainers: topGainers.map(item => ({
                rank: `#${item.rank}`,
                symbol: item.instId.replace('-USDT-SWAP', ''),
                change24hPct: `${item.change24hPct >= 0 ? '+' : ''}${item.change24hPct.toFixed(2)}%`
            })),
            top30Losers: topLosers.map(item => ({
                rank: `#${item.rank}`,
                symbol: item.instId.replace('-USDT-SWAP', ''),
                change24hPct: `${item.change24hPct.toFixed(2)}%`
            }))
        };
        fs.writeFileSync(FILE_24H, JSON.stringify(dataToSave, null, 2), 'utf8');
        console.log(`💾 Đã lưu Top ${topGainers.length} Gainers và Top ${topLosers.length} Losers vào ${FILE_24H}`);
    } catch (e) {
        console.error('Lỗi khi ghi file 24h.json:', e.message);
    }
}

// ------------------- HÀM TÍNH BOLLINGER BANDS -------------------
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

// ------------------- LẤY TOP 10 TĂNG VÀ TOP 30 GIẢM (VOL > 5M) -------------------
async function getTop10GainersAndTop30Losers() {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const res = await axios.get(url, { timeout: 10000 });
        if (!res.data || res.data.code !== '0') return { topGainers: [], topLosers: [] };

        const tickers = res.data.data;
        const filtered = tickers.filter(item => {
            if (!item.instId.endsWith('-USDT-SWAP')) return false;
            const volCcy = parseFloat(item.volCcy24h || 0);
            return volCcy >= MIN_VOLUME_USDT;
        }).map(item => {
            const last = parseFloat(item.last || 0);
            const open24h = parseFloat(item.open24h || 0);
            const change24hPct = open24h > 0 ? ((last - open24h) / open24h) * 100 : 0;
            return {
                instId: item.instId,
                change24hPct: change24hPct,
                volCcy24h: parseFloat(item.volCcy24h || 0)
            };
        });

        // Sắp xếp và gắn số thứ tự Top (Rank)
        const sortedGainers = [...filtered].sort((a, b) => b.change24hPct - a.change24hPct);
        const sortedLosers = [...filtered].sort((a, b) => a.change24hPct - b.change24hPct);

        const topGainers = sortedGainers.slice(0, 10).map((item, index) => ({ ...item, rank: index + 1 }));
        const topLosers = sortedLosers.slice(0, 30).map((item, index) => ({ ...item, rank: index + 1 }));

        return { topGainers, topLosers };
    } catch (error) {
        console.error('Lỗi khi lấy dữ liệu Tickers từ OKX:', error.message);
        return { topGainers: [], topLosers: [] };
    }
}

// ------------------- CHECK TÍN HIỆU LONG (TOP 10 GAINERS) -------------------
async function checkLongCondition(symbol) {
    try {
        const url1H = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=30`;
        const res1H = await axios.get(url1H, { timeout: 5000 });

        if (!res1H.data || res1H.data.code !== '0' || res1H.data.data.length < 25) return null;

        const raw1H = res1H.data.data;

        // 1. Nến vừa đóng (nến 1) phải là NẾN TĂNG
        const candle1 = raw1H[1];
        const open1 = parseFloat(candle1[1]);
        const close1 = parseFloat(candle1[4]);
        if (close1 <= open1) return null;

        // 2. Nến 2 (index 2): Low2 sát BB Dưới
        const candle2 = raw1H[2];
        const low2 = parseFloat(candle2[3]);

        const closedForBB2 = raw1H.slice(2, 22).reverse().map(c => parseFloat(c[4]));
        const bb2 = calculateBollingerBands(closedForBB2, 20);
        if (!bb2) return null;

        const diffbbl = ((low2 - bb2.lower) / bb2.lower) * 100;

        if (diffbbl < 0.5) {
            return {
                type: 'LONG',
                diffBB: diffbbl
            };
        }
    } catch (error) {
        console.error(`Lỗi kiểm tra LONG (${symbol}):`, error.message);
    }
    return null;
}

// ------------------- CHECK TÍN HIỆU SHORT (TOP 30 LOSERS) -------------------
async function checkShortCondition(symbol) {
    try {
        const url1H = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=30`;
        const res1H = await axios.get(url1H, { timeout: 5000 });

        if (!res1H.data || res1H.data.code !== '0' || res1H.data.data.length < 25) return null;

        const raw1H = res1H.data.data;

        // 1. Nến vừa đóng (nến 1) phải là NẾN GIẢM
        const candle1 = raw1H[1];
        const open1 = parseFloat(candle1[1]);
        const close1 = parseFloat(candle1[4]);
        if (close1 >= open1) return null;

        // 2. Nến 2 (index 2): High2 sát BB Trên
        const candle2 = raw1H[2];
        const high2 = parseFloat(candle2[2]);

        const closedForBB2 = raw1H.slice(2, 22).reverse().map(c => parseFloat(c[4]));
        const bb2 = calculateBollingerBands(closedForBB2, 20);
        if (!bb2) return null;

        const diffbbu = ((high2 - bb2.upper) / bb2.upper) * 100;

        if (diffbbu > -0.5) {
            return {
                type: 'SHORT',
                diffBB: diffbbu
            };
        }
    } catch (error) {
        console.error(`Lỗi kiểm tra SHORT (${symbol}):`, error.message);
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

        // BƯỚC 1: Lấy Top 10 Tăng và Top 30 Giảm
        const { topGainers, topLosers } = await getTop10GainersAndTop30Losers();
        console.log(`📋 Đã lọc: Top ${topGainers.length} Gainers | Top ${topLosers.length} Losers`);

        // BƯỚC 2: Lưu danh sách vào file 24h.json
        save24hJson(topGainers, topLosers);

        // BƯỚC 3: Quét tín hiệu LONG trong Top 10 Gainers
        console.log('🔍 Kiểm tra tín hiệu LONG (Top 10 Gainers)...');
        for (const item of topGainers) {
            const symbol = item.instId;
            const longResult = await checkLongCondition(symbol);

            if (longResult) {
                if (!sentLog[symbol]) sentLog[symbol] = {};
                const lastSent = sentLog[symbol]._long1h || 0;

                if (currentTime - lastSent >= COOLDOWN_TIME) {
                    const coinName = symbol.replace('-USDT-SWAP', '');
                    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                    // Nội dung tin nhắn Telegram ngắn gọn
                    const message = `🟢 <b>LONG #${coinName}</b> (Top ${item.rank} Gainer)\n` +
                                    `• 24h: <b>+${item.change24hPct.toFixed(2)}%</b>\n` +
                                    `• Diff BB: <code>${longResult.diffBB.toFixed(2)}%</code>\n` +
                                    `👉 <a href="${link}">Trade trên OKX</a>`;

                    console.log(`🚀 [LONG MATCHED] Gửi thông báo Telegram cho ${symbol}...`);
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID,
                        text: message,
                        parse_mode: 'HTML'
                    }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

                    sentLog[symbol]._long1h = currentTime;
                    hasNewAlert = true;
                }
            }
            await sleep(100);
        }

        // BƯỚC 4: Quét tín hiệu SHORT trong Top 30 Losers
        console.log('🔍 Kiểm tra tín hiệu SHORT (Top 30 Losers)...');
        for (const item of topLosers) {
            const symbol = item.instId;
            const shortResult = await checkShortCondition(symbol);

            if (shortResult) {
                if (!sentLog[symbol]) sentLog[symbol] = {};
                const lastSent = sentLog[symbol]._short1h || 0;

                if (currentTime - lastSent >= COOLDOWN_TIME) {
                    const coinName = symbol.replace('-USDT-SWAP', '');
                    const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                    // Nội dung tin nhắn Telegram ngắn gọn
                    const message = `🔴 <b>SHORT #${coinName}</b> (Top ${item.rank} Loser)\n` +
                                    `• 24h: <b>${item.change24hPct.toFixed(2)}%</b>\n` +
                                    `• Diff BB: <code>${shortResult.diffBB.toFixed(2)}%</code>\n` +
                                    `👉 <a href="${link}">Trade trên OKX</a>`;

                    console.log(`🚀 [SHORT MATCHED] Gửi thông báo Telegram cho ${symbol}...`);
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID,
                        text: message,
                        parse_mode: 'HTML'
                    }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

                    sentLog[symbol]._short1h = currentTime;
                    hasNewAlert = true;
                }
            }
            await sleep(100);
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

main();
