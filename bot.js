// Sử dụng cú pháp ES Modules (import) theo cấu hình package.json của bạn
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Cấu hình lấy từ biến môi trường (Environment Variables trên GitHub Secrets)
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;

const OKX_BASE_URL = 'https://www.okx.com';
const GITHUB_CACHE_URL = 'https://raw.githubusercontent.com/truonglong222/3d/main/cache.json';

// Định nghĩa __dirname cho môi trường ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'sentCoins.json');

// Hàm đọc lịch sử gửi từ file JSON
function loadSentLog() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            return data.trim() ? JSON.parse(data) : {};
        }
    } catch (error) {
        console.error('Lỗi khi đọc file json log:', error.message);
    }
    return {};
}

// Hàm ghi lịch sử gửi vào file JSON (Xóa bớt log cũ sau 30 phút để nhẹ file)
function saveSentLog(logData) {
    try {
        const now = Date.now();
        const cleanedLog = {};
        for (const [coin, timestamp] of Object.entries(logData)) {
            if (now - timestamp < 30 * 60 * 1000) {
                cleanedLog[coin] = timestamp;
            }
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
    } catch (error) {
        console.error('Lỗi khi ghi file json log:', error.message);
    }
}

// Hàm trì hoãn để tránh bị sàn chặn lỗi 429 Too Many Requests
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Công thức tính RSI chuẩn kỹ thuật với chu kỳ mặc định là 20
function calculateRSI(prices, period = 20) {
    if (prices.length <= period) return 0;
    
    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        let difference = prices[i] - prices[i - 1];
        if (difference >= 0) gains += difference;
        else losses -= difference;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < prices.length; i++) {
        let difference = prices[i] - prices[i - 1];
        let gain = difference >= 0 ? difference : 0;
        let loss = difference < 0 ? -difference : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) return 100;
    let rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// Lấy dữ liệu danh sách coin từ GitHub Cache
async function fetchGithubCache() {
    try {
        const response = await axios.get(GITHUB_CACHE_URL);
        if (response.data) {
            if (Array.isArray(response.data)) {
                return response.data.map(item => String(item).toUpperCase());
            } else if (typeof response.data === 'object') {
                const keys = Object.keys(response.data);
                for (let key of keys) {
                    if (Array.isArray(response.data[key])) {
                        return response.data[key].map(item => String(item).toUpperCase());
                    }
                }
            }
        }
        return [];
    } catch (error) {
        console.error('Lỗi khi đọc danh sách cache từ GitHub:', error.message);
        return [];
    }
}

// Gọi API lấy dữ liệu nến của OKX, trả về RSI và % biến động giá theo từng khung giờ chuyên biệt
async function getMarketMetrics(symbol, bar, lastPrice = 0) {
    try {
        await sleep(250); // Nghỉ 250ms tối ưu Rate Limit
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=75`;
        const response = await axios.get(url);
        
        if (response.data && response.data.code === '0' && response.data.data.length > 25) {
            const candles = response.data.data.reverse();
            
            // Đối với OKX sau khi reverse():
            // - candles[candles.length - 1] là nến HIỆN TẠI đang chạy.
            // - candles[candles.length - 2] là nến VỪA ĐÓNG.
            // - candles[candles.length - 3] là nến TRƯỚC CỦA CÂY NẾN VỪA ĐÓNG (nến trước).
            
            if (bar === '4H') {
                // SỬA ĐỔI THEO YÊU CẦU: Tính biến động 4h từ Giá mở cửa của cây nến trước (index length - 3) đến giá hiện tại
                // Nếu mảng nến không đủ độ dài thì dự phòng lấy nến cũ hơn
                const prevCandleIndex = candles.length >= 3 ? candles.length - 3 : candles.length - 2;
                const prevOpenPrice = parseFloat(candles[prevCandleIndex][1]); // Giá mở cửa của nến trước
                
                // Tính toán tỷ lệ dựa trên giá khớp lệnh hiện tại (lastPrice truyền từ ticker)
                const changePct4h = prevOpenPrice ? ((lastPrice - prevOpenPrice) / prevOpenPrice) * 100 : 0;
                
                return { rsi20: 0, changePct: changePct4h };
            } else {
                // Giữ nguyên logic cho khung 15m cũ
                const closedIndex = candles.length - 2;
                const historyForRSI = candles.slice(0, closedIndex + 1).map(c => parseFloat(c[4]));
                const rsi20 = calculateRSI(historyForRSI, 20);

                const closedCandle = candles[closedIndex];
                const o = parseFloat(closedCandle[1]);
                const c = parseFloat(closedCandle[4]);
                const changePct15m = o ? ((c - o) / o) * 100 : 0;

                return { rsi20, changePct: changePct15m };
            }
        }
        return { rsi20: 0, changePct: 0 };
    } catch (error) {
        console.error(`Lỗi khi lấy dữ liệu nến (${bar}) cho ${symbol}:`, error.message);
        return { rsi20: 0, changePct: 0 };
    }
}

// Hàm gửi nội dung tin nhắn về Telegram Chat thông qua HTTP POST
async function sendTelegramMessage(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: false
        });
        console.log('Đã gửi thông báo Telegram thành công.');
    } catch (error) {
        console.error('Lỗi khi gửi Telegram:', error.message);
    }
}

// Luồng xử lý dữ liệu chính
async function main() {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.error('Thiếu cấu hình BOT_TOKEN hoặc CHAT_ID trong Environment Variables!');
        return;
    }

    try {
        console.log('Đang tải danh sách coin từ cache GitHub...');
        const githubCache = await fetchGithubCache();
        console.log(`Đã tải xong cache (${githubCache.length} coins).`);

        console.log('Đang lấy danh sách các cặp coin Future trên OKX...');
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);

        if (!response.data || response.data.code !== '0') {
            console.error('Không thể lấy dữ liệu từ OKX');
            return;
        }

        const sentLog = loadSentLog();
        const currentTime = Date.now();

        // Lọc ra các cặp phái sinh thanh toán bằng cặp USDT (Ví dụ: BTC-USDT-SWAP)
        let tickers = response.data.data
            .filter(t => t.instId.endsWith('-USDT-SWAP'))
            .map(t => {
                const open24h = parseFloat(t.open24h);
                const lastPrice = parseFloat(t.last);
                const change24h = open24h ? ((lastPrice - open24h) / open24h) * 100 : 0;
                return {
                    instId: t.instId, 
                    change24h: change24h,
                    lastPrice: lastPrice
                };
            });

        // Sắp xếp giảm dần theo tăng trưởng giá 24h
        tickers.sort((a, b) => b.change24h - a.change24h);
        
        // Cắt lấy top 30 phục vụ cho cả điều kiện lọc Long (Top 10) và Short (Top 4 - Top 30)
        const targetList = tickers.slice(0, 30);

        console.log('Bảng xếp hạng tăng mạnh nhất OKX (Top 30):');
        console.table(targetList.map((t, index) => ({ Rank: index + 1, Coin: t.instId, 'Change 24h': t.change24h.toFixed(2) + '%' })));

        let hasNewAlert = false;

        // Vòng lặp quét kiểm tra đối với từng đồng coin trong danh sách
        for (let i = 0; i < targetList.length; i++) {
            const coin = targetList[i];
            const symbol = coin.instId;
            const rank = i + 1;

            // Kiểm tra bộ nhớ file chống trùng trong khoảng thời gian 30 phút
            if (sentLog[symbol]) {
                const lastSentTime = sentLog[symbol];
                if (currentTime - lastSentTime < 30 * 60 * 1000) {
                    console.log(`-> Bỏ qua ${symbol} vì đã gửi thông báo trong vòng 30 phút trước.`);
                    continue;
                }
            }

            console.log(`Đang phân tích thông số kỹ thuật cho #${rank} ${symbol}...`);
            
            // Lấy dữ liệu 15m (RSI và % biến động nến vừa đóng)
            const metrics15m = await getMarketMetrics(symbol, '15m');
            const rsi15m = metrics15m.rsi20;
            const change15m = metrics15m.changePct;

            // Lấy dữ liệu 4h (% biến động tính từ giá mở nến trước đến giá ticker hiện tại)
            const metrics4h = await getMarketMetrics(symbol, '4H', coin.lastPrice);
            const change4h = metrics4h.changePct;

            const change24h = coin.change24h;

            console.log(`> ${symbol} | Rank: ${rank} | Nến 15m: ${change15m.toFixed(2)}% | Biến động 4h sửa đổi: ${change4h.toFixed(2)}% | RSI 15m: ${rsi15m.toFixed(2)}`);

            // --- MAIN LOGIC KIỂM TRA BÁO TÍN HIỆU ---
            let signalType = null;
            const cleanName = symbol.replace('-USDT-SWAP', '').toUpperCase();

            // 1. Logic LONG: Nằm trong top 10 VÀ tăng nến 15m vừa đóng > 3% VÀ -7% < biến động 4h sửa đổi < 5%
            if (rank <= 10 && change15m > 3 && change4h > -7 && change4h < 5) {
                signalType = "Long";
            }
            // 2. Logic SHORT: Nằm từ top 4 đến top 30 VÀ RSI20 của 15m > 75 VÀ có tên trong list cache GitHub
            else if (rank >= 4 && rank <= 30 && rsi15m > 75 && githubCache.includes(cleanName)) {
                signalType = "Short";
            }

            // Tiến hành kích hoạt gửi thông báo
            if (signalType) {
                const lowerSymbol = symbol.toLowerCase();
                const targetLink = `https://www.okx.com/trade-swap/${lowerSymbol}`;
                const alertIcon = signalType === "Long" ? "🟢 [LONG SIGNAL]" : "🔴 [SHORT SIGNAL]";

                const message = `${alertIcon} <b>TÍN HIỆU CHIẾN LƯỢC THEO RANKING</b>\n\n` +
                                `• <b>Coin:</b> #${cleanName}\n` +
                                `• <b>Xếp hạng tăng 24h:</b> Top ${rank}\n` +
                                `• <b>Khuyến nghị:</b> <b>${signalType.toUpperCase()}</b>\n` +
                                `• <b>Giá hiện tại:</b> ${coin.lastPrice}\n` +
                                `• <b>Biến động nến 15m vừa đóng:</b> ${change15m.toFixed(2)}%\n` +
                                `• <b>Biến động 4h (Mở nến trước -> Hiện tại):</b> ${change4h.toFixed(2)}%\n` +
                                `• <b>RSI 20 (15m):</b> ${rsi15m.toFixed(2)}%\n` +
                                `• <b>Tăng trưởng 24h:</b> ${change24h.toFixed(2)}%\n\n` +
                                `👉 <a href="${targetLink}">Vào lệnh ngay trên OKX Future</a>`;

                await sendTelegramMessage(message);
                
                sentLog[symbol] = currentTime;
                hasNewAlert = true;
            }
        }

        if (hasNewAlert) {
            saveSentLog(sentLog);
        }
        console.log('Hoàn thành chu kỳ kiểm tra.');

    } catch (error) {
        console.error('Lỗi hệ thống trong hàm main:', error.message);
    }
}

// Thực thi chạy chương trình chính
main();
