import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BINANCE_BASE_URL = 'https://fapi.binance.com';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE = path.join(__dirname, 'state_binance.json'); // Lưu riêng biệt cho Binance

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    console.log('--- BẮT ĐẦU QUÉT DỮ LIỆU BINANCE VÀ LỌC 7 NGÀY LÚC 7H SÁNG ---');
    try {
        // 1. Lấy danh sách thông tin ticker 24h của toàn bộ sàn Binance Futures
        const tickersUrl = `${BINANCE_BASE_URL}/fapi/v1/ticker/24hr`;
        const response = await axios.get(tickersUrl);
        if (!response.data || !Array.isArray(response.data)) {
            console.error('Không thể lấy dữ liệu ticker tổng từ Binance.');
            return;
        }

        const rawFutures = response.data.filter(t => t.symbol.endsWith('USDT'));
        const openPricesData = {};
        const qualified7DaysGainers = []; 
        const heavy7DaysLosers = [];      

        // 2. Duyệt từng coin - Lấy nến 1D
        for (let i = 0; i < rawFutures.length; i++) {
            const symbol = rawFutures[i].symbol;
            try {
                const candle1DUrl = `${BINANCE_BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=8`;
                const candleRes = await axios.get(candle1DUrl);

                if (candleRes.data && Array.isArray(candleRes.data) && candleRes.data.length >= 8) {
                    const candles1D = candleRes.data;

                    // Giá mở cửa nến ngày hôm nay lúc 7h sáng VN
                    const todayCandle = candles1D[candles1D.length - 1];
                    const exact7AMPrice = parseFloat(todayCandle[1]); 
                    openPricesData[symbol] = exact7AMPrice;

                    // Giá đóng cửa của 7 ngày trước (nến index 0)
                    const closePrice7DaysAgo = parseFloat(candles1D[0][4]); 
                    const lastPrice = parseFloat(rawFutures[i].lastPrice);
                    
                    // Tính biên độ % biến động trong 7 ngày qua
                    const change7Days = exact7AMPrice ? ((lastPrice - closePrice7DaysAgo) / closePrice7DaysAgo) * 100 : 0;

                    // Điều kiện Long: Tăng > 2% và < 15%
                    if (change7Days > 2 && change7Days < 15) {
                        qualified7DaysGainers.push(symbol);
                    }
                    
                    // Điều kiện chặn Short: Giảm quá sâu <= -30%
                    if (change7Days <= -30) {
                        heavy7DaysLosers.push(symbol);
                        console.log(`[Cảnh báo Giảm Sâu] ${symbol} đã giảm ${change7Days.toFixed(2)}% trên Binance.`);
                    }
                } else {
                    openPricesData[symbol] = parseFloat(rawFutures[i].lastPrice);
                }

                if (i % 5 === 0) await sleep(40); 

            } catch (err) {
                openPricesData[symbol] = parseFloat(rawFutures[i].lastPrice);
            }
        }

        // 3. Ghi đè kết quả vào file state_binance.json
        const finalState = {
            qualified7DaysGainers: qualified7DaysGainers,
            heavy7DaysLosers: heavy7DaysLosers,
            openPrices: openPricesData
        };

        fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2), 'utf8');
        console.log(`--- BINANCE 7H DONE: ${qualified7DaysGainers.length} mã đạt Long | ${heavy7DaysLosers.length} mã chặn Short ---`);

    } catch (error) {
        console.error('Lỗi hệ thống file 7h_binance.js:', error.message);
    }
}

main();
