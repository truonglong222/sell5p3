import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OKX_BASE_URL = 'https://www.okx.com';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE = path.join(__dirname, 'state.json');

// Cấu hình giới hạn số lượng request chạy song song cùng lúc (Tránh bị OKX khóa IP)
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

async function fetchChange30Days(coin, rawFuturesMap) {
    const symbol = coin.instId;
    try {
        // Tối ưu hóa: Chỉ lấy 30 nến ngày (limit=30). OKX trả về từ mới nhất đến cũ nhất.
        const candle1DUrl = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1D&limit=30`;
        const candleRes = await axios.get(candle1DUrl, { timeout: 5000 });

        if (candleRes.data && candleRes.data.code === '0' && candleRes.data.data.length > 0) {
            const candles1D = candleRes.data.data;
            const lastPrice = parseFloat(rawFuturesMap[symbol]);
            
            // Lấy nến cũ nhất hiện có trong danh sách 30 ngày (tối đa index 29)
            const targetIndex = Math.min(29, candles1D.length - 1);
            const closePrice30DaysAgo = parseFloat(candles1D[targetIndex][4]); // Giá đóng cửa
            
            const change30Days = closePrice30DaysAgo ? ((lastPrice - closePrice30DaysAgo) / closePrice30DaysAgo) * 100 : 0;
            return { symbol, change30Days };
        }
    } catch (err) {
        // Bỏ qua lỗi kết nối cục bộ của một vài coin riêng lẻ để không làm gián đoạn hệ thống
    }
    return null;
}

async function main() {
    const startTime = Date.now();
    console.log('--- BẤT ĐẦU LỌC SONG SONG TOP 50 COIN GIẢM MẠNH NHẤT 30 NGÀY QUA ---');
    try {
        // 1. Tải Ticker tổng và lọc ngay các coin có Volume > 2,000,000 USD
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);
        if (!response.data || response.data.code !== '0') {
            console.error('Không thể lấy dữ liệu ticker tổng.');
            return;
        }

        const rawFutures = response.data.data.filter(t => 
            t.instId.endsWith('-USDT-SWAP') && parseFloat(t.vol24h) >= 2000000
        );
        
        console.log(`Đã lọc ra ${rawFutures.length} coin thỏa mãn Volume > 2M USD.`);
        
        // Tạo map lưu giá hiện tại (last) để tra cứu nhanh O(1)
        const rawFuturesMap = {};
        rawFutures.forEach(t => {
            rawFuturesMap[t.instId] = t.last;
        });

        // 2. Chạy tải nến 30 ngày song song cực tốc (Tối đa 8 luồng đồng thời)
        console.log(`Đang quét nến song song với hiệu năng cao...`);
        const results = await asyncPool(MAX_CONCURRENT_REQUESTS, rawFutures, (coin) => 
            fetchChange30Days(coin, rawFuturesMap)
        );

        // Lọc bỏ các kết quả null (do lỗi mạng hoặc dữ liệu không hợp lệ)
        const poolWith30DaysChange = results.filter(r => r !== null);

        // 3. Sắp xếp tìm ra Top 50 coin giảm sâu nhất
        const top50Losers30Days = poolWith30DaysChange
            .sort((a, b) => a.change30Days - b.change30Days) // Giảm mạnh nhất đứng đầu mảng
            .slice(0, 50)
            .map(item => item.symbol);

        if (top50Losers30Days.length === 0) {
            console.log('Không tìm thấy dữ liệu hợp lệ sau khi lọc.');
            return;
        }

        // 4. Ghi đè trạng thái vào state.json
        const finalState = {
            top20Losers: top50Losers30Days // Giữ key cũ để tương thích 100% với file bot.js
        };

        fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2), 'utf8');
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`--- HOÀN THÀNH ĐỒNG BỘ TRONG ${duration} GIÂY ---`);
        console.log('Đã lưu thành công danh sách Top 50 coin giảm mạnh nhất.');

    } catch (error) {
        console.error('Lỗi hệ thống file 7h.js:', error.message);
    }
}

main();
