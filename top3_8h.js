import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OKX_BASE_URL = 'https://www.okx.com';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Đã chỉnh sửa: Đồng bộ hóa tên biến định nghĩa đồng nhất là STATE_FILE
const STATE_FILE = path.join(__dirname, 'statetop3_8h.json');

async function main() {
    const startTime = Date.now();
    console.log('--- BẤT ĐẦU QUY TRÌNH LỌC TOP 3 TĂNG/GIẢM KHUNG 8H (TỐI ƯU HÓA 1 REQUEST) ---');
    try {
        // 1. Tải Ticker tổng từ OKX (Chỉ tốn 1 request duy nhất cho toàn bộ sàn)
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);
        if (!response.data || response.data.code !== '0') {
            console.error('Không thể lấy dữ liệu ticker tổng từ OKX.');
            return;
        }

        // Lọc các cặp SWAP-USDT có Volume 24h quy đổi > 2,000,000 USD
        const rawFutures = response.data.data.filter(t => 
            t.instId.endsWith('-USDT-SWAP') && parseFloat(t.volCcy24h) > 2000000
        );

        console.log(`Tìm thấy ${rawFutures.length} coin thỏa mãn Volume > 2M USD.`);
        if (rawFutures.length === 0) return;

        // 2. Tính toán biên độ biến động trực tiếp từ dữ liệu Ticker tổng (Không gọi thêm API nến)
        const validResults = rawFutures.map(t => {
            const lastPrice = parseFloat(t.last);     // Giá hiện tại
            const openPrice = parseFloat(t.open24h); // Giá mở cửa 24h được sàn cập nhật liên tục
            
            // Tính % biến động
            const change8h = openPrice > 0 ? ((lastPrice - openPrice) / openPrice) * 100 : 0;
            
            return {
                symbol: t.instId,
                change8h: change8h
            };
        });

        // 3. Phân tách danh sách và trích xuất Top 3 Tăng / Top 3 Giảm
        
        // Top 3 Tăng mạnh nhất (change8h từ lớn đến nhỏ)
        const top3Gainers8h = [...validResults]
            .sort((a, b) => b.change8h - a.change8h)
            .slice(0, 3)
            .map(item => item.symbol);

        // Top 3 Giảm mạnh nhất (change8h từ nhỏ đến lớn)
        const top3Losers8h = [...validResults]
            .sort((a, b) => a.change8h - b.change8h)
            .slice(0, 3)
            .map(item => item.symbol);

        // 4. Lưu dữ liệu hoàn chỉnh vào file statetop3_8h.json
        const finalState = {
            top3Gainers8h: top3Gainers8h,
            top3Losers8h: top3Losers8h
        };

        // Đã sửa: Gọi đúng tên biến STATE_FILE
        fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2), 'utf8');

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`--- HOÀN THÀNH ĐỒNG BỘ TRONG ${duration} GIÂY ---`);
        console.log(`- Đã lưu Top 3 Tăng 8h vào JSON:`, top3Gainers8h);
        console.log(`- Đã lưu Top 3 Giảm 8h vào JSON:`, top3Losers8h);

    } catch (error) {
        console.error('Lỗi hệ thống file top3_8h.js:', error.message);
    }
}

main();
