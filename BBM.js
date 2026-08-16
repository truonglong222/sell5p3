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

// Ghi file 24h.json (Lưu danh sách Nhóm A kèm diffbbl1d)
function save24hJson(groupedData) {
    try {
        const dataToSave = {
            updatedAt: new Date().toISOString(),
            counts: {
                groupLessThanNeg2_5: groupedData.groupLessThanNeg2_5.length
            },
            data: groupedData
        };
        fs.writeFileSync(FILE_24H, JSON.stringify(dataToSave, null, 2), 'utf8');
        console.log(`💾 Đã lưu phân loại NHÓM A SHORT diffEMA vào ${FILE_24H}`);
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

// ------------------- HÀM TÍNH BIẾN ĐỘNG 60H -------------------
function calculateVol60h(raw1H) {
    if (!raw1H || raw1H.length < 60) return null;

    const close1 = parseFloat(raw1H[1][4]);
    const close60 = parseFloat(raw1H[59][4]);

    if (close60 === 0) return null;
    return ((close1 - close60) / close60) * 100;
}

// ------------------- LẤY NẾN KHUNG 1D & TÍNH DIFF BB LOWER 1D -------------------
async function checkDiff1D(symbol) {
    try {
        const url1D = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1D&limit=30`;
        const res1D = await axios.get(url1D, { timeout: 5000 });

        if (!res1D.data || res1D.data.code !== '0' || res1D.data.data.length < 20) return null;

        const raw1D = res1D.data.data;
        
        // Giá hiện tại của nến 1D đang chạy (raw1D[0][4])
        const currentPrice = parseFloat(raw1D[0][4]);
        if (currentPrice === 0) return null;

        // Lấy 20 nến 1D gần nhất TÍNH CẢ NẾN ĐANG CHẠY (raw1D[0] đến raw1D[19]) để tính BB 1D
        const prices1D = raw1D.slice(0, 20).reverse().map(c => parseFloat(c[4]));
        const bb1D = calculateBollingerBands(prices1D, 20);

        if (!bb1D || bb1D.lower === 0) return null;

        // Công thức: (giá hiện tại - BB Lower nến đang chạy) / giá hiện tại * 100
        const diffbbl1d = ((currentPrice - bb1D.lower) / currentPrice) * 100;

        return {
            diffbbl1d,
            currentPrice,
            bbLower1D: bb1D.lower
        };
    } catch (error) {
        console.error(`Lỗi lấy dữ liệu 1D (${symbol}):`, error.message);
        return null;
    }
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

// ------------------- KIỂM TRA ĐIỀU KIỆN SHORT NẾN ĐANG CHẠY (NHÓM A) -------------------
function checkSignalGroupA(coinData) {
    const { raw1H } = coinData;
    const candle0 = raw1H[0];
    const highPrice0 = parseFloat(candle0[2]); 

    // Lấy 20 nến 1H vừa mới ĐÓNG (raw1H[1] đến raw1H[20])
    const closedForBB = raw1H.slice(1, 21).reverse().map(c => parseFloat(c[4]));
    const bb = calculateBollingerBands(closedForBB, 20);
    if (!bb || bb.upper === 0) return null;

    // Tính độ rộng Bollinger Band (Hbb)
    const hBB = ((bb.upper - bb.lower) / bb.upper) * 100;

    // Tính khoảng cách giữa High nến hiện tại và BB Upper 1H
    const diffbbu = ((highPrice0 - bb.upper) / bb.upper) * 100;
    
    // Điều kiện: Dung sai -0.5% < diffbbu < 2%
    if (diffbbu > -0.5 && diffbbu < 2) {
        return { 
            type: 'SHORT', 
            diffBB: diffbbu, 
            diffbbu: diffbbu,
            hBB: hBB, 
            targetBB: 'BB Upper' 
        };
    }
    return null;
}

// ------------------- HÀM CHÍNH -------------------
async function main() {
    try {
        console.log('--- BẮT ĐẦU TIẾN TRÌNH QUÉT THỊ TRƯỜNG (NHÓM A SHORT) ---');

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        // Bộ đếm thống kê qua từng bước lọc
        const stats = {
            step1_volume5M: 0,
            step2_validEma: 0,
            step3_groupA_diffEma: 0,     // diffEMA < -2.5%
            step4_groupA_signalBB: 0,    // -0.5% < diffbbu < 2%
            step5_groupA_diffbbl1d: 0,   // diffbbl1d > 2%
            step6_passedCooldown: 0      // Vượt qua thời gian chờ & gửi Telegram
        };

        // BƯỚC 1: Lấy các coin có Volume > 5M USDT
        const highVolCoins = await getHighVolumeCoins();
        stats.step1_volume5M = highVolCoins.length;
        console.log(`📋 [Bước 1] Tìm thấy ${stats.step1_volume5M} coins có Vol 24h >= 5M USDT...`);

        // BƯỚC 2: Tính diffEMA cho tất cả coin vừa lọc được
        console.log('⏳ [Bước 2] Đang tính diffEMA cho các coin...');
        const calculatedCoins = [];

        for (const coin of highVolCoins) {
            const data = await getCoinDataWithDiffEma(coin.instId, coin.volCcy24h);
            if (data) calculatedCoins.push(data);
            await sleep(80);
        }
        stats.step2_validEma = calculatedCoins.length;

        // BƯỚC 3: Phân loại NHÓM A (diffEMA < -2.5%) & Tính Vol 60h, diffbbl1d
        console.log('⏳ [Bước 3] Đang lọc Nhóm A (diffEMA < -2.5%) và lấy dữ liệu 1D...');
        const groupA = [];
        for (const c of calculatedCoins) {
            if (c.diffEMA < -2.5) {
                const vol60h = calculateVol60h(c.raw1H);
                c.vol60h = vol60h !== null ? vol60h : 0;

                // Lấy diffbbl1d theo công thức mới
                const data1D = await checkDiff1D(c.symbol);
                c.diffbbl1d = data1D ? data1D.diffbbl1d : null;
                groupA.push(c);

                await sleep(60); // Buffer rate-limit
            }
        }
        stats.step3_groupA_diffEma = groupA.length;

        // Định dạng lưu file (có diffbbl1d)
        const formatItemA = c => ({
            symbol: c.symbol,
            diffEMA: parseFloat(c.diffEMA.toFixed(2)),
            vol60h: parseFloat(c.vol60h.toFixed(2)),
            diffbbl1d: c.diffbbl1d !== null ? parseFloat(c.diffbbl1d.toFixed(2)) : null,
            volCcy24h: c.volCcy24h
        });

        // BƯỚC 4: Ghi vào file 24h.json
        save24hJson({ groupLessThanNeg2_5: groupA.map(formatItemA) });

        // BƯỚC 5: Hàm gửi Tín Hiệu SHORT về Telegram
        const sendAlert = async (symbol, type, diffEmaVal, cooldownKey, extraData = {}) => {
            if (!sentLog[symbol]) sentLog[symbol] = {};
            const lastSent = sentLog[symbol][cooldownKey] || 0;

            if (currentTime - lastSent >= COOLDOWN_TIME) {
                stats.step6_passedCooldown++;
                const coinName = symbol.replace('-USDT-SWAP', '');
                const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                let message = `🔴 <b>${coinName} (${type})</b>\n` +
                              `• DiffEMA: <b>${diffEmaVal > 0 ? '+' : ''}${diffEmaVal.toFixed(2)}%</b>\n`;

                if (extraData.diffbbu !== undefined) {
                    message += `• DiffBBu (1H): <b>${extraData.diffbbu > 0 ? '+' : ''}${extraData.diffbbu.toFixed(2)}%</b>\n`;
                }

                if (extraData.diffbbl1d !== undefined && extraData.diffbbl1d !== null) {
                    message += `• DiffBBL (1D): <b>${extraData.diffbbl1d > 0 ? '+' : ''}${extraData.diffbbl1d.toFixed(2)}%</b>\n`;
                }

                if (extraData.hBB !== undefined) {
                    message += `• Hbb (BB Width): <b>${extraData.hBB.toFixed(2)}%</b>\n`;
                }

                if (extraData.vol60h !== undefined) {
                    message += `• Vol 60h: <b>${extraData.vol60h > 0 ? '+' : ''}${extraData.vol60h.toFixed(2)}%</b>\n`;
                }

                message += `• <a href="${link}">Trade trên OKX</a>`;

                console.log(`🚀 [${type} MATCHED] Gửi Telegram cho ${symbol}...`);
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

                sentLog[symbol][cooldownKey] = currentTime;
                hasNewAlert = true;
            } else {
                const remainingMin = Math.ceil((COOLDOWN_TIME - (currentTime - lastSent)) / 60000);
                console.log(`⏳ [COOLDOWN] ${symbol} đã gửi tín hiệu, còn ${remainingMin} phút.`);
            }
        };

        // BƯỚC 6: Quét tín hiệu NHÓM A (diffEMA < -2.5%)
        console.log(`🔍 [Bước 4 & 5] Quét tín hiệu NHÓM A (${groupA.length} coins)...`);
        for (const item of groupA) {
            const sig = checkSignalGroupA(item);
            if (sig) {
                stats.step4_groupA_signalBB++;

                // Điều kiện lọc: diffbbl1d > 2%
                if (item.diffbbl1d !== null && item.diffbbl1d > 2) {
                    stats.step5_groupA_diffbbl1d++;
                    await sendAlert(item.symbol, 'SHORT', item.diffEMA, '_short1h', { 
                        vol60h: item.vol60h,
                        diffbbu: sig.diffbbu,
                        diffbbl1d: item.diffbbl1d,
                        hBB: sig.hBB 
                    });
                } else {
                    console.log(`⏩ [LỌC 1D LOẠI] ${item.symbol} vì diffbbl1d (${item.diffbbl1d !== null ? item.diffbbl1d.toFixed(2) : 'N/A'}% <= 2%)`);
                }
            }
        }

        if (hasNewAlert) saveSentLog(sentLog);

        // BÁO CÁO PHỄU LỌC TỔNG KẾT
        console.log('\n================ BÁO CÁO PHỄU LỌC (FUNNEL REPORT) ================');
        console.log(`1. Volume >= 5M USDT                 : ${stats.step1_volume5M} coins`);
        console.log(`2. Lấy đủ nến & tính diffEMA         : ${stats.step2_validEma} coins`);
        console.log(`3. Nhóm A (diffEMA < -2.5%)          : ${stats.step3_groupA_diffEma} coins`);
        console.log(`4. Khớp BB 1H (-0.5% < diffbbu < 2%) : ${stats.step4_groupA_signalBB} coins`);
        console.log(`5. Khớp BB 1D (diffbbl1d > 2%)       : ${stats.step5_groupA_diffbbl1d} coins`);
        console.log(`6. Bắn Telegram (qua Cooldown)       : ${stats.step6_passedCooldown} coins`);
        console.log('==================================================================\n');

        console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}

// Thực thi chương trình
main();
