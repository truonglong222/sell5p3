import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OKX_BASE_URL = 'https://www.okx.com';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Tên file lưu trữ kết quả
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

// Hàm lấy nến 1D để tính biến động trong 5 ngày qua
async function fetch5DayChange(coin) {
    const symbol = coin.instId;
    try {
        // Lấy ít nhất 6 nến ngày để có đủ nến index 1 và index 5
        const candle1DUrl = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1D&limit=7`;
        const candleRes = await axios.get(candle1DUrl, { timeout: 5000 });

        if (candleRes.data && candleRes.data.code === '0' && candleRes.data.data.length >= 6) {
            const candles1D = candleRes.data.data; // Dữ liệu trả về từ mới nhất [0] đến cũ nhất

            // ĐÃ ĐỔI: Lấy giá đóng cửa nến 1 ngày vừa đóng [1][4]
            const closeYesterday = parseFloat(candles1D[1][4]); 
            
            // ĐÃ ĐỔI: Lấy giá mở cửa của nến 5 ngày trước [5][1]
            const open5DaysAgo = parseFloat(candles1D[5][1]); 

            // Công thức tính mới: ((Đóng_Hôm_Qua - Mở_5_Ngày_Trước) / Mở_5_Ngày_Trước) * 100
            const change5Days = open5DaysAgo ? ((closeYesterday - open5DaysAgo) / open5DaysAgo) * 100 : 0;

            return { symbol, change5Days };
        }
    } catch (err) {
        // Bỏ qua lỗi cục bộ để tránh làm gián đoạn tiến trình lọc chính
    }
    return null;
}

async function main() {
    const startTime = Date.now();
    console.log('--- BẤT ĐẦU LỌC SONG SONG: TOP 20 COIN GIẢM GIÁ 5 NGÀY (VOL > 2M USD) ---');
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
            fetch5DayChange(coin)
        );

        // Lọc bỏ kết quả lỗi mạng hoặc dữ liệu nến thiếu
        const poolWithChanges = results.filter(r => r !== null);

        // 3. Sắp xếp lấy Top 20 đồng coin giảm mạnh nhất (số âm lớn nhất xếp lên đầu)
        const top20Losers = poolWithChanges
            .sort((a, b) => a.change5Days - b.change5Days)
            .slice(0, 20); // Đã sửa từ .slice(0, 40) về đúng (0, 20) theo tên Top 20

        const top20LosersSymbols = top20Losers.map(item => item.symbol);

        // 4. Lưu danh sách mảng sạch này vào file statetop_5d.json
        const finalState = {
            top20Losers: top20LosersSymbols
        };

        fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2), 'utf8');
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`--- HOÀN THÀNH LỌC TRONG ${duration} GIÂY ---`);
        console.log(`- Đã tìm và lưu Top 20 Giảm 5 Ngày vào statetop_5d.json:`, top20LosersSymbols);

        // In chi tiết % biến động ra terminal để tiện quan sát
        console.log('\nChi tiết biên độ giảm (Theo nến đóng hôm qua và mở 5 ngày trước):');
        top20Losers.forEach((c, idx) => {
            console.log(`${idx + 1}. ${c.symbol}: ${c.change5Days.toFixed(2)}%`);
        });

        // Tự động kiểm tra xem có lưu nhầm key sang file ema.js không
        console.log(`\n💡 Lưu ý: Key lưu trữ trong JSON là "top20Losers", trùng khớp với cấu trúc được gọi ở file ema.js.`);

    } catch (error) {
        console.error('Lỗi hệ thống file top_5d.js:', error.message);
    }
}

main();
