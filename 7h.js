import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OKX_BASE_URL = 'https://www.okx.com';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE = path.join(__dirname, 'state.json');

// Cấu hình giới hạn số lượng request chạy song song cùng lúc (Tránh bị khóa IP)
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

// Hàm lấy nến 1D để tính biến động 5 ngày và 2 ngày
async function fetchMultiDayChanges(coin, rawFuturesMap) {
    const symbol = coin.instId;
    try {
        // Lấy 6 nến ngày (limit=6) để có đủ nến index 5 (5 ngày trước) và index 2 (2 ngày trước)
        const candle1DUrl = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1D&limit=6`;
        const candleRes = await axios.get(candle1DUrl, { timeout: 5000 });

        if (candleRes.data && candleRes.data.code === '0' && candleRes.data.data.length > 0) {
            const candles1D = candleRes.data.data; // Mới nhất đến cũ nhất
            const lastPrice = parseFloat(rawFuturesMap[symbol]);
            
            // 1. Tính biến động 5 ngày qua
            const index5d = Math.min(5, candles1D.length - 1);
            const close5DaysAgo = parseFloat(candles1D[index5d][4]);
            const change5Days = close5DaysAgo ? ((lastPrice - close5DaysAgo) / close5DaysAgo) * 100 : 0;

            // 2. Tính biến động 2 ngày qua
            const index2d = Math.min(2, candles1D.length - 1);
            const open2DaysAgo = parseFloat(candles1D[index2d][1]);
            const change2Days = open2DaysAgo ? ((lastPrice - open2DaysAgo) / open2DaysAgo) * 100 : 0;

            return { symbol, change5Days, change2Days };
        }
    } catch (err) {
        // Bỏ qua lỗi của một vài coin để tiến trình chạy liên tục không bị gián đoạn
    }
    return null;
}

async function main() {
    const startTime = Date.now();
    console.log('--- BẤT ĐẦU LỌC SONG SONG: TOP 20 GIẢM (5 ngày) & TOP 10 TĂNG (2 ngày) ---');
    try {
        // 1. Tải Ticker tổng & lọc ngay Volume 24h > 2,000,000 USD
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

        // 2. Chạy tải nến song song cực tốc (Tối đa 8 luồng đồng thời)
        console.log(`Đang quét nến 1D song song với hiệu năng cao...`);
        const results = await asyncPool(MAX_CONCURRENT_REQUESTS, rawFutures, (coin) => 
            fetchMultiDayChanges(coin, rawFuturesMap)
        );

        // Lọc bỏ kết quả null lỗi mạng
        const poolWithChanges = results.filter(r => r !== null);

        // 3. Xử lý & Sắp xếp danh sách

        // A. Trích xuất Top 20 giảm mạnh nhất trong 5 ngày qua
        const top20Losers5Days = [...poolWithChanges]
            .sort((a, b) => a.change5Days - b.change5Days) // Giảm nhiều nhất (số âm lớn nhất) xếp lên đầu
            .slice(0, 20)
            .map(item => item.symbol);

        // B. Trích xuất Top 10 tăng mạnh nhất trong 2 ngày qua
        const top10Gainers2Days = [...poolWithChanges]
            .sort((a, b) => b.change2Days - a.change2Days) // Tăng nhiều nhất (số dương lớn nhất) xếp lên đầu
            .slice(0, 20)
            .map(item => item.symbol);

        if (top20Losers5Days.length === 0 && top10Gainers2Days.length === 0) {
            console.log('Không tìm thấy dữ liệu hợp lệ sau khi lọc.');
            return;
        }

        // 4. Lưu đồng thời 2 danh sách này vào file state.json
        const finalState = {
            top20Losers5Days: top20Losers5Days,
            top10Gainers2Days: top10Gainers2Days
        };

        fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2), 'utf8');
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`--- HOÀN THÀNH ĐỒNG BỘ TRONG ${duration} GIÂY ---`);
        console.log(`- Đã lưu Top 20 Giảm 5 Ngày:`, top20Losers5Days);
        console.log(`- Đã lưu Top 10 Tăng 2 Ngày:`, top10Gainers2Days);

    } catch (error) {
        console.error('Lỗi hệ thống file 7h.js:', error.message);
    }
}

main();

