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
    console.log('--- BẮT ĐẦU CHỐT GIÁ VÀ LỌC DANH SÁCH 2 NGÀY TĂNG (2% - 10%) LÚC 7H SÁNG ---');
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
        const qualified2DaysGainers = []; // Mảng lưu các coin có 2 ngày tăng từ 2% đến 10%

        // 2. Duyệt từng coin để lấy giá 7h và kiểm tra nến ngày (1D)
        for (let i = 0; i < rawFutures.length; i++) {
            const symbol = rawFutures[i].instId;
            try {
                const candle1HUrl = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=3`;
                const candle1DUrl = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1D&limit=3`; // Chỉ cần lấy 3 cây nến ngày

                const [res1H, res1D] = await Promise.all([
                    axios.get(candle1HUrl).catch(() => null),
                    axios.get(candle1DUrl).catch(() => null)
                ]);

                // 2.1 Xử lý lấy giá mở cửa chuẩn mốc 7h sáng VN
                if (res1H && res1H.data && res1H.data.code === '0' && res1H.data.data.length >= 2) {
                    openPricesData[symbol] = parseFloat(res1H.data.data[0][1]);
                } else {
                    openPricesData[symbol] = parseFloat(rawFutures[i].last);
                }

                // 2.2 Xử lý lọc điều kiện nến 2 ngày qua: > 2% và < 10%
                if (res1D && res1D.data && res1D.data.code === '0' && res1D.data.data.length >= 3) {
                    const candles1D = res1D.data.data;
                    // data[0] là nến hôm nay, data[1] và data[2] là 2 cây nến ngày trước đó đã đóng cửa hoàn chỉnh
                    const closePrice2DaysAgo = parseFloat(candles1D[2][4]); // Giá đóng cửa của 2 ngày trước
                    const lastPrice = parseFloat(rawFutures[i].last);
                    
                    // Tính biên độ % tăng trưởng trong 2 ngày qua
                    const growth2Days = openPricesData[symbol] ? ((lastPrice - closePrice2DaysAgo) / closePrice2DaysAgo) * 100 : 0;
                    
                    // Điều kiện mới: Lớn hơn 2% VÀ Nhỏ hơn 10%
                    if (growth2Days > 2 && growth2Days < 10) {
                        qualified2DaysGainers.push(symbol);
                        console.log(`[Đạt tiêu chuẩn] ${symbol} tăng ${growth2Days.toFixed(2)}% trong 2 ngày qua.`);
                    }
                }

                if (i % 5 === 0) await sleep(100);

            } catch (err) {
                openPricesData[symbol] = parseFloat(rawFutures[i].last);
            }
        }

        // 3. Ghi đè vào file state.json cấu trúc mới phẳng
        const finalState = {
            qualified2DaysGainers: qualified2DaysGainers,
            openPrices: openPricesData
        };

        fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2), 'utf8');
        console.log('--- ĐÃ GHI ĐÈ FILE STATE.JSON THÀNH CÔNG ---');

    } catch (error) {
        console.error('Lỗi hệ thống file 7h.js:', error.message);
    }
}

main();
