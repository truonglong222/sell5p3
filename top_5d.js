import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OKX_BASE_URL = 'https://www.okx.com';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATE_FILE = path.join(__dirname, 'statetop_5d.json');
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
    const candle1DUrl = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1D&limit=6`;
    const candleRes = await axios.get(candle1DUrl, { timeout: 5000 });

    if (candleRes.data && candleRes.data.code === '0' && candleRes.data.data.length >= 6) { 
      const candles1D = candleRes.data.data; 

      // Structure nến OKX: [ts, open, high, low, close, ...]
      
      // Giá mở cửa nến 3 ngày trước (index [3])
      const open3DaysAgo = parseFloat(candles1D[3][1]); 

      // --- 1. LOGIC 3 NGÀY GIẢM GIÁ (dùng công thức (open - low) / open) ---
      // Giá thấp nhất trong 3 ngày (từ nến [0] đến [3])
      const lowestPrice3D = Math.min(...candles1D.slice(0, 4).map(c => parseFloat(c[3])));
      
      let dropPercentage3D = null;
      if (open3DaysAgo > 0 && lowestPrice3D > 0) {
        dropPercentage3D = ((open3DaysAgo - lowestPrice3D) / open3DaysAgo) * 100;
      }

      // --- 2. LOGIC 3 NGÀY TĂNG GIÁ ---
      // Giá cao nhất trong 3 ngày (từ nến [0] hiện tại đến nến [3])
      const highestPrice3D = Math.max(...candles1D.slice(0, 4).map(c => parseFloat(c[2])));
      
      let gainPercentage3D = null;
      if (open3DaysAgo > 0 && highestPrice3D > 0) {
        gainPercentage3D = ((highestPrice3D - open3DaysAgo) / open3DaysAgo) * 100;
      }

      // --- 3. BIẾN ĐỘNG NẾN VỪA ĐÓNG HÔM QUA (nến index [1]) ---
      const open1D = parseFloat(candles1D[1][1]);
      const close1D = parseFloat(candles1D[1][4]);
      const change1DPercentage = open1D > 0 ? ((close1D - open1D) / open1D) * 100 : 0;

      return { 
        symbol, 
        change3DaysDrop: dropPercentage3D,
        change3DaysGain: gainPercentage3D,
        change1Day: change1DPercentage
      }; 
    } 
  } catch (err) {} 
  return null; 
}

async function main() {
  const startTime = Date.now();
  console.log('--- BẤT ĐẦU LỌC SONG SONG: TOP 20 GIẢM 3D & TOP 20 TĂNG 3D (VOL > 2M USD) ---');
  try {
    const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const response = await axios.get(tickersUrl);
    if (!response.data || response.data.code !== '0') {
      console.error('Không thể lấy dữ liệu ticker tổng từ sàn OKX.');
      return;
    }

    const rawFutures = response.data.data.filter(t => t.instId.endsWith('-USDT-SWAP') && parseFloat(t.volCcy24h) > 1900000); 
    console.log(`Tìm thấy ${rawFutures.length} coin thoả mãn Volume 24h.`); 
    if (rawFutures.length === 0) return; 
    
    console.log('Đang quét lịch sử nến 1D song song...'); 
    
    const results = await asyncPool(MAX_CONCURRENT_REQUESTS, rawFutures, (coin) => fetchCandleData(coin)); 
    const poolData = results.filter(r => r !== null); 
    
    // 1. Sắp xếp & Lấy Top 20 Giảm 3 ngày
    const top20Losers = poolData
      .filter(r => r.change3DaysDrop !== null)
      .sort((a, b) => b.change3DaysDrop - a.change3DaysDrop) 
      .slice(0, 20)
      .map((item, index) => ({
        symbol: item.symbol,
        rank3dDrop: index + 1,
        change3DaysDrop: parseFloat(item.change3DaysDrop.toFixed(2)),
        change1Day: parseFloat(item.change1Day.toFixed(2))
      }));

    // 2. Sắp xếp & Lấy Top 20 Tăng 3 ngày
    const top20Gainers3D = poolData
      .filter(r => r.change3DaysGain !== null)
      .sort((a, b) => b.change3DaysGain - a.change3DaysGain)
      .slice(0, 20)
      .map((item, index) => ({
        symbol: item.symbol,
        rank3dGain: index + 1,
        change3DaysGain: parseFloat(item.change3DaysGain.toFixed(2)),
        change1Day: parseFloat(item.change1Day.toFixed(2))
      }));

    const finalState = { 
      top20Losers,
      top20Gainers3D
    }; 
    
    fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2), 'utf8'); 
    const duration = ((Date.now() - startTime) / 1000).toFixed(2); 
    
    console.log(`--- HOÀN THÀNH LỌC TRONG ${duration} GIÂY ---`); 
    console.log(`- Đã lưu kết quả vào statetop_5d.json`); 

    console.log('\n--- TOP 20 COIN GIẢM GIÁ 3 NGÀY ---'); 
    top20Losers.forEach((c) => { 
      console.log(`${c.rank3dDrop}. ${c.symbol}: Max Drop 3D ${c.change3DaysDrop}% | Nến 1D Vừa Đóng: ${c.change1Day}%`); 
    }); 

    console.log('\n--- TOP 20 COIN TĂNG GIÁ 3 NGÀY ---'); 
    top20Gainers3D.forEach((c) => { 
      console.log(`${c.rank3dGain}. ${c.symbol}: Max Gain 3D ${c.change3DaysGain}% | Nến 1D Vừa Đóng: ${c.change1Day}%`); 
    }); 

  } catch (error) { 
    console.error('Lỗi hệ thống file:', error.message); 
  } 
}

main();
