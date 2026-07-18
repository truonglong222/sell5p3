import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OKX_BASE_URL = 'https://www.okx.com';
const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'statetop3_4h.json');

// Hàm tạo khoảng trễ (miliseconds) giúp làm mượt dòng request, tránh bị sàn quét IP
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Hàm kiểm soát số lượng request song song kèm delay nhỏ giữa các đợt
async function poolRequests(items, maxParallel, fn) {
    const results = [];
    const executing = new Set();
    
    for (const item of items) {
        const p = fn(item).then(res => { 
            if (res) results.push(res); 
            executing.delete(p); 
        });
        executing.add(p);
        
        if (executing.size >= maxParallel) {
            await Promise.race(executing);
            await sleep(100); // Nghỉ 100ms sau khi đạt giới hạn song song để giãn cách request
        }
    }
    await Promise.all(executing);
    return results;
}

async function main() {
    const startTime = Date.now();
    console.log('--- BẤT ĐẦU QUY TRÌNH LỌC TOP 3 TĂNG/GIẢM KHUNG 4H (VOL > 2M) ---');
    
    try {
        // 1. Lấy Ticker tổng từ OKX để kiểm tra Volume 24h
        const resTickers = await axios.get(`${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`);
        if (!resTickers.data || resTickers.data.code !== '0') {
            return console.error('Lỗi lấy ticker tổng từ OKX');
        }

        // Lọc volCcy24h > 2,000,000 USD
        const validCoins = resTickers.data.data.filter(t => 
            t.instId.endsWith('-USDT-SWAP') && parseFloat(t.volCcy24h) > 2000000
        );
        console.log(`Tìm thấy ${validCoins.length} coin thỏa mãn Volume > 2M USD.`);
        if (validCoins.length === 0) return;

        // 2. Quét dữ liệu nến 4h để tính biến động
        // Tối ưu số request song song xuống 8 để an toàn tránh bị block IP khi gọi đồng loạt
        const validResults = await poolRequests(validCoins, 8, async (coin) => {
            try {
                // Lấy limit: '2' để có nến hiện tại (index 0) và nến vừa đóng (index 1)
                const resCandle = await axios.get(`${OKX_BASE_URL}/api/v5/market/candles`, {
                    params: { instId: coin.instId, bar: '4H', limit: '2' } 
                });
                const candles = resCandle.data?.data;
                if (!candles || candles.length < 2) return null;

                const currentPrice = parseFloat(candles[0][4]); // Giá hiện tại (giá đóng của nến đang chạy)
                const openPrevious4h = parseFloat(candles[1][1]); // Giá mở cửa của nến 4h vừa đóng trước đó

                return {
                    symbol: coin.instId,
                    change4h: ((currentPrice - openPrevious4h) / openPrevious4h) * 100
                };
            } catch (err) { 
                if (err.response?.status === 429) {
                    console.warn(`Sàn phản hồi 429 (Rate Limit) với cặp: ${coin.instId}. Đang tự bỏ qua...`);
                }
                return null; 
            }
        });

        if (validResults.length === 0) return console.log('Không có dữ liệu nến hợp lệ.');

        // 3. Sắp xếp danh sách dựa trên phần trăm biến động 4h
        const sorted = validResults.sort((a, b) => b.change4h - a.change4h);
        
        // Trích xuất Top 3 Tăng mạnh nhất & Top 3 Giảm mạnh nhất khung 4H
        const top3Gainers4h = sorted.slice(0, 3).map(i => ({ symbol: i.symbol, change4h: `${i.change4h.toFixed(2)}%` }));
        const top3Losers4h = sorted.slice(-3).reverse().map(i => ({ symbol: i.symbol, change4h: `${i.change4h.toFixed(2)}%` }));

        // 4. Đồng bộ kết quả vào file JSON mới (statetop3_4h.json)
        fs.writeFileSync(STATE_FILE, JSON.stringify({ top3Gainers4h, top3Losers4h }, null, 2), 'utf8');

        console.log(`--- HOÀN THÀNH ĐỒNG BỘ TRONG ${((Date.now() - startTime) / 1000).toFixed(2)} GIÂY ---`);
        console.log(`- Cập nhật thành công file: ${STATE_FILE}`);

    } catch (error) {
        console.error('Lỗi hệ thống trong quy trình:', error.message);
    }
}

// Thực thi 1 lần duy nhất và tự thoát
main();
