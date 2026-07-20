import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OKX_BASE_URL = 'https://www.okx.com';
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(CURRENT_DIR, 'statetop_4h.json'); // Thống nhất tên file JSON
const STATETOP_5D_FILE = path.join(CURRENT_DIR, 'statetop_5d.json');
const COIN_TTL = 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getTargetResetTime() {
  const now = new Date();
  const vnTimeStr = now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" });
  const vnDate = new Date(vnTimeStr);
  vnDate.setHours(18, 0, 0, 0); 
  if (new Date(now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" })).getTime() >= vnDate.getTime()) { 
    vnDate.setDate(vnDate.getDate() + 1); 
  } 
  return vnDate.getTime(); 
}

async function poolRequests(items, maxParallel, fn) {
  const results = [];
  const executing = new Set();
  for (const item of items) { 
    const p = fn(item).then(res => { 
      if (res) results.push(res); 
      executing.delete(p); 
    }); 
    executing.add(p); 
    if (executing.size >= maxParallel) { 
      await Promise.race(executing); 
      await sleep(100); 
    } 
  } 
  await Promise.all(executing); 
  return results; 
}

async function main() {
  const startTime = Date.now();
  console.log('--- BẤT ĐẦU LỌC TOP 5 TĂNG BẰNG 3 NẾN 2H ---');

  try { 
    const resTickers = await axios.get(`${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`); 
    if (!resTickers.data || resTickers.data.code !== '0') { 
      return console.error('Lỗi lấy ticker tổng từ OKX'); 
    } 
    const validCoins = resTickers.data.data.filter(t => t.instId.endsWith('-USDT-SWAP') && parseFloat(t.volCcy24h) > 2000000 ); 
    console.log(`Tìm thấy ${validCoins.length} coin thỏa mãn Volume > 2M USD.`); 
    if (validCoins.length === 0) return; 

    const validResults = await poolRequests(validCoins, 8, async (coin) => {
      try { 
        const resCandle = await axios.get(`${OKX_BASE_URL}/api/v5/market/candles`, { 
          params: { instId: coin.instId, bar: '2H', limit: '3' } 
        }); 
        const candles = resCandle.data?.data; 
        if (!candles || candles.length < 3) return null; 
        const close0 = parseFloat(candles[0][4]); 
        const open2 = parseFloat(candles[2][1]); 
        return { symbol: coin.instId, changeCalculated: ((close0 - open2) / open2) * 100 }; 
      } catch (err) { 
        if (err.response?.status === 429) { 
          console.warn(`Sàn phản hồi 429 với cặp: ${coin.instId}. Đang bỏ qua...`); 
        } 
        return null; 
      } 
    }); 

    if (validResults.length === 0) return console.log('Không có dữ liệu nến hợp lệ.'); 
    const sortedGainers = [...validResults].sort((a, b) => b.changeCalculated - a.changeCalculated); 
    
    let newTop5 = sortedGainers.slice(0, 5).map(i => ({ 
      symbol: i.symbol, 
      change: `${i.changeCalculated.toFixed(2)}%`, 
      timestamp: Date.now() 
    })); 

    // ĐỌC VÀ LỌC THEO FILE 5 NGÀY (Đã sửa để đọc đúng key top30Losers)
    let allowedSymbols = new Set(); 
    if (fs.existsSync(STATETOP_5D_FILE)) { 
      try { 
        const content5d = fs.readFileSync(STATETOP_5D_FILE, 'utf8'); 
        const data5d = JSON.parse(content5d); 
        // Bổ sung thêm data5d.top30Losers vào danh sách ưu tiên kiểm tra
        const list5d = Array.isArray(data5d) ? data5d : (data5d.top30Losers || data5d.top20Losers || data5d.top5d || []); 
        allowedSymbols = new Set(list5d.map(item => typeof item === 'object' ? item.symbol : item)); 
        console.log(`Đã tải ${allowedSymbols.size} coin từ file điều kiện statetop_5d.json`); 
      } catch (e) { 
        console.warn('Không thể đọc hoặc lỗi định dạng file statetop_5d.json.'); 
      } 
    } 

    newTop5 = newTop5.filter(coin => allowedSymbols.has(coin.symbol)); 
    console.log(`Còn lại ${newTop5.length}/5 coin thỏa mãn điều kiện có trong file statetop_5d.json`); 

    let existingData = { nextResetTime: getTargetResetTime(), top3Gainers4h: [] }; 

    if (fs.existsSync(STATE_FILE)) { 
      try { 
        const fileContent = fs.readFileSync(STATE_FILE, 'utf8'); 
        existingData = JSON.parse(fileContent); 
        if (!existingData.nextResetTime) existingData.nextResetTime = getTargetResetTime(); 
        if (!Array.isArray(existingData.top3Gainers4h)) existingData.top3Gainers4h = []; 
      } catch (e) { 
        console.warn('File cũ bị lỗi định dạng, sẽ khởi tạo lại.'); 
      } 
    } 

    if (Date.now() >= existingData.nextResetTime) { 
      console.log('--- Đã đến 18h00 tối (Giờ VN)! Tiến hành reset sạch danh sách cũ ---'); 
      existingData.top3Gainers4h = []; 
      existingData.nextResetTime = getTargetResetTime(); 
    } 

    const beforeCount = existingData.top3Gainers4h.length; 
    existingData.top3Gainers4h = existingData.top3Gainers4h.filter(coin => { 
      const coinAge = Date.now() - (coin.timestamp || 0); 
      return coinAge < COIN_TTL; 
    }); 
    const afterCount = existingData.top3Gainers4h.length; 
    if (beforeCount !== afterCount) { 
      console.log(`- Đã tự động xóa ${beforeCount - afterCount} coin do hết hạn lưu trữ 24 tiếng.`); 
    } 

    const currentSymbols = new Set(existingData.top3Gainers4h.map(item => item.symbol)); 
    for (const coin of newTop5) { 
      if (!currentSymbols.has(coin.symbol)) { 
        existingData.top3Gainers4h.push(coin); 
        console.log(`+ Thêm mới: ${coin.symbol} (${coin.change})`); 
      } else { 
        const index = existingData.top3Gainers4h.findIndex(item => item.symbol === coin.symbol); 
        existingData.top3Gainers4h[index].change = coin.change; 
        existingData.top3Gainers4h[index].timestamp = Date.now(); 
      } 
    } 

    fs.writeFileSync(STATE_FILE, JSON.stringify(existingData, null, 2), 'utf8'); 
    console.log(`--- HOÀN THÀNH ĐỒNG BỘ TRONG ${((Date.now() - startTime) / 1000).toFixed(2)} GIÂY ---`); 
    console.log(`- Tổng số coin hiện tại trong file: ${existingData.top3Gainers4h.length}`); 
    console.log(`- Cập nhật thành công file: ${STATE_FILE}`); 
  } catch (error) { 
    console.error('Lỗi hệ thống trong quy trình:', error.message); 
  } 
}

main();
