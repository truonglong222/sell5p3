import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;
const OKX_BASE_URL = 'https://www.okx.com';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'sent_rsi.json');
const STATE_5D_FILE = path.join(__dirname, 'statetop_5d.json');

// Khóa chống trùng tín hiệu bắn liên tục trong vòng 24 giờ cho mỗi đồng coin
const COOLDOWN_TIME = 24 * 60 * 60 * 1000;
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
        for (const [coin, timestamp] of Object.entries(logData)) {
            if (now - timestamp < COOLDOWN_TIME) {
                cleanedLog[coin] = timestamp;
            }
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

// Hàm tính mảng RSI-20 chuẩn mượt Wilder
function calculateRSI(prices, period = 20) {
    if (prices.length <= period) return null;

    let gains = 0;
    let losses = 0;

    // Bước khởi tạo đầu tiên cho SMA ban đầu
    for (let i = 1; i <= period; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff > 0) gains += diff;
        else losses -= diff;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Tính lũy tiến bằng Wilder's Smoothing cho phần lịch sử còn lại
    for (let i = period + 1; i < prices.length; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff > 0) {
            avgGain = (avgGain * (period - 1) + diff) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) - diff) / period;
        }
    }

    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + (avgGain / avgLoss));
}

// Hàm lấy dữ liệu nến khung 15m và tính toán RSI-20 của nến hiện tại
async function getRSI15mForCoin(symbol) {
    try {
        // Lấy 65 nến khung 15m để đảm bảo lịch sử mượt Wilder đạt độ chính xác tối ưu nhất
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=65`;
        const response = await axios.get(url, { timeout: 5000 });
        
        if (response.data && response.data.code === '0' && response.data.data.length >= 35) {
            const candles = response.data.data.reverse(); // Đảo từ nến cũ đến nến mới nhất
            const prices = candles.map(c => parseFloat(c[4])); // Trích xuất chuỗi giá Close
            return calculateRSI(prices, 20);
        }
    } catch (error) {
        // Tránh nghẽn tiến trình khi một vài coin bị lỗi mạng cục bộ
    }
    return null;
}

async function main() {
    try {
        console.log('--- BẤT ĐẦU QUY TRÌNH QUÉT RSI COIN HỒI PHỤC (KHUNG 15M) ---');

        // 1. Kiểm tra sự tồn tại của file cấu trúc dữ liệu nguồn
        if (!fs.existsSync(STATE_5D_FILE)) {
            console.log('Không tìm thấy file statetop_5d.json! Vui lòng chạy file top_5d.js trước.');
            return;
        }

        const stateData = JSON.parse(fs.readFileSync(STATE_5D_FILE, 'utf8'));
        const top20Losers = stateData.top20Losers || [];

        if (top20Losers.length === 0) {
            console.log('Danh sách top20Losers trống trong file json.');
            return;
        }

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        // 2. Chạy vòng lặp kiểm tra RSI cho từng coin
        console.log(`Đang quét RSI-20 cho ${top20Losers.length} coin từ danh sách giảm giá 5 ngày...`);
        for (const symbol of top20Losers) {
            const lastSent = sentLog[symbol] || 0;

            // Kiểm tra cooldown khóa chống trùng lặp tin nhắn (24h)
            if (currentTime - lastSent >= COOLDOWN_TIME) {
                const rsiCurrent = await getRSI15mForCoin(symbol);
                
                if (rsiCurrent !== null) {
                    console.log(`-> ${symbol} | RSI-20 (15m): ${rsiCurrent.toFixed(2)}`);

                    // Điều kiện kích hoạt: RSI nến hiện hành > 66
                    if (rsiCurrent > 66) {
                        const coinName = symbol.replace('-USDT-SWAP', '');
                        const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                        const message = `🟢 <b>TÍN HIỆU LONG RSI (15M)</b>\n` +
                                        `🔥 Coin: <b>#${coinName}</b> (Nhóm giảm sâu 5 ngày)\n` +
                                        `📊 Chỉ số RSI-20 (15m): <code>${rsiCurrent.toFixed(2)}</code> (&gt; 66)\n` +
                                        `👉 <a href="${link}">Giao dịch ngay trên OKX</a>`;

                        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                            chat_id: TELEGRAM_CHAT_ID,
                            text: message,
                            parse_mode: 'HTML'
                        }).catch(() => {});

                        sentLog[symbol] = currentTime;
                        hasNewAlert = true;
                        console.log(`✓ Đã kích hoạt báo LONG cho #${coinName} về Telegram.`);
                    }
                }
                await sleep(100); // Khoảng nghỉ nhỏ bảo vệ Rate limit tránh lỗi 429 từ sàn OKX
            }
        }

        if (hasNewAlert) saveSentLog(sentLog);
        console.log('--- KẾT THÚC TIẾN TRÌNH QUÉT BOT RSI.JS ---');

    } catch (err) {
        console.error('Lỗi hệ thống trong file rsi.js:', err.message);
    }
}

main();
