import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OKX_BASE_URL = 'https://www.okx.com';
const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'statetop3_8h.json');

// Hàm kiểm soát số lượng request chạy song song (Tối đa 20 dòng để tránh bị OKX chặn IP)
async function poolRequests(items, maxParallel, fn) {
    const results = [];
    const executing = new Set();
    for (const item of items) {
        const p = fn(item).then(res => { if (res) results.push(res); executing.delete(p); });
        executing.add(p);
        if (executing.size >= maxParallel) await Promise.race(executing);
    }
    await Promise.all(executing);
    return results;
}

async function main() {
    const startTime = Date.now();
    console.log('--- BẤT ĐẦU QUY TRÌNH LỌC TOP 3 TĂNG/GIẢM KHUNG 8H (VOL > 4M) ---');
    try {
        // 1. Lấy Ticker tổng từ OKX để kiểm tra Volume 24h
        const resTickers = await axios.get(`${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`);
        if (!resTickers.data || resTickers.data.code !== '0') return console.error('Lỗi lấy ticker tổng từ OKX');

        // ĐÃ SỬA: Thay đổi điều kiện lọc volCcy24h > 4,000,000 USD
        const validCoins = resTickers.data.data.filter(t => 
            t.instId.endsWith('-USDT-SWAP') && parseFloat(t.volCcy24h) > 4000000
        );
        console.log(`Tìm thấy ${validCoins.length} coin thỏa mãn Volume > 4M USD.`);
        if (validCoins.length === 0) return;

        // 2. Quét dữ liệu 2 cây nến 4h gần nhất để tính biến động 8h
        const validResults = await poolRequests(validCoins, 20, async (coin) => {
            try {
                const resCandle = await axios.get(`${OKX_BASE_URL}/api/v5/market/candles`, {
                    params: { instId: coin.instId, bar: '4H', limit: '3' } // Lấy 3 để có nến hiện tại + 2 nến lịch sử đầy đủ
                });
                const candles = resCandle.data?.data;
                if (!candles || candles.length < 3) return null;

                const currentPrice = parseFloat(candles[0][4]); // Giá đóng cửa hiện tại
                const open8hAgo = parseFloat(candles[2][1]);   // Giá mở cửa của 8 tiếng trước

                return {
                    symbol: coin.instId,
                    change8h: ((currentPrice - open8hAgo) / open8hAgo) * 100
                };
            } catch { return null; } // Bỏ qua coin nếu bị lỗi kết nối cục bộ
        });

        if (validResults.length === 0) return console.log('Không có dữ liệu nến hợp lệ.');

        // 3. Sắp xếp danh sách dựa trên phần trăm biến động 8h
        const sorted = validResults.sort((a, b) => b.change8h - a.change8h);
        
        // Trích xuất Top 3 Tăng mạnh nhất & Top 3 Giảm mạnh nhất (Kèm chi tiết % biến động để bạn tiện theo dõi)
        const top3Gainers8h = sorted.slice(0, 3).map(i => ({ symbol: i.symbol, change8h: `${i.change8h.toFixed(2)}%` }));
        const top3Losers8h = sorted.slice(-3).reverse().map(i => ({ symbol: i.symbol, change8h: `${i.change8h.toFixed(2)}%` }));

        // 4. Đồng bộ kết quả trực tiếp vào file JSON cấu trúc gọn gàng
        fs.writeFileSync(STATE_FILE, JSON.stringify({ top3Gainers8h, top3Losers8h }, null, 2), 'utf8');

        console.log(`--- HOÀN THÀNH ĐỒNG BỘ TRONG ${((Date.now() - startTime) / 1000).toFixed(2)} GIÂY ---`);
        console.log(`- Đã cập nhật file: ${STATE_FILE}`);

    } catch (error) {
        console.error('Lỗi hệ thống trong quy trình:', error.message);
    }
}

main();
