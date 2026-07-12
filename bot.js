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

// Hàm đọc lịch sử gửi từ file JSON
function loadSentLog() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            return data.trim() ? JSON.parse(data) : {};
        }
    } catch (e) {}
    return {};
}

// Cập nhật dọn dẹp log cũ sau 2 giờ để đồng bộ với Cooldown mới
function saveSentLog(logData) {
    try {
        const now = Date.now();
        const cleanedLog = {};
        for (const [coin, timestamp] of Object.entries(logData)) {
            if (now - timestamp < 2 * 60 * 60 * 1000) { // Cooldown 2h
                cleanedLog[coin] = timestamp;
            }
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (e) {}
}

// Hàm tính EMA chuẩn kỹ thuật
function calculateEMA(prices, period = 20) {
    if (prices.length < period) return 0;
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;
    for (let i = period; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
}

// Thu thập 150 nến 5m và tính toán song song EMA20_5m & EMA20_15m
async function getTechnicalMetrics(symbol) {
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=5m&limit=150`;
        const response = await axios.get(url, { timeout: 8000 });
        
        if (response.data && response.data.code === '0' && response.data.data.length >= 100) {
            const candles5m = response.data.data.reverse();
            
            const currentCandle = candles5m[candles5m.length - 1];
            const currentHigh = parseFloat(currentCandle[2]);
            const currentLow = parseFloat(currentCandle[3]);

            // ==========================================
            // THÀNH PHẦN 1: TÍNH EMA20 CHO KHUNG 5M
            // ==========================================
            const closedCandles5m = candles5m.slice(0, candles5m.length - 1);
            const prices5m = closedCandles5m.map(c => parseFloat(c[4]));
            const ema20_5m = calculateEMA(prices5m, 20);

            // ==========================================
            // THÀNH PHẦN 2: TÍNH EMA20 KHUNG 15M TỪ NẾN 5M
            // ==========================================
            const prices15m = [];
            for (let i = 2; i < closedCandles5m.length; i += 3) {
                prices15m.push(parseFloat(closedCandles5m[i][4]));
            }
            const ema20_15m = calculateEMA(prices15m, 20);

            // ==========================================
            // THÀNH PHẦN 3: TÍNH TOÁN ĐỘ GẦN (HỆ SỐ KHOẢNG CÁCH)
            // ==========================================
            const a_5m = ema20_5m ? ((ema20_5m - currentLow) / ema20_5m) * 100 : 999;
            const b_5m = ema20_5m ? ((ema20_5m - currentHigh) / ema20_5m) * 100 : 999;

            const a_15m = ema20_15m ? ((ema20_15m - currentLow) / ema20_15m) * 100 : 999;
            const b_15m = ema20_15m ? ((ema20_15m - currentHigh) / ema20_15m) * 100 : 999;

            return { symbol, a_5m, b_5m, a_15m, b_15m };
        }
        return null;
    } catch (error) {
        return null;
    }
}

async function main() {
    try {
        // BƯỚC 1: Đọc giá mở cửa 7h sáng từ file state.json
        if (!fs.existsSync(STATE_FILE)) {
            console.error('Không tìm thấy dữ liệu mốc 7h sáng trong file state.json!');
            return;
        }
        const stateData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        const openPrices7AM = stateData.openPrices || {};

        // BƯỚC 2: Lấy toàn bộ ticker danh sách Futures OKX (1 request tổng)
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);
        if (!response.data || response.data.code !== '0') return;

        const sentLog = loadSentLog();
        const currentTime = Date.now();

        // BƯỚC 3: Tính % tăng/giảm kể từ mốc 7h sáng trong bộ nhớ
        let calculatedPool = response.data.data
            .filter(t => t.instId.endsWith('-USDT-SWAP') && openPrices7AM[t.instId])
            .map(t => {
                const open7AM = openPrices7AM[t.instId];
                const lastPrice = parseFloat(t.last);
                
                // ĐÃ SỬA CỐT LÕI: Lấy vol24h để tính chuẩn Volume bằng USDT thay vì số lượng coin rác
                const vol24hQuote = parseFloat(t.vol24h); 
                
                const changeSince7AM = ((lastPrice - open7AM) / open7AM) * 100;
                return { instId: t.instId, changeSince7AM, lastPrice, vol24hQuote };
            });

        // BƯỚC 4: Lấy danh sách Top 10 Tăng mạnh nhất + Top 10 Giảm sâu nhất từ 7h
        let top10Gainers = [...calculatedPool].sort((a, b) => b.changeSince7AM - a.changeSince7AM).slice(0, 10);
        let top10Losers = [...calculatedPool].sort((a, b) => a.changeSince7AM - b.changeSince7AM).slice(0, 10);

        // Trộn 2 danh sách lại vào một cấu trúc Map chung để phân loại hướng lệnh
        let rankingPool = new Map();
        top10Gainers.forEach((c, i) => rankingPool.set(c.instId, { ...c, mode: 'long', label: `TOP ${i + 1} TĂNG` }));
        top10Losers.forEach((c, i) => {
            if (!rankingPool.has(c.instId)) {
                rankingPool.set(c.instId, { ...c, mode: 'short', label: `TOP ${i + 1} GIẢM` });
            } else {
                rankingPool.get(c.instId).mode = 'both';
            }
        });

        // BƯỚC 5: Bộ lọc Volume chuẩn đô la -> Loại bỏ toàn bộ các coin có Volume 24h dưới 5 triệu đô ($5.000.000)
        for (const [symbol, coinData] of rankingPool.entries()) {
            if (coinData.vol24hQuote < 5000000) {
                console.log(`[Bỏ qua Volume Thấp] ${symbol} bị loại vì Vol 24h chỉ đạt $${(coinData.vol24hQuote / 1000000).toFixed(2)}M (< $5M)`);
                rankingPool.delete(symbol);
            }
        }

        if (rankingPool.size === 0) {
            console.log('Không có coin nào trong Top 10 vượt qua được bộ lọc Volume Khối lượng > 5 Triệu $.');
            return;
        }

        // BƯỚC 6: Lấy 150 nến 5m xử lý đa khung thời gian song song (Promise.all)
        console.log(`Đang chạy tính toán đa khung EMA (5m & 15m) cho ${rankingPool.size} coin đạt chuẩn Vol...`);
        const technicalPromises = Array.from(rankingPool.keys()).map(symbol => getTechnicalMetrics(symbol));
        const technicalResults = await Promise.all(technicalPromises);

        let hasNewAlert = false;

        // BƯỚC 7 & 8: ĐỐI CHIẾU ĐIỀU KIỆN LONG/SHORT VÀ LOẠI BỎ COOLDOWN 2 GIỜ Ở BƯỚC CUỐI CÙNG
        for (const [symbol, coinData] of rankingPool) {
            
            // Bộ lọc kiểm tra Cooldown chặn 2 giờ
            if (sentLog[symbol] && (currentTime - sentLog[symbol] < 2 * 60 * 60 * 1000)) {
                continue; 
            }

            const metrics = technicalResults.find(r => r && r.symbol === symbol);
            if (!metrics) continue;

            let signal = null;
            const mode = coinData.mode;

            // --- KIỂM TRA ĐIỀU KIỆN CHIỀU LONG ---
            if (mode === 'long' || mode === 'both') {
                const closeToEma5m = (metrics.a_5m >= -0.5 && metrics.a_5m <= 1);
                const closeToEma15m = (metrics.a_15m >= -0.5 && metrics.a_15m <= 1);
                
                if (closeToEma5m || closeToEma15m) {
                    signal = "Long 5p";
                }
            }

            // --- KIỂM TRA ĐIỀU KIỆN CHIỀU SHORT ---
            if (mode === 'short' || mode === 'both') {
                const closeToEma5m = (metrics.b_5m >= -1 && metrics.b_5m <= 0.5);
                const closeToEma15m = (metrics.b_15m >= -1 && metrics.b_15m <= 0.5);

                if (closeToEma5m || closeToEma15m) {
                    signal = "Short 5p";
                }
            }

            // BƯỚC 9: BẮN THÔNG BÁO TELEGRAM SIÊU RÚT GỌN 1 DÒNG
            if (signal) {
                const coinName = symbol.replace('-USDT-SWAP', '');
                const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
                const icon = signal.startsWith("Long") ? "🟢" : "🔴";
                const formattedPct = coinData.changeSince7AM >= 0 ? `+${coinData.changeSince7AM.toFixed(2)}%` : `${coinData.changeSince7AM.toFixed(2)}%`;

                const message = `${icon} <b>${signal.toUpperCase()} #${coinName} ${coinData.label} (${formattedPct})</b> 👉 <a href="${link}">Giao dịch ngay</a>`;

                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML'
                }).catch(() => {});

                sentLog[symbol] = currentTime;
                hasNewAlert = true;
            }
        }

        if (hasNewAlert) {
            saveSentLog(sentLog);
        }
        console.log('Hoàn thành chu kỳ quét đa khung thời gian kết hợp lọc Volume chuẩn xác.');

    } catch (err) {
        console.error('Lỗi trong hàm xử lý chính bot.js:', err.message);
    }
}

main();
