import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OKX_BASE_URL = 'https://www.okx.com';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE = path.join(__dirname, 'state.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    console.log('--- BẮT ĐẦU CHỐT GIÁ TỐI ƯU (GỘP REQUEST 1D) LÚC 7H SÁNG ---');
    try {
        // 1. Lấy danh sách tất cả coin Futures USDT
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);
        if (!response.data || response.data.code !== '0') {
            console.error('Không thể lấy dữ liệu ticker tổng.');
            return;
        }

        const rawFutures = response.data.data.filter(t => t.instId.endsWith('-USDT-SWAP'));
        const openPricesData = {};
        const qualified2DaysGainers = []; 

        // 2. Duyệt từng coin - CHỈ GỌI DUY NHẤT 1 API NẾN 1D
        for (let i = 0; i < rawFutures.length; i++) {
            const symbol = rawFutures[i].instId;
            try {
                const candle1DUrl = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1D&limit=3`;
                const candleRes = await axios.get(candle1DUrl);

                if (candleRes.data && candleRes.data.code === '0' && candleRes.data.data.length >= 3) {
                    const candles1D = candleRes.data.data;

                    // 🛠️ TỐI ƯU: Lấy luôn giá mở cửa lúc 7h sáng từ nến ngày hôm nay (index 0)
                    const exact7AMPrice = parseFloat(candles1D[0][1]); 
                    openPricesData[symbol] = exact7AMPrice;

                    // Tính toán % tăng trưởng 2 ngày (so với giá đóng cửa hôm kia index 2)
                    const closePrice2DaysAgo = parseFloat(candles1D[2][4]);
                    const lastPrice = parseFloat(rawFutures[i].last);
                    const growth2Days = exact7AMPrice ? ((lastPrice - closePrice2DaysAgo) / closePrice2DaysAgo) * 100 : 0;

                    // Điều kiện lọc tăng trưởng 2 ngày (2% - 10%)
                    if (growth2Days > 2 && growth2Days < 10) {
                        qualified2DaysGainers.push(symbol);
                    }
                    
                    console.log(`[OK] ${symbol} | Giá 7h: ${exact7AMPrice} | 2 Ngày: ${growth2Days.toFixed(2)}%`);
                } else {
                    // Dự phòng nếu lỗi nến
                    openPricesData[symbol] = parseFloat(rawFutures[i].last);
                }

                // Giảm thời gian sleep xuống vì đã bớt request, bot sẽ chạy nhanh hơn nhiều
                if (i % 5 === 0) await sleep(50);

            } catch (err) {
                openPricesData[symbol] = parseFloat(rawFutures[i].last);
            }
        }

        // 3. Ghi đè dữ liệu phẳng vào file state.json
        const finalState = {
            qualified2DaysGainers: qualified2DaysGainers,
            openPrices: openPricesData
        };

        fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2), 'utf8');
        console.log('--- ĐÃ TỐI ƯU GỘP REQUEST VÀ CẬP NHẬT STATE.JSON THÀNH CÔNG ---');

    } catch (error) {
        console.error('Lỗi hệ thống file 7h.js:', error.message);
    }
}

main();
