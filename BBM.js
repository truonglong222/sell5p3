import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;
const OKX_BASE_URL = 'https://www.okx.com';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'sent_ema.json');
const RESULTS_FILE = path.join(__dirname, '24h.json');

// Cấu hình Cooldown: 1 TIẾNG
const COOLDOWN_TIME = 1 * 60 * 60 * 1000;
const MIN_VOL_CCY24H = 5_000_000; // Lọc Volume 24h > 5 triệu USDT

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadSentLog() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return data.trim() ? JSON.parse(data) : {};
    }
  } catch (e) {}
  return {};
}

function saveSentLog(logData) {
  try {
    const now = Date.now();
    const cleanedLog = {};
    for (const [coin, timeData] of Object.entries(logData)) {
      const temp = {};
      if (timeData.longAlert && now - timeData.longAlert < COOLDOWN_TIME) {
        temp.longAlert = timeData.longAlert;
      }
      if (timeData.shortAlert && now - timeData.shortAlert < COOLDOWN_TIME) {
        temp.shortAlert = timeData.shortAlert;
      }
      if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
  } catch (e) {}
}

function saveScanResults(results) {
  try {
    const outputData = {
      lastScanAt: new Date().toISOString(),
      ud: results.ud,
      totalScanned: results.totalScanned,
      matchedCount: results.matched.length,
      matchedList: results.matched
    };
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(outputData, null, 2), 'utf8');
  } catch (e) {
    console.error('Lỗi khi lưu 24h.json:', e.message);
  }
}

// ------------------- HÀM TÍNH BOLLINGER BANDS -------------------
function calculateBollingerBands(prices, period = 20, stdDevMultiplier = 2) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    middle: mean,
    upper: mean + stdDevMultiplier * stdDev,
    lower: mean - stdDevMultiplier * stdDev
  };
}

// ------------------- LỌC COIN & TÍNH CHỈ SỐ UD -------------------
async function getFilteredMarkets() {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') return { ud: 0, longList: [], shortList: [] };

    const tickers = res.data.data;
    const swapTickers = tickers.filter(item => item.instId.endsWith('-USDT-SWAP'))
      .map(item => {
        const last = parseFloat(item.last || 0);
        const open24h = parseFloat(item.open24h || 0);
        const change24h = open24h > 0 ? ((last - open24h) / open24h) * 100 : 0;
        return {
          instId: item.instId,
          lastPrice: last,
          change24h: change24h,
          volCcy24h: parseFloat(item.volCcy24h || 0)
        };
      });

    // 1. Tính hiệu số ud (Up - Down) toàn bộ thị trường swap USDT
    const upCount = swapTickers.filter(c => c.change24h > 0).length;
    const downCount = swapTickers.filter(c => c.change24h < 0).length;
    const ud = upCount - downCount;

    // 2. Lọc coin Volume > 5 Triệu
    const volFiltered = swapTickers.filter(c => c.volCcy24h > MIN_VOL_CCY24H);

    // 3. Phân loại List Long và List Short
    const longList = volFiltered.filter(c => c.change24h >= 7 && c.change24h <= 15);
    const shortList = volFiltered.filter(c => c.change24h >= -15 && c.change24h <= -7);

    return { ud, longList, shortList };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { ud: 0, longList: [], shortList: [] };
  }
}

