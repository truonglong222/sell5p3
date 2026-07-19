import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OKX_BASE_URL = 'https://www.okx.com';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Tên file lưu trữ kết quả chung
const STATE_FILE = path.join(__dirname, 'statetop_5d.json');

// Cấu hình giới hạn số lượng request chạy song song cùng lúc để bảo vệ IP sàn
const MAX_CONCURRENT_REQUESTS = 8; 

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

// Hàm lấy nến 1D để tính biến động đa khung thời gian (5 ngày và 2 ngày)
async function fetchMultiDayChange(coin) {
    const symbol = coin.instId;
    try {
        // Lấy 7 nến ngày để đảm bảo mảng có đủ nến index 1, index 2 và index 5
        const candle1DUrl = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1D&limit=7`;
        const candleRes = await axios.get(candle1DUrl, { timeout: 5000 });

        if (candleRes.data && candleRes.data.code === '0' && candleRes.data.data.length >= 6) {
            const candles1D = candleRes.data.data; // Dữ liệu từ mới nhất [0] đến cũ nhất

            // Giá đóng cửa nến ngày hôm qua [1][4]
            const closeYesterday = parseFloat(candles1D[1][4]); 
            
            // 1. Tính biến động 5 ngày: (Đóng_Hôm_Qua - Mở_5_Ngày_Trước) / Mở_5_Ngày_Trước
            const open5DaysAgo = parseFloat(candles1D[5][1]); 
            const change5Days = open5DaysAgo ? ((closeYesterday - open5DaysAgo) / open5DaysAgo) * 100 : 0;

            // 2. Tính biến động 2 ngày: (Đóng_Hôm_Qua - Mở_Hôm_Kia) / Mở_Hôm_Kia
            const open2DaysAgo = parseFloat(candles1D[2][1]); // nến [2] là nến ngày hôm kia
            const change2Days = open2DaysAgo ? ((closeYesterday - open2DaysAgo) / open2DaysAgo) * 100 : 0;

            return { symbol, change5Days, change2Days };
        }
    } catch (err) {
        // Bỏ qua lỗi cục bộ để không dừng luồng quét chính
    }
    return null;
}

async function main() {
    const startTime = Date.now();
    console.log('--- BẤT ĐẦU LỌC SONG SONG: TOP 20 GIẢM 5D & TOP 10 GIẢM 2D (VOL > 2M USD) ---');
    try {
        // 1. Tải Ticker tổng & lọc ngay Volume 24h quy đổi (volCcy24h) > 2,000,000 USD
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);
        if (!response.data || response.data.code !== '0') {
            console.error('Không thể lấy dữ liệu ticker tổng từ sàn OKX.');
            return;
        }

        const rawFutures = response.data.data.filter(t => 
            t.instId.endsWith('-USDT-SWAP') && parseFloat(t.volCcy24h) > 2000000
        );
        
        console.log(`Tìm thấy ${rawFutures.length} coin thoả mãn Volume 24h > 2M USD.`);
        if (rawFutures.length === 0) return;

        // 2. Chạy tải nến song song đa luồng tối ưu hiệu năng
        console.log('Đang quét lịch sử nến 1D song song...');
        const results = await asyncPool(MAX_CONCURRENT_REQUESTS, rawFutures, (coin) => 
            fetchMultiDayChange(coin)
        );

        // Lọc bỏ kết quả lỗi mạng hoặc dữ liệu nến thiếu
        const poolWithChanges = results.filter(r => r !== null);

        // 3. Xử lý danh sách Top 20 giảm mạnh nhất 5 Ngày
        const top20Losers = [...poolWithChanges]
            .sort((a, b) => a.change5Days - b.change5Days)
            .slice(0, 20); 
        const top20LosersSymbols = top20Losers.map(item => item.symbol);

        // BỔ SUNG: Xử lý danh sách Top 10 giảm mạnh nhất 2 Ngày
        const top10Losers2d = [...poolWithChanges]
            .sort((a, b) => a.change2Days - b.change2Days)
            .slice(0, 10);
        const top10Losers2dSymbols = top10Losers2d.map(item => item.symbol);

        // 4. Lưu đồng thời cả 2 danh sách vào file statetop_5d.json
        const finalState = {
            top20Losers: top20LosersSymbols,
            top10Losers2d: top10Losers2dSymbols // Key lưu trữ mới cho danh sách 2 ngày
        };

        fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2), 'utf8');
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`--- HOÀN THÀNH LỌC TRONG ${duration} GIÂY ---`);
        console.log(`- Đã cập nhật thành công file: ${STATE_FILE}`);

        // In thông tin Top 20 Giảm 5 Ngày ra terminal
        console.log('\n--- CHI TIẾT TOP 20 GIẢM 5 NGÀY ---');
        top20Losers.forEach((c, idx) => {
            console.log(`${idx + 1}. ${c.symbol}: ${c.change5Days.toFixed(2)}%`);
        });

        // BỔ SUNG: In thông tin Top 10 Giảm 2 Ngày ra terminal
        console.log('\n--- CHI TIẾT TOP 10 GIẢM 2 NGÀY ---');
        top10Losers2d.forEach((c, idx) => {
            console.log(`${idx + 1}. ${c.symbol}: ${c.change2Days.toFixed(2)}%`);
        });

    } catch (error) {
        console.error('Lỗi hệ thống file top_5d.js:', error.message);
    }
}

main();
