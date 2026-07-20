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

async function fetch5DayChange(coin, rawFuturesMap) {
  const symbol = coin.instId;
  try {
    const candle1DUrl = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1D&limit=6`;
    const candleRes = await axios.get(candle1DUrl, { timeout: 5000 });

    if (candleRes.data && candleRes.data.code === '0' && candleRes.data.data.length >= 6) { 
      const candles1D = candleRes.data.data; 
      const currentLivePrice = parseFloat(rawFuturesMap[symbol]); 
      const open5DaysAgo = parseFloat(candles1D[5][1]); 
      const change5Days = open5DaysAgo ? ((currentLivePrice - open5DaysAgo) / open5DaysAgo) * 100 : 0; 
      return { symbol, change5Days }; 
    } 
  } catch (err) {} 
  return null; 
}

async function main() {
  const startTime = Date.now();
  console.log('--- BẤT ĐẦU LỌC SONG SONG: TOP 30 COIN GIẢM GIÁ 5 NGÀY (VOL > 2M USD) ---');
  try {
    const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const response = await axios.get(tickersUrl);
    if (!response.data || response.data.code !== '0') {
      console.error('Không thể lấy dữ liệu ticker tổng từ sàn OKX.');
      return;
    }

    const rawFutures = response.data.data.filter(t => t.instId.endsWith('-USDT-SWAP') && parseFloat(t.volCcy24h) > 1900000 ); 
    console.log(`Tìm thấy ${rawFutures.length} coin thoả mãn Volume 24h.`); 
    if (rawFutures.length === 0) return; 
    
    const rawFuturesMap = {}; 
    rawFutures.forEach(t => { 
      rawFuturesMap[t.instId] = t.last; 
    }); 
    
    console.log('Đang quét lịch sử nến 1D song song...'); 
    const results = await asyncPool(MAX_CONCURRENT_REQUESTS, rawFutures, (coin) => fetch5DayChange(coin, rawFuturesMap) ); 
    const poolWithChanges = results.filter(r => r !== null); 
    
    const top30Losers = poolWithChanges 
      .sort((a, b) => a.change5Days - b.change5Days) 
      .slice(0, 30); 
      
    const top30LosersSymbols = top30Losers.map(item => item.symbol); 
    const finalState = { top30Losers: top30LosersSymbols }; 
    
    fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2), 'utf8'); 
    const duration = ((Date.now() - startTime) / 1000).toFixed(2); 
    
    console.log(`--- HOÀN THÀNH LỌC TRONG ${duration} GIÂY ---`); 
    console.log(`- Đã lưu Top 30 Giảm vào statetop_5d.json`); 
    console.log('\nChi tiết biên độ giảm thực tế (Real-time vs Open 5D):'); 
    top30Losers.forEach((c, idx) => { 
      console.log(`${idx + 1}. ${c.symbol}: ${c.change5Days.toFixed(2)}%`); 
    }); 
  } catch (error) { 
    console.error('Lỗi hệ thống file top_5d.js:', error.message); 
  } 
}

main();
