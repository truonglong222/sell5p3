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

// ------------------- LỌC VOLUME TRƯỚC -> TÍNH UD -> PHÂN LIST -------------------
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

    // 1. LỌC VOLUME TRƯỚC (> 5 triệu USDT)
    const volFiltered = swapTickers.filter(c => c.volCcy24h > MIN_VOL_CCY24H);

    // 2. TÍNH HIỆU SỐ UD TRÊN DANH SÁCH ĐÃ LỌC VOLUME
    const upCount = volFiltered.filter(c => c.change24h > 0).length;
    const downCount = volFiltered.filter(c => c.change24h < 0).length;
    const ud = upCount - downCount;

    // 3. PHÂN LOẠI LIST LONG VÀ LIST SHORT TỪ DANH SÁCH ĐÃ LỌC VOLUME
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
    const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=5m&limit=60`;
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
  const closes = raw5m.map(c => parseFloat(c[4]));
  const currentCandle = raw5m[0];
  const close0 = parseFloat(currentCandle[4]);
  const high0 = parseFloat(currentCandle[2]);
  const low0 = parseFloat(currentCandle[3]);

  const closes0 = closes.slice(0, 20).reverse();
  const bb0 = calculateBollingerBands(closes0, 20);

  const closes15 = closes.slice(15, 35).reverse();
  const bb15_val = calculateBollingerBands(closes15, 20);

  if (!bb0 || !bb15_val) return null;

  const bb15 = ((bb0.middle - bb15_val.middle) / bb15_val.middle) * 100;
  const Hbb = ((bb0.upper - bb0.lower) / bb0.lower) * 100;

  const currentPriceAnchor = Math.abs(high0 - bb0.middle) >= Math.abs(low0 - bb0.middle) ? high0 : low0;
  const bbm = ((currentPriceAnchor - bb0.middle) / bb0.middle) * 100;

  const candleChanges = [0, 1, 2].map(i => {
    const o = parseFloat(raw5m[i][1]);
    const c = parseFloat(raw5m[i][4]);
    return {
      index: i,
      changePercent: ((c - o) / o) * 100,
      absChange: Math.abs(((c - o) / o) * 100)
    };
  });

  const maxCandle = candleChanges.reduce((max, curr) => curr.absChange > max.absChange ? curr : max, candleChanges[0]);
  
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

  // Xét biên độ trong 30 nến gần nhất
  const candles30 = raw5m.slice(0, 30);
  const maxHigh30 = Math.max(...candles30.map(c => parseFloat(c[2])));
  const minLow30 = Math.min(...candles30.map(c => parseFloat(c[3])));
  
  const diffHigh30 = maxHigh30 > 0 ? ((close0 - maxHigh30) / maxHigh30) * 100 : 0;
  const diffLow30 = minLow30 > 0 ? ((close0 - minLow30) / minLow30) * 100 : 0;

  return { bb15, bbm, x, Hbb, diffHigh30, diffLow30 };
}

// ------------------- TIẾN TRÌNH CHÍNH -------------------
async function main() {
  try {
    console.log('--- BẮT ĐẦU QUÉT THỊ TRƯỜNG OKX ---');

    const sentLog = loadSentLog();
    const currentTime = Date.now();
    let hasNewAlert = false;

    // BƯỚC 1: Lọc volume trước -> tính UD -> lấy danh sách coin thỏa mãn 24h
    const { ud, longList, shortList } = await getFilteredMarkets();
    const totalLongSatisfied = longList.length;
    const totalShortSatisfied = shortList.length;

    console.log(`📊 Chỉ số UD (tính trên tập Vol > 5M): ${ud}`);
    console.log(`🟢 Số coin thỏa điều kiện List Long (7% -> 15%): ${totalLongSatisfied}`);
    console.log(`🔴 Số coin thỏa điều kiện List Short (-15% -> -7%): ${totalShortSatisfied}`);

    const scanResults = {
      ud,
      totalScanned: totalLongSatisfied + totalShortSatisfied,
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

        const { bb15, bbm, x, Hbb, diffLow30 } = metrics;

        // Điều kiện Long: bb15 > 1, -2 < bbm < 0.5, x < -3, Hbb > 3, diffLow30 < 5
        if (bb15 > 1 && bbm > -2 && bbm < 0.5 && x < -3 && Hbb > 3 && diffLow30 < 5) {
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
            diffLow30: diffLow30.toFixed(2) + '%',
            teleSent: !isCooldown
          });

          if (!isCooldown) {
            const message = `🟢 <b>TÍN HIỆU LONG: ${coinName}</b>\n` +
              `• <b>Hbb:</b> ${Hbb.toFixed(2)}%\n` +
              `• <b>Hiệu số ud:</b> ${ud}\n` +
              `• <b>x:</b> ${x.toFixed(2)}\n` +
              `• <b>bb15:</b> ${bb15.toFixed(2)}%\n` +
              `• <b>diffLow30:</b> ${diffLow30.toFixed(2)}%\n` +
              `• <b>Biến động 24h:</b> +${coin.change24h.toFixed(2)}%\n` +
              `• <b>Tổng coin thỏa List Long:</b> ${totalLongSatisfied}\n` +
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

        const { bb15, bbm, x, Hbb, diffHigh30 } = metrics;

        // Điều kiện Short: bb15 < -1, -0.5 < bbm < 2, x < 3, Hbb > 3, diffHigh30 > -4
        if (bb15 < -1 && bbm > -0.5 && bbm < 2 && x < 3 && Hbb > 3 && diffHigh30 > -4) {
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
            diffHigh30: diffHigh30.toFixed(2) + '%',
            teleSent: !isCooldown
          });

          if (!isCooldown) {
            const message = `🔴 <b>TÍN HIỆU SHORT: ${coinName}</b>\n` +
              `• <b>Hbb:</b> ${Hbb.toFixed(2)}%\n` +
              `• <b>Hiệu số ud:</b> ${ud}\n` +
              `• <b>x:</b> ${x.toFixed(2)}\n` +
              `• <b>bb15:</b> ${bb15.toFixed(2)}%\n` +
              `• <b>diffHigh30:</b> ${diffHigh30.toFixed(2)}%\n` +
              `• <b>Biến động 24h:</b> ${coin.change24h.toFixed(2)}%\n` +
              `• <b>Tổng coin thỏa List Short:</b> ${totalShortSatisfied}\n` +
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
    console.log(`Chỉ số thị trường UD (Vol > 5M): ${scanResults.ud}`);
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
