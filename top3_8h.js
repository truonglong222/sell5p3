import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OKX_BASE_URL = 'https://www.okx.com';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_EMA_FILE = path.join(__dirname, 'statetop3_8h.json');

// Cấu hình giới hạn request chạy song song cùng lúc để bảo vệ IP
const MAX_CONCURRENT_REQUESTS = 8; 
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Hàm xử lý song song giới hạn luồng (Promise Pool)
async function asyncPool(limit, array, iteratorFn) {
    const ret = [];
    const executing = new Set();
    for (const item of array) {
        const p = Promise.resolve().then(() => iteratorFn(item));
        ret.push(p);
        executing.add(p);
        const clean = () => executing.delete(p);
        p.then(clean, clean);
        if (executing.size >= limit) {
            await Promise.race(executing);
        }
    }
    return Promise.all(ret);
}

// Hàm lấy nến 8h để tính biến động của cây nến vừa đóng gần nhất
async function fetch8hChange(coin) {
    const symbol = coin.instId;
    try {
        // Lấy 2 nến gần nhất (limit=2) của khung 8h
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=8h&limit=2`;
        const response = await axios.get(url, { timeout: 5000 });

        if (response.data && response.data.code === '0' && response.data.data.length >= 2) {
            // Dữ liệu OKX trả về từ mới nhất đến cũ nhất. 
            // Nến index 0 là nến đang chạy (chưa đóng), nến index 1 là nến vừa đóng xong hoàn chỉnh.
            const targetCandle = response.data.data[1]; 
            const openPrice = parseFloat(targetCandle[1]);
            const closePrice = parseFloat(targetCandle[4]);

            // Tính % biến động tăng/giảm trong 8 giờ của nến đó
            const change8h = openPrice > 0 ? ((closePrice - openPrice) / openPrice) * 100 : 0;

            return { symbol, change8h };
        }
    } catch (err) {
        // Bỏ qua lỗi kết nối cục bộ của một vài coin để tiến trình chính chạy liên tục
    }
    return null;
}

async function main() {
    const startTime = Date.now();
    console.log('--- BẤT ĐẦU QUY TRÌNH LỌC TOP 3 TĂNG/GIẢM KHUNG 8H (VOL > 2M USD) ---');
    try {
        // 1. Tải Ticker tổng từ OKX và lọc các cặp SWAP-USDT có Volume 24h quy đổi > 2,000,000 USD
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);
        if (!response.data || response.data.code !== '0') {
            console.error('Không thể lấy dữ liệu ticker tổng.');
            return;
        }

        const rawFutures = response.data.data.filter(t => 
            t.instId.endsWith('-USDT-SWAP') && parseFloat(t.volCcy24h) > 2000000
        );

        console.log(`Đã tìm thấy ${rawFutures.length} coin thỏa mãn Volume > 2M USD. Đang quét nến 8h...`);
        if (rawFutures.length === 0) return;

        // 2. Chạy quét nến song song giới hạn luồng bằng Promise Pool
        const results = await asyncPool(MAX_CONCURRENT_REQUESTS, rawFutures, (coin) => 
            fetch8hChange(coin)
        );

        // Lọc bỏ các kết quả null do lỗi mạng hoặc dữ liệu không đủ nến
        const validResults = results.filter(r => r !== null);

        // 3. Phân tách danh sách và trích xuất Top 3 Tăng / Top 3 Giảm
        
        // Top 3 Tăng mạnh nhất (change8h từ lớn đến nhỏ)
        const top3Gainers8h = [...validResults]
            .sort((a, b) => b.change8h - a.change8h)
            .slice(0, 3)
            .map(item => item.symbol);

        // Top 3 Giảm mạnh nhất (change8h từ nhỏ đến lớn - số âm nhiều nhất lên đầu)
        const top3Losers8h = [...validResults]
            .sort((a, b) => a.change8h - b.change8h)
            .slice(0, 3)
            .map(item => item.symbol);

        // 4. Lưu cấu trúc dữ liệu hoàn chỉnh vào file statetop3_8h.json
        const finalState = {
            top3Gainers8h: top3Gainers8h,
            top3Losers8h: top3Losers8h
        };

        fs.writeFileSync(STATE_EMA_FILE, JSON.stringify(finalState, null, 2), 'utf8');

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`--- HOÀN THÀNH ĐỒNG BỘ TRONG ${duration} GIÂY ---`);
        console.log(`- Đã lưu Top 3 Tăng 8h vào JSON:`, top3Gainers8h);
        console.log(`- Đã lưu Top 3 Giảm 8h vào JSON:`, top3Losers8h);

    } catch (error) {
        console.error('Lỗi hệ thống file top3_8h.js:', error.message);
    }
}

main();
