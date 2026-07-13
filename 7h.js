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
    console.log('--- BẮT ĐẦU QUÉT DỮ LIỆU VÀ LỌC 7 NGÀY (TĂNG/GIẢM) LÚC 7H SÁNG ---');
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
        const qualified7DaysGainers = []; // List Long: 7 ngày tăng > 2% và < 15%
        const heavy7DaysLosers = [];      // List Chặn Short: 7 ngày giảm > 30%

        // 2. Duyệt từng coin - Lấy 9 cây nến 1D (để có đủ nến hôm nay + 7 nến lịch sử đóng cửa trước đó)
        for (let i = 0; i < rawFutures.length; i++) {
            const symbol = rawFutures[i].instId;
            try {
                const candle1DUrl = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1D&limit=9`;
                const candleRes = await axios.get(candle1DUrl);

                if (candleRes.data && candleRes.data.code === '0' && candleRes.data.data.length >= 8) {
                    const candles1D = candleRes.data.data;

                    // Giá mở cửa lúc 7h sáng hôm nay (nến index 0)
                    const exact7AMPrice = parseFloat(candles1D[0][1]); 
                    openPricesData[symbol] = exact7AMPrice;

                    // Giá đóng cửa của 7 ngày trước (nến index 7)
                    const closePrice7DaysAgo = parseFloat(candles1D[7][4]);
                    const lastPrice = parseFloat(rawFutures[i].last);
                    
                    // Tính biên độ % biến động trong 7 ngày qua
                    const change7Days = exact7AMPrice ? ((lastPrice - closePrice7DaysAgo) / closePrice7DaysAgo) * 100 : 0;

                    // Điều kiện 1: Cho phép LONG (Tăng > 2% và < 15%)
                    if (change7Days > 2 && change7Days < 15) {
                        qualified7DaysGainers.push(symbol);
                    }
                    
                    // Điều kiện 2: Chặn SHORT (Giảm quá nhiều > 30%, tức là giá trị âm sâu hơn -30)
                    if (change7Days <= -30) {
                        heavy7DaysLosers.push(symbol);
                        console.log(`[Cảnh báo Giảm Sâu] ${symbol} đã giảm ${change7Days.toFixed(2)}% trong 7 ngày.`);
                    }
                } else {
                    openPricesData[symbol] = parseFloat(rawFutures[i].last);
                }

                if (i % 5 === 0) await sleep(40); // Tối ưu thời gian nghỉ ngắn hơn

            } catch (err) {
                openPricesData[symbol] = parseFloat(rawFutures[i].last);
            }
        }

        // 3. Ghi đè vào file state.json
        const finalState = {
            qualified7DaysGainers: qualified7DaysGainers,
            heavy7DaysLosers: heavy7DaysLosers,
            openPrices: openPricesData
        };

        fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2), 'utf8');
        console.log(`--- ĐÃ ĐỒNG BỘ: ${qualified7DaysGainers.length} coin Long | ${heavy7DaysLosers.length} coin Chặn Short ---`);

    } catch (error) {
        console.error('Lỗi hệ thống file 7h.js:', error.message);
    }
}

main();
