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
    console.log('--- BẮT ĐẦU CHỐT GIÁ MỚI VÀ LỌC TOP 10 24H LÚC 7H SÁNG ---');
    try {
        // 1. Lấy danh sách tất cả coin Futures USDT kèm thông tin 24h
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);
        if (!response.data || response.data.code !== '0') {
            console.error('Không thể lấy dữ liệu ticker tổng.');
            return;
        }

        const rawFutures = response.data.data.filter(t => t.instId.endsWith('-USDT-SWAP'));
        
        // 2. Lọc nhanh Top 10 coin tăng mạnh nhất 24h tại thời điểm 7h sáng
        const sortedBy24h = [...rawFutures]
            .map(t => {
                const open24h = parseFloat(t.open24h);
                const lastPrice = parseFloat(t.last);
                const change24h = open24h ? ((lastPrice - open24h) / open24h) * 100 : 0;
                return { instId: t.instId, change24h };
            })
            .sort((a, b) => b.change24h - a.change24h)
            .slice(0, 10);
            
        const top10GainersList = sortedBy24h.map(c => c.instId);
        console.log('Danh sách Top 10 tăng mạnh nhất 24h chốt lúc 7h:', top10GainersList);

        const openPricesData = {};

        // 3. Duyệt từng coin để lấy chính xác giá mở cửa lúc 7h sáng VN
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
                        openPricesData[symbol] = parseFloat(targetCandle[1]);
                    } else {
                        openPricesData[symbol] = parseFloat(candleRes.data.data[0][1]);
                    }
                }
                
                if (i % 5 === 0) await sleep(100);

            } catch (err) {
                openPricesData[symbol] = parseFloat(rawFutures[i].last);
            }
        }

        // 4. Cấu trúc lại dữ liệu đầu ra và ghi đè hoàn toàn lên state.json cũ
        const finalState = {
            top10Gainers24h: top10GainersList,
            openPrices: openPricesData
        };

        fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2), 'utf8');
        console.log('--- ĐÃ GHI ĐÈ DỮ LIỆU MỚI VÀO STATE.JSON THÀNH CÔNG ---');

    } catch (error) {
        console.error('Lỗi hệ thống file 7h.js:', error.message);
    }
}

main();
