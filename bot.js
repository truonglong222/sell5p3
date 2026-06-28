import fetch from 'node-fetch'; // Nếu chạy Node.js < 18, cần cài 'node-fetch'. Từ Node 18+ có thể xóa dòng này và dùng fetch mặc định.

// 1. Cấu hình biến môi trường từ GitHub Secrets
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// Bộ nhớ tạm để lưu các coin đã gửi nhằm tránh trùng lặp trong 2 giờ (120 phút)
// Lưu ý: Nếu chạy bằng GitHub Actions theo lịch (cron), bộ nhớ tạm này sẽ bị xóa sau mỗi lần chạy.
// Để tối ưu nhất, code hỗ trợ cơ chế check thời gian dựa trên dữ liệu hiện tại nếu lưu file, 
// nhưng dưới đây là logic lưu vết tiêu chuẩn trong một phiên chạy liên tục.
const sentCache = new Map(); 
const CACHE_DURATION = 2 * 60 * 60 * 1000; // 2 giờ tính bằng mili-giây

// Hàm hỗ trợ delay giữa các request để tránh bị sàn chặn (Rate limit)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Hàm gửi tin nhắn về Telegram
async function sendTelegram(message) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: CHAT_ID,
                text: message,
                parse_mode: 'Markdown'
            })
        });
        if (!response.ok) {
            console.error(`Lỗi gửi Telegram: ${response.statusText}`);
        }
    } catch (error) {
        console.error('Không thể kết nối Telegram:', error.message);
    }
}

// Lấy danh sách tất cả các cặp coin Futures (SWAP) trên OKX và biến động 24h
async function getTopVolatileFutures() {
    try {
        const res = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
        const data = await res.json();
        
        if (data.code !== '0' || !data.data) {
            console.error('Lỗi lấy dữ liệu từ OKX');
            return [];
        }

        // Lọc các cặp USDT-SWAP và tính toán mức độ biến động dựa trên giá cao nhất/thấp nhất 24h
        const tickers = data.data
            .filter(ticker => ticker.instId.endsWith('-USDT-SWAP'))
            .map(ticker => {
                const high = parseFloat(ticker.high24h);
                const low = parseFloat(ticker.low24h);
                const open = parseFloat(ticker.open24h);
                // Biến động % tuyệt đối trong ngày = ((High - Low) / Low) * 100
                const volatility = low > 0 ? ((high - low) / low) * 100 : 0;
                return {
                    instId: ticker.instId,
                    volatility: volatility,
                    last: parseFloat(ticker.last)
                };
            });

        // Sắp xếp giảm dần theo biến động và lấy top 50
        tickers.sort((a, b) => b.volatility - a.volatility);
        return tickers.slice(0, 50);
    } catch (error) {
        console.error('Lỗi khi fetch tickers:', error.message);
        return [];
    }
}

// Kiểm tra điều kiện nến 1h và 15p của từng coin
async function checkCandleConditions(instId) {
    try {
        // 1. Kiểm tra nến 1h tăng > 3%
        const res1h = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=1H&limit=2`);
        const data1h = await res1h.json();
        if (!data1h.data || data1h.data.length < 1) return false;

        const current1h = data1h.data[0]; // Nến 1h hiện tại đang chạy
        const open1h = parseFloat(current1h[1]);
        const close1h = parseFloat(current1h[4]);
        const change1h = ((close1h - open1h) / open1h) * 100;

        if (change1h < 3) return false;

        // 2. Kiểm tra ít nhất 3 cây nến 15p liên tiếp tăng giá (nến đã đóng hoặc gồm cả nến hiện tại)
        const res15m = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=15m&limit=4`);
        const data15m = await res15m.json();
        if (!data15m.data || data15m.data.length < 3) return false;

        // OKX trả về nến mới nhất xếp đầu tiên (index 0 là nến đang chạy, 1, 2, 3 là các nến trước)
        const isGrowing15m = data15m.data.slice(0, 3).every(candle => {
            const open = parseFloat(candle[1]);
            const close = parseFloat(candle[4]);
            return close > open; // Giá đóng cửa lớn hơn giá mở cửa (nến xanh)
        });

        if (!isGrowing15m) return false;

        return {
            instId: instId,
            change1h: change1h.toFixed(2),
            price: parseFloat(current1h[4])
        };
    } catch (error) {
        console.error(`Lỗi kiểm tra coin ${instId}:`, error.message);
        return false;
    }
}

// Hàm khởi chạy chính
async function main() {
    console.log('--- Bắt đầu quét tín hiệu OKX Futures ---');
    const top50 = await getTopVolatileFutures();
    console.log(`Đã lấy xong top 50 coin biến động mạnh nhất.`);

    let alertCoins = [];

    for (const coin of top50) {
        // Tránh spam request quá nhanh dẫn đến block IP từ OKX
        await sleep(200); 
        
        const result = await checkCandleConditions(coin.instId);
        if (result) {
            const cleanName = result.instId.replace('-USDT-SWAP', '');
            const now = Date.now();

            // Kiểm tra trùng lặp trong vòng 2 giờ
            if (sentCache.has(cleanName)) {
                const lastSentTime = sentCache.get(cleanName);
                if (now - lastSentTime < CACHE_DURATION) {
                    console.log(`Coin ${cleanName} thỏa điều kiện nhưng vừa gửi trong vòng 2h. Bỏ qua.`);
                    continue; 
                }
            }

            alertCoins.push(result);
            sentCache.set(cleanName, now); // Cập nhật thời gian gửi
        }
    }

    // Nếu có coin thỏa mãn thì gom lại gửi 1 tin nhắn Telegram duy nhất
    if (alertCoins.length > 0) {
        let message = `🔔 *TÍN HIỆU OKX FUTURES CẢNH BÁO*\n\n`;
        alertCoins.forEach(c => {
            const name = c.instId.replace('-USDT-SWAP', '');
            message += `🔥 *${name}*\n`;
            message += `• Biến động 1h: +${c.change1h}%\n`;
            message += `• Trạng thái: 3 cây nến 15p liên tiếp TĂNG\n`;
            message += `• Giá hiện tại: ${c.price}\n\n`;
        });
        
        await sendTelegram(message.trim());
        console.log('Đã gửi cảnh báo về Telegram.');
    } else {
        console.log('Không có coin nào thỏa mãn điều kiện lọc.');
    }
}

// Thực thi bot
main();
