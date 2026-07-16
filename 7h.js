import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OKX_BASE_URL = 'https://www.okx.com';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE = path.join(__dirname, 'state.json');

// Giới hạn số lượng request chạy song song cùng lúc để bảo vệ IP
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

// Hàm tính ATR% của 20 nến 15 phút
async function calculateATRPercent(symbol) {
    try {
        // Lấy 21 nến để tính toán chính xác 20 khoảng True Range (TR)
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=21`;
        const response = await axios.get(url, { timeout: 5000 });

        if (response.data && response.data.code === '0' && response.data.data.length >= 21) {
            const candles = response.data.data.reverse(); // Đảo từ cũ đến mới để tính toán tuần tự
            const trValues = [];

            // Tính True Range cho từng nến từ nến thứ 2 trở đi
            for (let i = 1; i < candles.length; i++) {
                const high = parseFloat(candles[i][2]);
                const low = parseFloat(candles[i][3]);
                const prevClose = parseFloat(candles[i - 1][4]);

                const tr = Math.max(
                    high - low,
                    Math.abs(high - prevClose),
                    Math.abs(low - prevClose)
                );
                trValues.push(tr);
            }

            // Tính trung bình cộng của 20 giá trị TR vừa tìm được (ATR-20)
            const atr20 = trValues.reduce((sum, val) => sum + val, 0) / trValues.length;

            // Tính tỷ lệ phần trăm ATR% so với giá đóng cửa của nến hiện tại
            const currentPrice = parseFloat(candles[candles.length - 1][4]);
            const atrPercent = currentPrice > 0 ? (atr20 / currentPrice) * 100 : 0;

            return { symbol, atrPercent };
        }
    } catch (error) {
        // Bỏ qua lỗi kết nối cục bộ của một vài coin để hệ thống chạy mượt mà
    }
    return null;
}

async function main() {
    const startTime = Date.now();
    console.log('--- BẤT ĐẦU QUY TRÌNH LỌC COIN THEO ATR% LÚC 7H SÁNG (VOL > 2M USD) ---');
    try {
        // 1. Tải Ticker tổng từ OKX
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);
        if (!response.data || response.data.code !== '0') {
            console.error('Không thể lấy dữ liệu ticker tổng.');
            return;
        }

        // ĐÃ ĐỔI: Thay vì lấy top 100, lọc thẳng toàn bộ coin có Volume 24h quy đổi > 2,000,000 USD
        const filteredOKX = response.data.data
            .filter(t => t.instId.endsWith('-USDT-SWAP') && parseFloat(t.volCcy24h) > 2000000)
            .map(t => ({
                instId: t.instId,
                vol24hUsd: parseFloat(t.volCcy24h)
            }));

        console.log(`Đã chọn ra ${filteredOKX.length} coin thỏa mãn Volume USD > 2,000,000. Tiến hành quét ATR%...`);

        if (filteredOKX.length === 0) {
            console.log('Không có coin nào đạt mốc Volume > 2M USD.');
            return;
        }

        // 2. Quét ATR% song song cực nhanh bằng Promise Pool
        const results = await asyncPool(MAX_CONCURRENT_REQUESTS, filteredOKX, (coin) => 
            calculateATRPercent(coin.instId)
        );

        // Lọc bỏ các kết quả bị lỗi mạng (null)
        const validResults = results.filter(r => r !== null);

        // Lưu dạng Key (Symbol) - Value (ATR%) để dễ truy xuất
        const qualifiedCoinsMap = {};

        // 3. Lọc theo điều kiện: 0.5% < ATR% < 3%
        for (const item of validResults) {
            if (item.atrPercent > 0.5 && item.atrPercent < 3.0) {
                qualifiedCoinsMap[item.symbol] = parseFloat(item.atrPercent.toFixed(3));
                console.log(`✓ [Thỏa mãn] ${item.symbol} | ATR%: ${item.atrPercent.toFixed(3)}%`);
            }
        }

        // 4. Ghi đối tượng map này vào file state.json
        const finalState = {
            qualifiedCoins: qualifiedCoinsMap
        };

        fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2), 'utf8');
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`--- HOÀN THÀNH: Đã lưu ${Object.keys(qualifiedCoinsMap).length} coin thỏa mãn kèm ATR% vào state.json trong ${duration} giây ---`);

    } catch (error) {
        console.error('Lỗi hệ thống trong file 7h.js:', error.message);
    }
}

main();
