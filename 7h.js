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
    console.log('--- BẮT ĐẦU CHỐT GIÁ VÀ KIỂM TRA XU HƯỚNG NẾN NGÀY LÚC 7H SÁNG ---');
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
        const qualifiedLongCoins = []; // Danh sách các coin có 3 ngày vừa qua tăng > 5%

        // 2. Duyệt từng coin để lấy giá 7h và kiểm tra nến ngày (1D)
        for (let i = 0; i < rawFutures.length; i++) {
            const symbol = rawFutures[i].instId;
            try {
                // Lấy song song dữ liệu nến 1H (để chốt giá 7h) và nến 1D (để check điều kiện tăng 3 ngày)
                const candle1HUrl = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=3`;
                const candle1DUrl = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1D&limit=4`;

                const [res1H, res1D] = await Promise.all([
                    axios.get(candle1HUrl).catch(() => null),
                    axios.get(candle1DUrl).catch(() => null)
                ]);

                // 2.1 Xử lý lấy giá mở cửa chuẩn 7h sáng
                if (res1H && res1H.data && res1H.data.code === '0' && res1H.data.data.length >= 2) {
                    openPricesData[symbol] = parseFloat(res1H.data.data[0][1]);
                } else {
                    openPricesData[symbol] = parseFloat(rawFutures[i].last);
                }

                // 2.2 Xử lý kiểm tra điều kiện 3 nến ngày vừa qua tăng trên 5%
                if (res1D && res1D.data && res1D.data.code === '0' && res1D.data.data.length >= 4) {
                    const candles1D = res1D.data.data;
                    // OKX trả nến từ mới đến cũ: data[0] là nến hôm nay đang chạy, data[1], data[2], data[3] là 3 ngày trước đó đã đóng cửa
                    const closePrice3DaysAgo = parseFloat(candles1D[3][4]); // Giá đóng cửa 3 ngày trước
                    const lastPrice = parseFloat(rawFutures[i].last); // Giá hiện tại (hoặc giá đóng nến ngày gần nhất)
                    
                    // Tính % biến động trong 3 ngày vừa qua
                    const growth3Days = ((lastPrice - closePrice3DaysAgo) / closePrice3DaysAgo) * 100;
                    
                    if (growth3Days > 5) {
                        qualifiedLongCoins.push(symbol);
                        console.log(`[Đạt chuẩn Ngày] ${symbol} tăng ${growth3Days.toFixed(2)}% trong 3 ngày qua (> 5%)`);
                    }
                }

                if (i % 5 === 0) await sleep(100);

            } catch (err) {
                openPricesData[symbol] = parseFloat(rawFutures[i].last);
            }
        }

        // 3. Ghi đè cấu trúc dữ liệu mới vào file state.json
        const finalState = {
            qualifiedLongCoins: qualifiedLongCoins, // Lưu danh sách bộ lọc ngày
            openPrices: openPricesData
        };

        fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2), 'utf8');
        console.log('--- ĐÃ ĐỒNG BỘ GIÁ 7H VÀ DANH SÁCH LỌC NGÀY VÀO STATE.JSON THÀNH CÔNG ---');

    } catch (error) {
        console.error('Lỗi hệ thống file 7h.js:', error.message);
    }
}

main();
