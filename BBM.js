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

// Cấu hình Cooldown: 15 PHÚT
const COOLDOWN_TIME = 15 * 60 * 1000;

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
                // Giữ lại các lệnh vẫn còn trong thời gian cooldown 15m
                if (now - timestamp < COOLDOWN_TIME) {
                    temp[key] = timestamp;
                }
            }
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
        console.log(`💾 Đã cập nhật log gửi tin vào ${DB_FILE}`);
    } catch (e) {
        console.error('Lỗi khi ghi file sent_ema.json:', e.message);
    }
}

// ------------------- HÀM TÍNH TOÁN EMA & BOLLINGER BANDS -------------------
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

// ------------------- TÍNH EMA10N TRÊN KHUNG 5M -------------------
async function getEma10n5m(symbol) {
    try {
        const url5m = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=5m&limit=50`;
        const res5m = await axios.get(url5m, { timeout: 5000 });
        if (!res5m.data || res5m.data.code !== '0' || res5m.data.data.length < 35) return null;

        const raw5M = res5m.data.data;
        const closedPrices1 = raw5M.slice(1).reverse().map(c => parseFloat(c[4]));
        const ema20_Candle1 = calculateEMA(closedPrices1, 20);

        const closedPrices10 = raw5M.slice(10).reverse().map(c => parseFloat(c[4]));
        const ema20_Candle10 = calculateEMA(closedPrices10, 20);

        if (!ema20_Candle1 || !ema20_Candle10 || ema20_Candle10 === 0) return null;

        return ((ema20_Candle1 - ema20_Candle10) / ema20_Candle10) * 100;
    } catch (error) {
        console.error(`Lỗi tính ema10n 5m (${symbol}):`, error.message);
        return null;
    }
}

// ------------------- LẤY TOP 3 TĂNG VÀ TOP 3 GIẢM 24H -------------------
async function getTopGainersAndLosers() {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const res = await axios.get(url, { timeout: 10000 });
        if (!res.data || res.data.code !== '0') return { topGainers: [], topLosers: [] };

        const validTickers = res.data.data.filter(item => {
            if (!item.instId.endsWith('-USDT-SWAP')) return false;
            const open24h = parseFloat(item.open24h || 0);
            const last = parseFloat(item.last || 0);
            return open24h > 0 && last > 0;
        }).map(item => {
            const open = parseFloat(item.open24h);
            const last = parseFloat(item.last);
            const change24h = ((last - open) / open) * 100;
            return {
                instId: item.instId,
                change24h: change24h
            };
        });

        // Top Tăng
        validTickers.sort((a, b) => b.change24h - a.change24h);
        const topGainers = validTickers.slice(0, 3).map((item, index) => ({
            ...item,
            rank: index + 1
        }));

        // Top Giảm
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
        const ema10n = await getEma10n5m(symbol);
        if (ema10n === null) return null;

        // Lọc ema10n theo loại lệnh
        if (type === 'LONG' && ema10n <= 0.5) return null;
        if (type === 'SHORT' && ema10n >= -0.5) return null;

        const url1m = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1m&limit=30`;
        const res1m = await axios.get(url1m, { timeout: 5000 });
        if (!res1m.data || res1m.data.code !== '0' || res1m.data.data.length < 22) return null;

        const candles = res1m.data.data;
        const closedCandle1 = candles[1];
        const high1 = parseFloat(closedCandle1[2]);
        const low1 = parseFloat(closedCandle1[3]);

        const closedPrices = candles.slice(1, 21).reverse().map(c => parseFloat(c[4]));
        const bb = calculateBollingerBands(closedPrices, 20);
        if (!bb || bb.upper === 0 || bb.lower === 0) return null;

        const hBB = ((bb.upper - bb.lower) / bb.upper) * 100;
        if (hBB <= 2) return null;

        if (type === 'LONG') {
            const bbd = ((low1 - bb.lower) / bb.lower) * 100;
            if (bbd > -2 && bbd < 0.5) {
                return {
                    symbol,
                    type: 'LONG',
                    rank,
                    hBB,
                    ema10n,
                    diffVal: bbd,
                    diffLabel: 'bbd'
                };
            }
        } else if (type === 'SHORT') {
            const bbt = ((high1 - bb.upper) / bb.upper) * 100;
            if (bbt > -0.5 && bbt < 2) {
                return {
                    symbol,
                    type: 'SHORT',
                    rank,
                    hBB,
                    ema10n,
                    diffVal: bbt,
                    diffLabel: 'bbt'
                };
            }
        }

        return null;
    } catch (error) {
        console.error(`Lỗi kiểm tra nến (${symbol}):`, error.message);
        return null;
    }
}

// ------------------- HÀM CHÍNH -------------------
async function main() {
    try {
        console.log('--- BẮT ĐẦU QUÉT TOP 3 TĂNG/GIẢM (LƯU VÀO sent_ema.json) ---');

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

            // Kiểm tra cooldown 15 phút
            if (currentTime - lastSent >= COOLDOWN_TIME) {
                const coinName = signal.symbol.replace('-USDT-SWAP', '');
                const icon = signal.type === 'LONG' ? '🟢' : '🔴';
                const rankText = signal.type === 'LONG' ? `Top ${signal.rank} Tăng 24h` : `Top ${signal.rank} Giảm 24h`;
                const link = `https://www.okx.com/trade-swap/${signal.symbol.toLowerCase()}`;

                const message = `${icon} <b>${coinName} (${signal.type})</b>\n` +
                                `• Vị trí: <b>${rankText}</b>\n` +
                                `• ema10n (5m): <b>${signal.ema10n > 0 ? '+' : ''}${signal.ema10n.toFixed(2)}%</b>\n` +
                                `• Hbb (1m): <b>${signal.hBB.toFixed(2)}%</b>\n` +
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
            } else {
                const remainMin = Math.ceil((COOLDOWN_TIME - (currentTime - lastSent)) / 60000);
                console.log(`⏳ Bỏ qua ${signal.symbol} (${signal.type}) - Đang cooldown (còn ${remainMin} phút).`);
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

        // Lưu log mới vào file nếu có gửi tin
        if (hasNewAlert) {
            saveSentLog(sentLog);
        }

        console.log('--- HOÀN THÀNH QUÉT ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

main();
