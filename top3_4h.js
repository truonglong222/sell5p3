import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OKX_BASE_URL = 'https://www.okx.com';
const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'statetop3_4h.json');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
            await sleep(100); 
        }
    }
    await Promise.all(executing);
    return results;
}

async function main() {
    const startTime = Date.now();
    console.log('--- BẤT ĐẦU LỌC TOP 5 TĂNG (8H) BẰNG 3 NẾN 4H ---');
    
    try {
        const resTickers = await axios.get(`${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`);
        if (!resTickers.data || resTickers.data.code !== '0') {
            return console.error('Lỗi lấy ticker tổng từ OKX');
        }

        const validCoins = resTickers.data.data.filter(t => 
            t.instId.endsWith('-USDT-SWAP') && parseFloat(t.volCcy24h) > 2000000
        );
        console.log(`Tìm thấy ${validCoins.length} coin thỏa mãn Volume > 2M USD.`);
        if (validCoins.length === 0) return;

        // Quét dữ liệu nến: Lấy 3 nến 4H gần nhất
        const validResults = await poolRequests(validCoins, 8, async (coin) => {
            try {
                const resCandle = await axios.get(`${OKX_BASE_URL}/api/v5/market/candles`, {
                    params: { instId: coin.instId, bar: '4H', limit: '3' } 
                });
                const candles = resCandle.data?.data;
                if (!candles || candles.length < 3) return null;

                const close0 = parseFloat(candles[0][4]); // Giá đóng cửa hiện tại
                const open1 = parseFloat(candles[1][1]);  // Giá mở cửa nến 4h trước
                const open2 = parseFloat(candles[2][1]);  // Giá mở cửa nến 8h trước

                return {
                    symbol: coin.instId,
                    change4h: ((close0 - open1) / open1) * 100,
                    change8h: ((close0 - open2) / open2) * 100
                };
            } catch (err) { 
                if (err.response?.status === 429) {
                    console.warn(`Sàn phản hồi 429 với cặp: ${coin.instId}. Đang bỏ qua...`);
                }
                return null; 
            }
        });

        if (validResults.length === 0) return console.log('Không có dữ liệu nến hợp lệ.');

        // 3. Sắp xếp độc lập theo biến động 8H (Nhóm Tăng: Xếp từ Cao xuống Thấp dựa trên change8h)
        const sortedGainers = [...validResults].sort((a, b) => b.change8h - a.change8h);
        
        // Lấy hẳn 5 phần tử nhưng vẫn giữ tên biến và key là top3Gainers4h theo yêu cầu của bạn
        const top3Gainers4h = sortedGainers.slice(0, 5).map(i => ({ 
            symbol: i.symbol, 
            change: `${i.change8h.toFixed(2)}%`
        }));

        // 4. Đồng bộ kết quả vào file JSON (Giữ nguyên cấu trúc key cũ, loại bỏ hoàn toàn losers)
        fs.writeFileSync(STATE_FILE, JSON.stringify({ top3Gainers4h }, null, 2), 'utf8');

        console.log(`--- HOÀN THÀNH ĐỒNG BỘ TRONG ${((Date.now() - startTime) / 1000).toFixed(2)} GIÂY ---`);
        console.log(`- Cập nhật thành công file: ${STATE_FILE} (Đã chứa top 5 tăng giá)`);

    } catch (error) {
        console.error('Lỗi hệ thống trong quy trình:', error.message);
    }
}

main();
