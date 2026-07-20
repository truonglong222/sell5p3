import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OKX_BASE_URL = 'https://www.okx.com';
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));

// File lưu trữ kết quả chính xác
const STATE_FILE = path.join(CURRENT_DIR, 'statetop3_4h.json'); 
const STATETOP_5D_FILE = path.join(CURRENT_DIR, 'statetop_5d.json');
const COIN_TTL = 24 * 60 * 60 * 1000;
// Điều kiện biến động cứng (4%)
const GROWTH_THRESHOLD = 4.0; 

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
      await sleep(150 + Math.random() * 100); 
    } 
  } 
  await Promise.all(executing); 
  return results; 
}

async function main() {
  const startTime = Date.now();
  console.log(`--- BẤT ĐẦU LỌC COIN BIẾN ĐỘNG > ${GROWTH_THRESHOLD}% TỪ FILE STATETOP_5D ---`);

  try { 
    // Tải danh sách coin bắt buộc từ file statetop_5d.json
    let allowedSymbols = new Set(); 
    if (fs.existsSync(STATETOP_5D_FILE)) { 
      try { 
        const content5d = fs.readFileSync(STATETOP_5D_FILE, 'utf8'); 
        const data5d = JSON.parse(content5d); 
        const list5d = Array.isArray(data5d) ? data5d : (data5d.top30Losers || data5d.top20Losers || data5d.top5d || []); 
        allowedSymbols = new Set(list5d.map(item => typeof item === 'object' ? item.symbol : item)); 
        console.log(`Đã tải ${allowedSymbols.size} coin mục tiêu từ file statetop_5d.json`); 
      } catch (e) { 
        console.warn('Không thể đọc hoặc lỗi định dạng file statetop_5d.json. Quy trình dừng vì không có danh sách gốc.');
        return;
      } 
    } else {
      return console.error(`Không tìm thấy file điều kiện gốc: ${STATETOP_5D_FILE}`);
    }

    if (allowedSymbols.size === 0) return console.log('Danh sách coin cho phép trống.');

    const resTickers = await axios.get(`${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`); 
    if (!resTickers.data || resTickers.data.code !== '0') { 
      return console.error('Lỗi lấy ticker tổng từ OKX'); 
    } 

    // Lọc: Chỉ lấy các coin đang có Volume > 2M USD VÀ phải nằm trong danh sách file 5d
    const validCoins = resTickers.data.data.filter(t => 
      t.instId.endsWith('-USDT-SWAP') && 
      parseFloat(t.volCcy24h) > 2000000 && 
      allowedSymbols.has(t.instId)
    ); 
    
    console.log(`Số lượng coin cần quét nến thực tế (đã khớp 2 file): ${validCoins.length} coin.`); 
    if (validCoins.length === 0) return console.log('Không có coin nào trong file 5d thỏa mãn volume > 2M.'); 

    // Quét nến với luồng an toàn (max 3 song song)
    const matchedCoins = await poolRequests(validCoins, 3, async (coin) => {
      try { 
        await sleep(50 + Math.random() * 100);

        const resCandle = await axios.get(`${OKX_BASE_URL}/api/v5/market/candles`, { 
          params: { instId: coin.instId, bar: '2H', limit: '3' } 
        }); 
        const candles = resCandle.data?.data; 
        if (!candles || candles.length < 3) return null; 
        
        const close0 = parseFloat(candles[0][4]); 
        const open2 = parseFloat(candles[2][1]); 
        const changeCalculated = ((close0 - open2) / open2) * 100;

        // KIỂM TRA ĐIỀU KIỆN CỨNG: Biến động 4h phải >= 4%
        if (changeCalculated >= GROWTH_THRESHOLD) {
          return { 
            symbol: coin.instId, 
            change: `${changeCalculated.toFixed(2)}%`, 
            timestamp: Date.now() 
          }; 
        }
        return null; 
      } catch (err) { 
        if (err.response?.status === 429) { 
          console.warn(`[CẢNH BÁO] Sàn chặn 429 với cặp: ${coin.instId}. Tự động nghỉ 3 giây...`); 
          await sleep(3000); 
        } 
        return null; 
      } 
    }); 

    // Đọc hoặc khởi tạo cấu trúc dữ liệu cho file statetop3_4h.json
    let existingData = { nextResetTime: getTargetResetTime(), top3Gainers4h: [] }; 

    if (fs.existsSync(STATE_FILE)) { 
      try { 
        const fileContent = fs.readFileSync(STATE_FILE, 'utf8'); 
        existingData = JSON.parse(fileContent); 
        if (!existingData.nextResetTime) existingData.nextResetTime = getTargetResetTime(); 
        if (!Array.isArray(existingData.top3Gainers4h)) existingData.top3Gainers4h = []; 
      } catch (e) { 
        console.warn('File lưu trữ cũ bị lỗi định dạng, sẽ khởi tạo lại.'); 
      } 
    } 

    // ĐÃ ĐỔI: Đồng bộ thông báo reset chính xác cho file statetop3_4h.json
    if (Date.now() >= existingData.nextResetTime) { 
      console.log('--- Đã đến 18h00 tối (Giờ VN)! Tiến hành reset sạch file statetop3_4h.json ---'); 
      existingData.top3Gainers4h = []; 
      existingData.nextResetTime = getTargetResetTime(); 
    } 

    // Tự động dọn dẹp data quá 24h
    const beforeCount = existingData.top3Gainers4h.length; 
    existingData.top3Gainers4h = existingData.top3Gainers4h.filter(coin => { 
      const coinAge = Date.now() - (coin.timestamp || 0); 
      return coinAge < COIN_TTL; 
    }); 
    const afterCount = existingData.top3Gainers4h.length; 
    if (beforeCount !== afterCount) { 
      console.log(`- Đã tự động xóa ${beforeCount - afterCount} coin do hết hạn lưu trữ 24 tiếng.`); 
    } 

    // Cập nhật hoặc đẩy thêm coin mới thỏa mãn điều kiện vào bộ nhớ tạm
    const currentSymbols = new Set(existingData.top3Gainers4h.map(item => item.symbol)); 
    for (const coin of matchedCoins) { 
      if (!currentSymbols.has(coin.symbol)) { 
        existingData.top3Gainers4h.push(coin); 
        console.log(`+ Thêm mới thỏa mãn (>4%): ${coin.symbol} (${coin.change})`); 
      } else { 
        const index = existingData.top3Gainers4h.findIndex(item => item.symbol === coin.symbol); 
        existingData.top3Gainers4h[index].change = coin.change; 
        existingData.top3Gainers4h[index].timestamp = Date.now(); 
        console.log(`~ Cập nhật chỉ số: ${coin.symbol} (${coin.change})`);
      } 
    } 

    // Ghi đè cập nhật vào file statetop3_4h.json
    fs.writeFileSync(STATE_FILE, JSON.stringify(existingData, null, 2), 'utf8'); 
    console.log(`--- HOÀN THÀNH ĐỒNG BỘ TRONG ${((Date.now() - startTime) / 1000).toFixed(2)} GIÂY ---`); 
    console.log(`- Tổng số coin lưu giữ hiện tại trong file: ${existingData.top3Gainers4h.length}`); 
    console.log(`- File kết quả: ${STATE_FILE}`); 
  } catch (error) { 
    console.error('Lỗi hệ thống trong quy trình:', error.message); 
  } 
}

main();
