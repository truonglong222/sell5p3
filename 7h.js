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
    console.log('--- BẤT ĐẦU LỌC TOP 20 COIN GIẢM MẠNH NHẤT 4 NGÀY QUA LÚC 7H SÁNG ---');
    try {
        // 1. Lấy tất cả coin Futures USDT có volume > 5,000,000 USD
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);
        if (!response.data || response.data.code !== '0') {
            console.error('Không thể lấy dữ liệu ticker tổng.');
            return;
        }

        const rawFutures = response.data.data.filter(t => 
            t.instId.endsWith('-USDT-SWAP') && parseFloat(t.vol24h) >= 5000000
        );
        const poolWith4DaysChange = [];

        // 2. Quét nến 1D để tính biến động 4 ngày qua
        for (let i = 0; i < rawFutures.length; i++) {
            const symbol = rawFutures[i].instId;
            try {
                // Lấy 5 nến để có nến index 4 (giá đóng cửa của 4 ngày trước)
                const candle1DUrl = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1D&limit=5`;
                const candleRes = await axios.get(candle1DUrl);

                if (candleRes.data && candleRes.data.code === '0' && candleRes.data.data.length >= 5) {
                    const candles1D = candleRes.data.data;
                    const lastPrice = parseFloat(rawFutures[i].last);
                    const closePrice4DaysAgo = parseFloat(candles1D[4][4]); // Giá close của 4 ngày trước
                    
                    const change4Days = closePrice4DaysAgo ? ((lastPrice - closePrice4DaysAgo) / closePrice4DaysAgo) * 100 : 0;
                    
                    poolWith4DaysChange.push({ symbol, change4Days });
                }
                if (i % 5 === 0) await sleep(50); // Tránh bị rate limit khi quét diện rộng
            } catch (err) {
                console.warn(`Lỗi lấy dữ liệu nến 1D cho ${symbol}`);
            }
        }

        // 3. Sắp xếp tìm Top 20 giảm mạnh nhất
        const top20Losers4Days = poolWith4DaysChange
            .sort((a, b) => a.change4Days - b.change4Days) // Thấp nhất (giảm nhiều nhất) lên đầu
            .slice(0, 20)
            .map(item => item.symbol);

        if (top20Losers4Days.length === 0) {
            console.log('Không tìm thấy dữ liệu hợp lệ.');
            return;
        }

        // 4. Ghi mảng 20 coin này vào file state.json
        const finalState = {
            top20Losers: top20Losers4Days
        };

        fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2), 'utf8');
        console.log(`--- ĐÃ ĐỒNG BỘ THÀNH CÔNG TOP 20 COIN VÀO STATE.JSON ---`, top20Losers4Days);

    } catch (error) {
        console.error('Lỗi hệ thống file 7h.js:', error.message);
    }
}

main();
