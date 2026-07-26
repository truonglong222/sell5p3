import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OKX_BASE_URL = 'https://www.okx.com';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Đổi tên file lưu thành statetop_7d.json
const STATE_FILE = path.join(__dirname, 'statetop_7d.json');
const MAX_CONCURRENT_REQUESTS = 8;

async function asyncPool(limit, array, iteratorFn) {
  const ret = [];
  const executing = new Set();
  for (const item of array) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(ret);
}

async function fetchCandleData(coin) {
  const symbol = coin.instId;
  try {
    // Lấy 8 nến 1D để truy cập đến nến index [7] (7 ngày trước)
    const candle1DUrl = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1D&limit=8`;
    const candleRes = await axios.get(candle1DUrl, { timeout: 5000 });

    if (candleRes.data && candleRes.data.code === '0' && candleRes.data.data.length >= 8) { 
      const candles1D = candleRes.data.data; 

      // Cấu trúc nến OKX: [ts, open, high, low, close, ...]
      
      // Giá mở cửa 7 ngày trước (index [7])
      const open7DaysAgo = parseFloat(candles1D[7][1]); 

      // Giá đóng cửa nến cách đây 2 ngày (index [2])
      const close2DaysAgo = parseFloat(candles1D[2][4]);

      // So sánh Nến [2] đóng với Nến mở 7 ngày trước
      let change7DaysGain = null;
      if (open7DaysAgo > 0 && close2DaysAgo > 0) {
        change7DaysGain = ((close2DaysAgo - open7DaysAgo) / open7DaysAgo) * 100;
      }

      // Biến động nến vừa đóng hôm qua (index [1])
      const open1D = parseFloat(candles1D[1][1]);
      const closeYesterday = parseFloat(candles1D[1][4]);
      const change1DPercentage = open1D > 0 ? ((closeYesterday - open1D) / open1D) * 100 : 0;

      return { 
        symbol, 
        change7DaysGain,
        change1Day: change1DPercentage
      }; 
    } 
  } catch (err) {} 
  return null; 
}

async function main() {
  const startTime = Date.now();
  console.log('--- BẤT ĐẦU LỌC SONG SONG: TOP 30 COIN TĂNG MẠNH NHẤT 7 NGÀY (VOL > 5M USD) ---');
  try {
    const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const response = await axios.get(tickersUrl);
    if (!response.data || response.data.code !== '0') {
      console.error('Không thể lấy dữ liệu ticker tổng từ sàn OKX.');
      return;
    }

    // Lọc Volume 24h > 5,000,000 USD
    const rawFutures = response.data.data.filter(t => t.instId.endsWith('-USDT-SWAP') && parseFloat(t.volCcy24h) > 5000000); 
    console.log(`Tìm thấy ${rawFutures.length} coin thoả mãn Volume 24h (> 5M USD).`); 
    if (rawFutures.length === 0) return; 
    
    console.log('Đang quét lịch sử nến 1D song song...'); 
    
    const results = await asyncPool(MAX_CONCURRENT_REQUESTS, rawFutures, (coin) => fetchCandleData(coin)); 
    const poolData = results.filter(r => r !== null); 
    
    // Sắp xếp & Lấy Top 30 Tăng giá trong 7 ngày
    const top30Gainers7D = poolData
      .filter(r => r.change7DaysGain !== null)
      .sort((a, b) => b.change7DaysGain - a.change7DaysGain)
      .slice(0, 30)
      .map((item, index) => ({
        symbol: item.symbol,
        rank7dGain: index + 1,
        change7DaysGain: parseFloat(item.change7DaysGain.toFixed(2)),
        change1Day: parseFloat(item.change1Day.toFixed(2))
      }));

    const finalState = { 
      updatedAt: new Date().toISOString(),
      top30Gainers7D,
      // Đặt thêm key top30Gainers5D để tương thích ngược với code SHORT nếu chưa cập nhật
      top30Gainers5D: top30Gainers7D 
    }; 
    
    fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2), 'utf8'); 
    const duration = ((Date.now() - startTime) / 1000).toFixed(2); 
    
    console.log(`--- HOÀN THÀNH LỌC TRONG ${duration} GIÂY ---`); 
    console.log(`- Đã lưu kết quả vào ${STATE_FILE}`); 

    console.log('\n--- TOP 30 COIN TĂNG GIÁ MẠNH NHẤT 7 NGÀY ---'); 
    top30Gainers7D.forEach((c) => { 
      console.log(`${c.rank7dGain}. ${c.symbol}: Gain 7D ${c.change7DaysGain}% | Nến 1D Vừa Đóng: ${c.change1Day}%`); 
    }); 

  } catch (error) { 
    console.error('Lỗi hệ thống file hoặc mạng:', error.message); 
  } 
}

main();
