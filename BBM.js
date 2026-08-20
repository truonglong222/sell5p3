import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;
const OKX_BASE_URL = 'https://www.okx.com';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'sent_top3.json');

// Cấu hình Cooldown: 15 PHÚT
const COOLDOWN_TIME = 15 * 60 * 1000;
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
            for (const [key, timestamp] of Object.entries(timeData)) {
                if (now - timestamp < COOLDOWN_TIME) {
                    temp[key] = timestamp;
                }
            }
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

// ------------------- TÍNH BOLLINGER BANDS -------------------
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

// ------------------- LẤY TOP 3 TĂNG VÀ TOP 3 GIẢM 24H -------------------
async function getTopGainersAndLosers() {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const res = await axios.get(url, { timeout: 10000 });
        if (!res.data || res.data.code !== '0') return { topGainers: [], topLosers: [] };

        const validTickers = res.data.data.filter(item => {
            if (!item.instId.endsWith('-USDT-SWAP')) return false;
            const volCcy = parseFloat(item.volCcy24h || 0);
            const open24h = parseFloat(item.open24h || 0);
            const last = parseFloat(item.last || 0);
            return volCcy >= MIN_VOLUME_USDT && open24h > 0 && last > 0;
        }).map(item => {
            const open = parseFloat(item.open24h);
            const last = parseFloat(item.last);
            const change24h = ((last - open) / open) * 100;
            return {
                instId: item.instId,
                change24h: change24h,
                volCcy24h: parseFloat(item.volCcy24h)
            };
        });

        // Sắp xếp giảm dần để lấy Top Tăng
        validTickers.sort((a, b) => b.change24h - a.change24h);
        const topGainers = validTickers.slice(0, 3).map((item, index) => ({
            ...item,
            rank: index + 1
        }));

        // Sắp xếp tăng dần để lấy Top Giảm
        validTickers.sort((a, b) => a.change24h - b.change24h);
        const topLosers = validTickers.slice(0, 3).map((item, index) => ({
            ...item,
            rank: index + 1
        }));

        return { topGainers, topLosers };
    } catch (error) {
        console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
        return { topGainers: [], topLosers: [] };
    }
}

// ------------------- LẤY NẾN 1M VÀ KIỂM TRA ĐIỀU KIỆN -------------------
async function checkCoinSignal(symbol, type, rank) {
    try {
        // Cần tối thiểu 21 nến 1m (1 nến đang chạy index 0, nến vừa đóng index 1, và 20 nến trước đó)
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1m&limit=30`;
        const res = await axios.get(url, { timeout: 5000 });
        if (!res.data || res.data.code !== '0' || res.data.data.length < 22) return null;

        const candles = res.data.data;
        const closedCandle1 = candles[1]; // Nến 1m vừa đóng [ts, o, h, l, c, ...]
        const high1 = parseFloat(closedCandle1[2]);
        const low1 = parseFloat(closedCandle1[3]);

        // Lấy giá đóng cửa của 20 nến kết thúc tại nến vừa đóng (index 1 -> 20)
        const closedPrices = candles.slice(1, 21).reverse().map(c => parseFloat(c[4]));
        const bb = calculateBollingerBands(closedPrices, 20);
        if (!bb || bb.upper === 0 || bb.lower === 0) return null;

        // Tính Hbb = ((Upper - Lower) / Upper) * 100
        const hBB = ((bb.upper - bb.lower) / bb.upper) * 100;
        if (hBB <= 2) return null; // Điều kiện Hbb > 2%

        if (type === 'LONG') {
            // bbd = chênh lệch % giá thấp nhất của nến vừa đóng và BB dưới
            const bbd = ((low1 - bb.lower) / bb.lower) * 100;
            if (bbd > -2 && bbd < 0.5) {
                return {
                    symbol,
                    type: 'LONG',
                    rank,
                    hBB,
                    diffVal: bbd,
                    diffLabel: 'bbd'
                };
            }
        } else if (type === 'SHORT') {
            // bbt = chênh lệch % giá cao nhất của nến vừa đóng và BB trên
            const bbt = ((high1 - bb.upper) / bb.upper) * 100;
            if (bbt > -0.5 && bbt < 2) {
                return {
                    symbol,
                    type: 'SHORT',
                    rank,
                    hBB,
                    diffVal: bbt,
                    diffLabel: 'bbt'
                };
            }
        }

        return null;
    } catch (error) {
        console.error(`Lỗi kiểm tra nến 1m (${symbol}):`, error.message);
        return null;
    }
}

// ------------------- HÀM CHÍNH -------------------
async function main() {
    try {
        console.log('--- BẮT ĐẦU QUÉT TOP 3 TĂNG/GIẢM (1M BB STRATEGY) ---');

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        const { topGainers, topLosers } = await getTopGainersAndLosers();
        console.log(`Top 3 Tăng: ${topGainers.map(c => `${c.instId} (#${c.rank} ${c.change24h.toFixed(2)}%)`).join(', ')}`);
        console.log(`Top 3 Giảm: ${topLosers.map(c => `${c.instId} (#${c.rank} ${c.change24h.toFixed(2)}%)`).join(', ')}`);

        const sendAlert = async (signal) => {
            const cooldownKey = `_${signal.type.toLowerCase()}1m`;
            if (!sentLog[signal.symbol]) sentLog[signal.symbol] = {};
            const lastSent = sentLog[signal.symbol][cooldownKey] || 0;

            if (currentTime - lastSent >= COOLDOWN_TIME) {
                const coinName = signal.symbol.replace('-USDT-SWAP', '');
                const icon = signal.type === 'LONG' ? '🟢' : '🔴';
                const rankText = signal.type === 'LONG' ? `Top ${signal.rank} Tăng 24h` : `Top ${signal.rank} Giảm 24h`;
                const link = `https://www.okx.com/trade-swap/${signal.symbol.toLowerCase()}`;

                const message = `${icon} <b>${coinName} (${signal.type})</b>\n` +
                                `• Vị trí: <b>${rankText}</b>\n` +
                                `• Hbb: <b>${signal.hBB.toFixed(2)}%</b>\n` +
                                `• ${signal.diffLabel}: <b>${signal.diffVal > 0 ? '+' : ''}${signal.diffVal.toFixed(2)}%</b>\n` +
                                `• <a href="${link}">Trade trên OKX</a>`;

                console.log(`🚀 [${signal.type} MATCHED] Gửi Telegram cho ${signal.symbol}...`);
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

                sentLog[signal.symbol][cooldownKey] = currentTime;
                hasNewAlert = true;
            }
        };

        // Quét Long cho Top 3 Tăng
        for (const coin of topGainers) {
            const signal = await checkCoinSignal(coin.instId, 'LONG', coin.rank);
            if (signal) await sendAlert(signal);
            await sleep(100);
        }

        // Quét Short cho Top 3 Giảm
        for (const coin of topLosers) {
            const signal = await checkCoinSignal(coin.instId, 'SHORT', coin.rank);
            if (signal) await sendAlert(signal);
            await sleep(100);
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- HOÀN THÀNH QUÉT ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

main();
