import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;
const OKX_BASE_URL = 'https://www.okx.com';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'sentCoins.json');
const STATE_FILE = path.join(__dirname, 'state.json');

// Cấu hình Cooldown độc lập
const COOLDOWN_LONG = 48 * 60 * 60 * 1000; // 48 giờ cho tín hiệu Long (15m)
const COOLDOWN_SHORT = 4 * 60 * 60 * 1000;  // 4 giờ cho tín hiệu Short (1h)

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
            if (timeData._15m && now - timeData._15m < COOLDOWN_LONG) temp._15m = timeData._15m;
            if (timeData._1h && now - timeData._1h < COOLDOWN_SHORT) temp._1h = timeData._1h;
            if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

// Hàm tính mảng RSI-20 chuẩn mượt Wilder cho toàn bộ chuỗi giá
function calculateRSIHistory(prices, period = 20) {
    const rsiHistory = new Array(prices.length).fill(null);
    if (prices.length <= period) return rsiHistory;

    let gains = 0;
    let losses = 0;

    // Bước khởi tạo đầu tiên
    for (let i = 1; i <= period; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff > 0) gains += diff;
        else losses -= diff;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    rsiHistory[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + (avgGain / avgLoss));

    // Làm mượt Wilder's Smoothing cho toàn bộ chuỗi còn lại
    for (let i = period + 1; i < prices.length; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff > 0) {
            avgGain = (avgGain * (period - 1) + diff) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) - diff) / period;
        }
        rsiHistory[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + (avgGain / avgLoss));
    }

    return rsiHistory;
}