// ------------------- LẤY DỮ LIỆU NẾN 5M -------------------
async function getCandleData5m(symbol) {
  try {
    // Cần tối thiểu 40 nến để tính BB nến thứ 15 và 10 nến biến động trước đó
    const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=5m&limit=50`;
    const res = await axios.get(url, { timeout: 5000 });

    if (!res.data || res.data.code !== '0' || res.data.data.length < 40) return null;
    return res.data.data;
  } catch (error) {
    console.error(`Lỗi lấy dữ liệu nến 5m (${symbol}):`, error.message);
    return null;
  }
}

// ------------------- PHÂN TÍCH TÍN HIỆU THEO THUẬT TOÁN -------------------
function evaluateIndicators(raw5m) {
  // raw5m: [0] là nến hiện tại, [1] là nến trước đó,...
  // Mỗi nến: [ts, open, high, low, close, ...]
  const closes = raw5m.map(c => parseFloat(c[4]));
  const currentCandle = raw5m[0];
  const high0 = parseFloat(currentCandle[2]);
  const low0 = parseFloat(currentCandle[3]);
  const close0 = parseFloat(currentCandle[4]);

  // 1. BB nến hiện tại (chỉ số 0)
  const closes0 = closes.slice(0, 20).reverse();
  const bb0 = calculateBollingerBands(closes0, 20);

  // 2. BB nến số 15
  const closes15 = closes.slice(15, 35).reverse();
  const bb15_val = calculateBollingerBands(closes15, 20);

  if (!bb0 || !bb15_val) return null;

  // bb15: chênh lệch % giữa BB Mid hiện tại và BB Mid nến 15
  const bb15 = ((bb0.middle - bb15_val.middle) / bb15_val.middle) * 100;

  // Hbb: chênh lệch % giữa BB Upper và BB Lower nến hiện tại
  const Hbb = ((bb0.upper - bb0.lower) / bb0.lower) * 100;

  // bbm: Chênh lệch % giữa giá/râu hiện tại và BB Mid
  // Nếu nến tăng/nằm trên mid tính theo High, nếu giảm/dưới mid tính theo Low
  const currentPriceAnchor = Math.abs(high0 - bb0.middle) >= Math.abs(low0 - bb0.middle) ? high0 : low0;
  const bbm = ((currentPriceAnchor - bb0.middle) / bb0.middle) * 100;

  // 3. Tính x: nến biến động lớn nhất trên 3 nến gần nhất / trung bình 10 nến trước đó
  const candleChanges = [0, 1, 2].map(i => {
    const o = parseFloat(raw5m[i][1]);
    const c = parseFloat(raw5m[i][4]);
    return {
      index: i,
      changePercent: ((c - o) / o) * 100,
      absChange: Math.abs(((c - o) / o) * 100)
    };
  });

  // Tìm nến biến động mạnh nhất (theo trị tuyệt đối)
  const maxCandle = candleChanges.reduce((max, curr) => curr.absChange > max.absChange ? curr : max, candleChanges[0]);
  
  // 10 nến trước nến đó
  const startIdx = maxCandle.index + 1;
  const prev10Changes = [];
  for (let i = startIdx; i < startIdx + 10; i++) {
    if (raw5m[i]) {
      const o = parseFloat(raw5m[i][1]);
      const c = parseFloat(raw5m[i][4]);
      prev10Changes.push(Math.abs(((c - o) / o) * 100));
    }
  }

  const avgPrev10Abs = prev10Changes.length > 0 
    ? prev10Changes.reduce((a, b) => a + b, 0) / prev10Changes.length 
    : 1;

  const x = avgPrev10Abs !== 0 ? (maxCandle.changePercent / avgPrev10Abs) : 0;

  return { bb15, bbm, x, Hbb, bb0 };
}

// ------------------- TIẾN TRÌNH CHÍNH -------------------
async function main() {
  try {
    console.log('--- BẮT ĐẦU QUÉT THỊ TRƯỜNG OKX ---');

    const sentLog = loadSentLog();
    const currentTime = Date.now();
    let hasNewAlert = false;

    // BƯỚC 1: Lấy UD và phân nhóm danh sách
    const { ud, longList, shortList } = await getFilteredMarkets();
    console.log(`📊 Chỉ số UD (Tăng - Giảm 24h): ${ud}`);
    console.log(`🟢 List Long (7% -> 15%): ${longList.length} coin`);
    console.log(`🔴 List Short (-15% -> -7%): ${shortList.length} coin`);

    const scanResults = {
      ud,
      totalScanned: longList.length + shortList.length,
      matched: []
    };

    // BƯỚC 2: Quét tín hiệu LONG
    if (ud > 0) {
      for (const coin of longList) {
        const raw5m = await getCandleData5m(coin.instId);
        if (!raw5m) {
          await sleep(80);
          continue;
        }

        const metrics = evaluateIndicators(raw5m);
        if (!metrics) continue;

        const { bb15, bbm, x, Hbb } = metrics;

        // Điều kiện Long: bb15 > 1, -2 < bbm < 0.5, x < 3, Hbb > 3
        if (bb15 > 1 && bbm > -2 && bbm < 0.5 && x < 3 && Hbb > 3) {
          const symbol = coin.instId;
          const coinName = symbol.replace('-USDT-SWAP', '');
          const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

          if (!sentLog[symbol]) sentLog[symbol] = {};
          const isCooldown = currentTime - (sentLog[symbol].longAlert || 0) < COOLDOWN_TIME;

          scanResults.matched.push({
            symbol,
            type: 'LONG',
            change24h: coin.change24h,
            Hbb: Hbb.toFixed(2) + '%',
            ud,
            x: x.toFixed(2),
            bb15: bb15.toFixed(2) + '%',
            teleSent: !isCooldown
          });

          if (!isCooldown) {
            // Nội dung theo thứ tự: Hbb + Hiệu số ud + x + bb15 + link okx
            const message = `🟢 <b>TÍN HIỆU LONG: ${coinName}</b>\n` +
              `• <b>Hbb:</b> ${Hbb.toFixed(2)}%\n` +
              `• <b>Hiệu số ud:</b> ${ud}\n` +
              `• <b>x:</b> ${x.toFixed(2)}\n` +
              `• <b>bb15:</b> ${bb15.toFixed(2)}%\n` +
              `• <a href="${link}">Link OKX</a>`;

            console.log(`🚀 [LONG] Gửi Telegram cho ${symbol}...`);
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
              chat_id: TELEGRAM_CHAT_ID,
              text: message,
              parse_mode: 'HTML',
              disable_web_page_preview: true
            }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

            sentLog[symbol].longAlert = currentTime;
            hasNewAlert = true;
          }
        }
        await sleep(80);
      }
    }

    // BƯỚC 3: Quét tín hiệu SHORT
    if (ud < -10) {
      for (const coin of shortList) {
        const raw5m = await getCandleData5m(coin.instId);
        if (!raw5m) {
          await sleep(80);
          continue;
        }

        const metrics = evaluateIndicators(raw5m);
        if (!metrics) continue;

        const { bb15, bbm, x, Hbb } = metrics;

        // Điều kiện Short: bb15 < -1, -0.5 < bbm < 2, x > -3, Hbb > 3
        if (bb15 < -1 && bbm > -0.5 && bbm < 2 && x > -3 && Hbb > 3) {
          const symbol = coin.instId;
          const coinName = symbol.replace('-USDT-SWAP', '');
          const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

          if (!sentLog[symbol]) sentLog[symbol] = {};
          const isCooldown = currentTime - (sentLog[symbol].shortAlert || 0) < COOLDOWN_TIME;

          scanResults.matched.push({
            symbol,
            type: 'SHORT',
            change24h: coin.change24h,
            Hbb: Hbb.toFixed(2) + '%',
            ud,
            x: x.toFixed(2),
            bb15: bb15.toFixed(2) + '%',
            teleSent: !isCooldown
          });

          if (!isCooldown) {
            // Nội dung theo thứ tự: Hbb + Hiệu số ud + x + bb15 + link okx
            const message = `🔴 <b>TÍN HIỆU SHORT: ${coinName}</b>\n` +
              `• <b>Hbb:</b> ${Hbb.toFixed(2)}%\n` +
              `• <b>Hiệu số ud:</b> ${ud}\n` +
              `• <b>x:</b> ${x.toFixed(2)}\n` +
              `• <b>bb15:</b> ${bb15.toFixed(2)}%\n` +
              `• <a href="${link}">Link OKX</a>`;

            console.log(`⚡ [SHORT] Gửi Telegram cho ${symbol}...`);
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
              chat_id: TELEGRAM_CHAT_ID,
              text: message,
              parse_mode: 'HTML',
              disable_web_page_preview: true
            }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

            sentLog[symbol].shortAlert = currentTime;
            hasNewAlert = true;
          }
        }
        await sleep(80);
      }
    }

    if (hasNewAlert) saveSentLog(sentLog);

    // BƯỚC 4: Ghi nhận kết quả
    saveScanResults(scanResults);

    console.log('\n================== KẾT QUẢ QUÉT ==================');
    console.log(`Chỉ số thị trường UD: ${scanResults.ud}`);
    console.log(`Số lượng tín hiệu thỏa mãn: ${scanResults.matched.length}`);
    if (scanResults.matched.length > 0) {
      console.table(scanResults.matched);
    }
    console.log(`📁 File kết quả đã lưu: ${RESULTS_FILE}`);
    console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---\n');

  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
