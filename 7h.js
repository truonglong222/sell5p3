import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OKX_BASE_URL = 'https://www.okx.com';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE = path.join(__dirname, 'state.json');

// Hàm delay để tránh bị OKX chặn khi gửi nhiều request liên tục
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    console.log('--- BẮT ĐẦU CHỐT GIÁ MỞ CỬA 7H SÁNG ---');
    try {
        // 1. Lấy danh sách tất cả coin Futures USDT
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);
        if (!response.data || response.data.code !== '0') {
            console.error('Không thể lấy dữ liệu ticker tổng.');
            return;
        }

        const rawFutures = response.data.data.filter(t => t.instId.endsWith('-USDT-SWAP'));
        const pricesData = {};

        // 2. Duyệt từng coin để lấy chính xác giá lúc 7h sáng VN (00:00 UTC)
        for (let i = 0; i < rawFutures.length; i++) {
            const symbol = rawFutures[i].instId;
            try {
                // Lấy 5 cây nến 1H gần nhất
                const candleUrl = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=5`;
                const candleRes = await axios.get(candleUrl);
                
                if (candleRes.data && candleRes.data.code === '0' && candleRes.data.data.length > 0) {
                    const now = new Date();
                    // Tạo mốc 00:00:00 UTC hôm nay (7h sáng VN)
                    const today7AM_UTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);

                    // Tìm cây nến khớp mốc 7h sáng
                    const targetCandle = candleRes.data.data.find(c => parseInt(c[0]) === today7AM_UTC);
                    
                    if (targetCandle) {
                        pricesData[symbol] = parseFloat(targetCandle[1]); // Lấy giá Open
                        console.log(`[Thành công] ${symbol}: ${pricesData[symbol]}`);
                    } else {
                        // Nếu chưa có nến mới, lấy tạm giá Open của cây nến hiện tại đang chạy
                        pricesData[symbol] = parseFloat(candleRes.data.data[0][1]);
                        console.log(`[Lấy tạm] ${symbol}: ${pricesData[symbol]}`);
                    }
                }
                
                // Cứ sau 5 requests thì nghỉ 100ms để không bị sàn block
                if (i % 5 === 0) await sleep(100);

            } catch (err) {
                console.error(`Lỗi lấy giá 7h của con ${symbol}:`, err.message);
                // Nếu lỗi thì lấy giá hiện tại trong ticker làm mốc
                pricesData[symbol] = parseFloat(rawFutures[i].last);
            }
        }

        // 3. Ghi đè toàn bộ dữ liệu vào file state.json
        fs.writeFileSync(STATE_FILE, JSON.stringify(pricesData, null, 2), 'utf8');
        console.log('--- ĐÃ LƯU ĐÈ GIÁ 7H VÀO STATE.JSON THÀNH CÔNG ---');

    } catch (error) {
        console.error('Lỗi hệ thống file 7h.js:', error.message);
    }
}

main();