// Hàm lấy dữ liệu nến và tính toán lịch sử RSI-20 cho coin
async function getRSIHistoryForCoin(symbol, barFrame) {
    try {
        // Lấy 65 nến để lịch sử tính RSI-20 đạt độ chính xác tối ưu nhất
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=${barFrame}&limit=65`;
        const response = await axios.get(url, { timeout: 5000 });
        if (response.data && response.data.code === '0' && response.data.data.length >= 35) {
            const candles = response.data.data.reverse(); // Đảo từ cũ đến mới
            const prices = candles.map(c => parseFloat(c[4])); // Lấy chuỗi giá Close
            return calculateRSIHistory(prices, 20);
        }
    } catch (error) {}
    return null;
}

async function main() {
    try {
        console.log('--- BẤT ĐẦU CHẠY BOT QUÉT TÍN HIỆU THEO ATR % ĐÃ ĐỒNG BỘ ---');

        // 1. Đọc dữ liệu từ state.json (Đã tối ưu cấu trúc Map dạng { symbol: atrPercent })
        if (!fs.existsSync(STATE_FILE)) {
            console.log('Không tìm thấy file state.json!');
            return;
        }
        const stateData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        const qualifiedCoinsMap = stateData.qualifiedCoins || {};
        const qualifiedCoins = Object.keys(qualifiedCoinsMap); // Chuyển danh sách Key thành mảng các Symbol

        if (qualifiedCoins.length === 0) {
            console.log('Danh sách lọc qualifiedCoins trống.');
            return;
        }

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        // 2. XỬ LÝ LỆNH LONG: Khung 15m (RSI20 > 70) | Cooldown 48h
        console.log(`Đang quét tín hiệu LONG cho ${qualifiedCoins.length} coin (Khung 15m)...`);
        for (const symbol of qualifiedCoins) {
            if (!sentLog[symbol]) sentLog[symbol] = { _15m: 0, _1h: 0 };
            const coinLog = sentLog[symbol];

            // Chỉ xử lý nếu đã hết thời gian chặn Cooldown 48h
            if (currentTime - (coinLog._15m || 0) >= COOLDOWN_LONG) {
                const rsiHistory = await getRSIHistoryForCoin(symbol, '15m');
                if (rsiHistory && rsiHistory[rsiHistory.length - 1] !== null) {
                    const rsiCurrent = rsiHistory[rsiHistory.length - 1]; // RSI của cây nến hiện tại [1]

                    if (rsiCurrent > 70) {
                        // TỐI ƯU: Đọc trực tiếp ATR% lưu trong file state.json thay vì gọi API lấy nến
                        const atrPercent = qualifiedCoinsMap[symbol] || 0;
                        const coinName = symbol.replace('-USDT-SWAP', '');
                        const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                        const message = `🟢 <b>TÍN HIỆU LONG (15M)</b>\n` +
                                        `🔥 Coin: <b>#${coinName}</b>\n` +
                                        `📊 Chỉ số RSI-20 (15m): <code>${rsiCurrent.toFixed(2)}</code> (&gt; 70)\n` +
                                        `⚡ ATR% (lưu lúc 7h): <code>${atrPercent.toFixed(3)}%</code>\n` +
                                        `👉 <a href="${link}">Giao dịch ngay</a>`;

                        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                            chat_id: TELEGRAM_CHAT_ID,
                            text: message,
                            parse_mode: 'HTML'
                        }).catch(() => {});

                        sentLog[symbol]._15m = currentTime;
                        hasNewAlert = true;
                    }
                }
                await sleep(50); // Tránh bị dính Rate Limit của sàn
            }
        }

        // 3. XỬ LÝ LỆNH SHORT: Khung 1h (RSI_nay - RSI_truoc < -8) | Cooldown 4h
        console.log(`Đang quét tín hiệu SHORT cho ${qualifiedCoins.length} coin (Khung 1h)...`);
        for (const symbol of qualifiedCoins) {
            if (!sentLog[symbol]) sentLog[symbol] = { _15m: 0, _1h: 0 };
            const coinLog = sentLog[symbol];

            // Chỉ xử lý nếu đã hết thời gian chặn Cooldown 4h
            if (currentTime - (coinLog._1h || 0) >= COOLDOWN_SHORT) {
                const rsiHistory = await getRSIHistoryForCoin(symbol, '1h');
                if (rsiHistory && rsiHistory.length >= 2) {
                    const rsiCurrent = rsiHistory[rsiHistory.length - 1];  // RSI nến hiện hành [1]
                    const rsiPrevious = rsiHistory[rsiHistory.length - 2]; // RSI nến trước đó [2]

                    if (rsiCurrent !== null && rsiPrevious !== null) {
                        const diffRsi = rsiCurrent - rsiPrevious;

                        if (diffRsi < -8) { // Độ sụt giảm RSI đột ngột mạnh hơn 8 đơn vị
                            // TỐI ƯU: Đọc trực tiếp ATR% lưu trong file state.json thay vì gọi API lấy nến
                            const atrPercent = qualifiedCoinsMap[symbol] || 0;
                            const coinName = symbol.replace('-USDT-SWAP', '');
                            const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                            const message = `🔴 <b>TÍN HIỆU SHORT (1H)</b>\n` +
                                            `🔥 Coin: <b>#${coinName}</b>\n` +
                                            `📊 RSI-20 hiện tại [1]: <code>${rsiCurrent.toFixed(2)}</code>\n` +
                                            `📉 RSI-20 trước đó [2]: <code>${rsiPrevious.toFixed(2)}</code>\n` +
                                            `📐 Chênh lệch (Δ): <code>${diffRsi.toFixed(2)}</code> (&lt; -8)\n` +
                                            `⚡ ATR% (lưu lúc 7h): <code>${atrPercent.toFixed(3)}%</code>\n` +
                                            `👉 <a href="${link}">Giao dịch ngay</a>`;

                            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                                chat_id: TELEGRAM_CHAT_ID,
                                text: message,
                                parse_mode: 'HTML'
                            }).catch(() => {});

                            sentLog[symbol]._1h = currentTime;
                            hasNewAlert = true;
                        }
                    }
                }
                await sleep(50); // Tránh bị dính Rate Limit của sàn
            }
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- KẾT THÚC TIẾN TRÌNH QUÉT KHUNG 15M / 1H ---');
    } catch (err) {
        console.error('Lỗi chạy chính bot.js:', err.message);
    }
}

main();
