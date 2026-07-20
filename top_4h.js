import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OKX_BASE_URL = 'https://www.okx.com';
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(CURRENT_DIR, 'statetop3_4h.json');
const RESET_INTERVAL = 12 * 60 * 60 * 1000; // 12 giờ tính bằng mili giây

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
    console.log('--- BẤT ĐẦU LỌC TOP TĂNG BẰNG 3 NẾN 2H ---');

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

        // Quét dữ liệu nến: Lấy 3 nến 2H gần nhất
        const validResults = await poolRequests(validCoins, 8, async (coin) => {
            try {
                const resCandle = await axios.get(`${OKX_BASE_URL}/api/v5/market/candles`, {
                    params: { instId: coin.instId, bar: '2H', limit: '3' }
                });
                const candles = resCandle.data?.data;
                if (!candles || candles.length < 3) return null;

                const close0 = parseFloat(candles[0][4]); // Giá đóng cửa hiện tại (nến đang chạy)
                const open2 = parseFloat(candles[2][1]);   // Giá mở cửa nến số 2

                return {
                    symbol: coin.instId,
                    changeCalculated: ((close0 - open2) / open2) * 100
                };
            } catch (err) {
                if (err.response?.status === 429) {
                    console.warn(`Sàn phản hồi 429 với cặp: ${coin.instId}. Đang bỏ qua...`);
                }
                return null;
            }
        });

        if (validResults.length === 0) return console.log('Không có dữ liệu nến hợp lệ.');

        // Sắp xếp theo biến động vừa tính toán (Nhóm Tăng: Xếp từ Cao xuống Thấp)
        const sortedGainers = [...validResults].sort((a, b) => b.changeCalculated - a.changeCalculated);

        // Lấy 5 phần tử tăng mạnh nhất từ lượt quét hiện tại để kiểm tra đưa vào danh sách
        let newTop5 = sortedGainers.slice(0, 5).map(i => ({ 
            symbol: i.symbol, 
            change: `${i.changeCalculated.toFixed(2)}%` 
        }));

        // --- ĐOẠN XỬ LÝ LƯU THÊM VÀ TỰ ĐỘNG XÓA SAU 12H ---
        let existingData = { lastReset: Date.now(), top3Gainers4h: [] };

        // 1. Đọc dữ liệu cũ nếu file đã tồn tại
        if (fs.existsSync(STATE_FILE)) {
            try {
                const fileContent = fs.readFileSync(STATE_FILE, 'utf8');
                existingData = JSON.parse(fileContent);
                if (!existingData.lastReset) existingData.lastReset = Date.now();
                if (!Array.isArray(existingData.top3Gainers4h)) existingData.top3Gainers4h = [];
            } catch (e) {
                console.warn('File cũ bị lỗi định dạng, sẽ khởi tạo lại.');
            }
        }

        // 2. Kiểm tra nếu đã quá 12h thì xóa sạch danh sách cũ
        if (Date.now() - existingData.lastReset > RESET_INTERVAL) {
            console.log('--- Đã quá 12 giờ! Tiến hành reset danh sách cũ ---');
            existingData.top3Gainers4h = [];
            existingData.lastReset = Date.now();
        }

        // 3. Hợp nhất: Toàn bộ coin trong lượt quét mới đều được xét để đưa vào file lưu trữ
        const currentSymbols = new Set(existingData.top3Gainers4h.map(item => item.symbol));
        
        for (const coin of newTop5) {
            if (!currentSymbols.has(coin.symbol)) {
                existingData.top3Gainers4h.push(coin);
                console.log(`+ Thêm mới: ${coin.symbol} (${coin.change})`);
            } else {
                // Cập nhật lại % tăng mới nhất cho coin đã tồn tại trong file
                const index = existingData.top3Gainers4h.findIndex(item => item.symbol === coin.symbol);
                existingData.top3Gainers4h[index].change = coin.change;
            }
        }

        // 4. Lưu lại dữ liệu đã hợp nhất vào file
        fs.writeFileSync(STATE_FILE, JSON.stringify(existingData, null, 2), 'utf8');
        // --------------------------------------------------
        
        console.log(`--- HOÀN THÀNH ĐỒNG BỘ TRONG ${((Date.now() - startTime) / 1000).toFixed(2)} GIÂY ---`);
        console.log(`- Tổng số coin hiện tại trong file: ${existingData.top3Gainers4h.length}`);
        console.log(`- Cập nhật thành công file: ${STATE_FILE}`);
    } catch (error) {
        console.error('Lỗi hệ thống trong quy trình:', error.message);
    }
}

main();
