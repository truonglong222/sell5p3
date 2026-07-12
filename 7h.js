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
    console.log('--- BẮT ĐẦU CHỐT GIÁ MỞ CỬA LÚC 7H SÁNG ---');
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

        // 2. Duyệt từng coin để lấy chính xác giá mở cửa lúc 7h sáng VN (00:00 UTC)
        for (let i = 0; i < rawFutures.length; i++) {
            const symbol = rawFutures[i].instId;
            try {
                const candleUrl = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=5`;
                const candleRes = await axios.get(candleUrl);
                
                if (candleRes.data && candleRes.data.code === '0' && candleRes.data.data.length > 0) {
                    const now = new Date();
                    const today7AM_UTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);

                    const targetCandle = candleRes.data.data.find(c => parseInt(c[0]) === today7AM_UTC);
                    
                    if (targetCandle) {
                        openPricesData[symbol] = parseFloat(targetCandle[1]); // Giá mở nến 7h sáng
                    } else {
                        openPricesData[symbol] = parseFloat(candleRes.data.data[0][1]); // Lấy tạm nến hiện tại nếu có sự cố
                    }
                }
                
                if (i % 5 === 0) await sleep(100);

            } catch (err) {
                openPricesData[symbol] = parseFloat(rawFutures[i].last);
            }
        }

        // 3. Định dạng lại cấu trúc phẳng (Chỉ lưu openPrices) và ghi đè hoàn toàn lên state.json
        const finalState = {
            openPrices: openPricesData
        };

        fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2), 'utf8');
        console.log('--- ĐÃ GHI ĐÈ GIÁ 7H VÀO STATE.JSON THÀNH CÔNG ---');

    } catch (error) {
        console.error('Lỗi hệ thống file 7h.js:', error.message);
    }
}

main();
