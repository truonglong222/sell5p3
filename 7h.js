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
    console.log('--- BẮT ĐẦU LẤY GIÁ MỞ CỬA 7H SÁNG ---');
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

        // 2. Duyệt từng coin - Chỉ lấy 1 cây nến 1D gần nhất để lấy giá mở cửa lúc 7h sáng
        for (let i = 0; i < rawFutures.length; i++) {
            const symbol = rawFutures[i].instId;
            try {
                // Chỉ cần limit=1 để lấy nến ngày hôm nay
                const candle1DUrl = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1D&limit=1`;
                const candleRes = await axios.get(candle1DUrl);

                if (candleRes.data && candleRes.data.code === '0' && candleRes.data.data.length > 0) {
                    const currentCandle = candleRes.data.data[0];
                    // Theo API OKX: Index 1 là giá mở cửa (open) của cây nến
                    const exact7AMPrice = parseFloat(currentCandle[1]); 
                    openPricesData[symbol] = exact7AMPrice;
                } else {
                    // Fallback nếu API nến lỗi thì dùng giá gần nhất (last)
                    openPricesData[symbol] = parseFloat(rawFutures[i].last);
                }

                // Giảm bớt sleep vì gọi API nhẹ hơn, tránh bị rate limit của OKX
                if (i % 5 === 0) await sleep(50); 

            } catch (err) {
                console.warn(`Lỗi khi lấy nến cho ${symbol}, dùng giá last thay thế.`);
                openPricesData[symbol] = parseFloat(rawFutures[i].last);
            }
        }

        // 3. Ghi đè vào file state.json (chỉ lưu duy nhất openPrices)
        const finalState = {
            openPrices: openPricesData
        };

        fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2), 'utf8');
        console.log(`--- ĐÃ ĐỒNG BỘ: Lưu thành công giá mở cửa của ${Object.keys(openPricesData).length} coin ---`);

    } catch (error) {
        console.error('Lỗi hệ thống:', error.message);
    }
}

main();
