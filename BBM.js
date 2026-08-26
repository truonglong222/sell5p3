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

// Cấu hình Cooldown: 8 TIẾNG dùng chung
const COOLDOWN_TIME = 8 * 60 * 60 * 1000;
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
    for (const [coin, lastSent] of Object.entries(logData)) {
      if (typeof lastSent === 'number' && now - lastSent < COOLDOWN_TIME) {
        cleanedLog[coin] = lastSent;
      }
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
  } catch (e) {}
}

function saveScanResults(results) {
  try {
    const outputData = {
      lastScanAt: new Date().toISOString(),
      totalScanned: results.totalScanned,
      matchedCount: results.matched.length,
      matchedList: results.matched
    };
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(outputData, null, 2), 'utf8');
  } catch (e) {
    console.error('Lỗi khi lưu kết quả scan:', e.message);
  }
}

// ------------------- HÀM TÍNH EMA -------------------
// prices: mảng giá theo thứ tự thời gian từ cũ -> mới
function calculateEMA(prices, period = 20) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

// ------------------- HÀM TÍNH BOLLINGER BANDS -------------------
// prices: mảng giá đóng cửa (tối thiểu `period` nến)
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

// ------------------- BƯỚC 1: LỌC THỊ TRƯỜNG THEO VOL VÀ BIẾN ĐỘNG 24H -------------------
async function getFilteredMarkets() {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') return [];

    const tickers = res.data.data;
    return tickers
      .filter((item) => item.instId.endsWith('-USDT-SWAP'))
      .map((item) => {
        const last = parseFloat(item.last || 0);
        const open24h = parseFloat(item.open24h || 0);
        const change24h = open24h > 0 ? ((last - open24h) / open24h) * 100 : 0;
        return {
          instId: item.instId,
          lastPrice: last,
          change24h: change24h,
          volCcy24h: parseFloat(item.volCcy24h || 0)
        };
      })
      .filter((c) => c.volCcy24h > MIN_VOL_CCY24H && c.change24h >= -5 && c.change24h <= 5);
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return [];
  }
}

// ------------------- LẤY DỮ LIỆU NẾN -------------------
async function getCandles(symbol, bar = '1h', limit = 60) {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 5000 });
    if (!res.data || res.data.code !== '0' || res.data.data.length < limit) return null;
    return res.data.data;
  } catch (error) {
    console.error(`Lỗi lấy dữ liệu nến ${bar} (${symbol}):`, error.message);
    return null;
  }
}

// ------------------- TÍNH DIFFEMA10 (NẾN 4H) -------------------
function calculateDiffEma10(raw4h) {
  // raw4h trả về từ mới nhất (index 0) đến cũ nhất (index N)
  // pricesChronological: mảng giá đóng cửa từ cũ -> mới
  const closes = raw4h.map((c) => parseFloat(c[4]));
  const pricesChronological = closes.slice().reverse();

  // Tính EMA(20) tại nến hiện tại
  const emaCurrent = calculateEMA(pricesChronological, 20);

  // Tính EMA(20) cách đây 10 nến
  const pricesAgo10 = pricesChronological.slice(0, pricesChronological.length - 10);
  const emaAgo10 = calculateEMA(pricesAgo10, 20);

  if (!emaCurrent || !emaAgo10) return null;

  const diffema10 = ((emaCurrent - emaAgo10) / emaAgo10) * 100;
  return diffema10;
}

// ------------------- TÍNH CÁC CHỈ SỐ BOLLINGER BANDS NẾN 1H -------------------
function evaluate1hCandle(raw1h) {
  // raw1h[0] là nến đang chạy, raw1h[1] là nến 1h vừa đóng
  const closedCandle = raw1h[1];
  const open1h = parseFloat(closedCandle[1]);
  const close1h = parseFloat(closedCandle[4]);

  // Lấy chuỗi giá đóng cửa kết thúc tại nến index 1 (từ index 1 đến 20) để tính BB nến vừa đóng
  const closesForBB = raw1h.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
  const bb = calculateBollingerBands(closesForBB, 20);
  if (!bb) return null;

  // Hbb: độ rộng dải band trên và dưới
  const Hbb = ((bb.upper - bb.lower) / bb.lower) * 100;

  // bbd1h: chênh lệch % giá đóng cửa và Bollinger band dưới
  const bbd1h = ((close1h - bb.lower) / bb.lower) * 100;

  // bbt1h: chênh lệch % giá đóng cửa và Bollinger band trên
  const bbt1h = ((close1h - bb.upper) / bb.upper) * 100;

  // % tăng giảm của nến 1h vừa đóng
  const candleChange = open1h > 0 ? ((close1h - open1h) / open1h) * 100 : 0;

  return {
    Hbb,
    bbd1h,
    bbt1h,
    close1h,
    candleChange,
    upper: bb.upper,
    lower: bb.lower
  };
}

// ------------------- TIẾN TRÌNH CHÍNH -------------------
async function main() {
  try {
    console.log('--- BẮT ĐẦU QUÉT THỊ TRƯỜNG OKX ---');

    const sentLog = loadSentLog();
    const currentTime = Date.now();
    let hasNewAlert = false;

    // 1. Lọc thị trường: Vol > 5M và -5% <= 24h Change <= 5%
    const qualifiedMarkets = await getFilteredMarkets();
    console.log(`🔍 Tìm thấy ${qualifiedMarkets.length} coin thỏa điều kiện Volume & Biến động 24h [-5%, +5%]`);

    const scanResults = {
      totalScanned: qualifiedMarkets.length,
      matched: []
    };

    for (const coin of qualifiedMarkets) {
      const symbol = coin.instId;

      // 2. Lấy nến 4H để tính diffema10
      const raw4h = await getCandles(symbol, '4H', 40);
      if (!raw4h) {
        await sleep(80);
        continue;
      }

      const diffema10 = calculateDiffEma10(raw4h);
      if (diffema10 === null || diffema10 < -2 || diffema10 > 2) {
        await sleep(80);
        continue;
      }

      // 3. Lấy nến 1H để tính BB và các nhóm tín hiệu
      const raw1h = await getCandles(symbol, '1H', 40);
      if (!raw1h) {
        await sleep(80);
        continue;
      }

      const bb1h = evaluate1hCandle(raw1h);
      if (!bb1h || bb1h.Hbb <= 3) {
        await sleep(80);
        continue;
      }

      const { Hbb, bbd1h, bbt1h, close1h, candleChange, upper, lower } = bb1h;

      let signalType = null;
      let groupName = '';

      // 4. Phân nhóm điều kiện
      // Nhóm A1: Nến 1h vừa đóng tăng > 0.4*Hbb và Close < Upper
      if (candleChange > 0.4 * Hbb && close1h < upper) {
        signalType = 'LONG';
        groupName = 'Nhóm A1 (Tăng mạnh dưới Band Trên)';
      }
      // Nhóm A2: Nến 1h vừa đóng giảm < -0.4*Hbb và Close > Lower
      else if (candleChange < -0.4 * Hbb && close1h > lower) {
        signalType = 'SHORT';
        groupName = 'Nhóm A2 (Giảm mạnh trên Band Dưới)';
      }
      // Nhóm B1 (Long): Không thuộc A1/A2 và -3% < bbd1h < -0.5%
      else if (bbd1h > -3 && bbd1h < -0.5) {
        signalType = 'LONG';
        groupName = 'Nhóm B1 (Chạm/Lệch Band Dưới)';
      }
      // Nhóm B2 (Short): Không thuộc A1/A2 và 0.5% < bbt1h < 3%
      else if (bbt1h > 0.5 && bbt1h < 3) {
        signalType = 'SHORT';
        groupName = 'Nhóm B2 (Chạm/Lệch Band Trên)';
      }

      if (signalType) {
        const coinName = symbol.replace('-USDT-SWAP', '');
        const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;
        const lastSentTime = sentLog[symbol] || 0;
        const isCooldown = currentTime - lastSentTime < COOLDOWN_TIME;

        scanResults.matched.push({
          symbol,
          type: signalType,
          group: groupName,
          Hbb: Hbb.toFixed(2) + '%',
          diffema10: diffema10.toFixed(2) + '%',
          bbMetric: signalType === 'LONG' ? bbd1h.toFixed(2) + '%' : bbt1h.toFixed(2) + '%',
          change24h: coin.change24h.toFixed(2) + '%',
          teleSent: !isCooldown
        });

        if (!isCooldown) {
          const isLong = signalType === 'LONG';
          const icon = isLong ? '🟢' : '🔴';
          const bbText = isLong
            ? `• <b>bbd1h:</b> ${bbd1h.toFixed(2)}%`
            : `• <b>bbt1h:</b> ${bbt1h.toFixed(2)}%`;

          // Gửi tin Telegram theo thứ tự: Hbb -> diffema10 -> bbd1h/bbt1h -> % 24h -> Link OKX
          const message =
            `${icon} <b>TÍN HIỆU ${signalType}: ${coinName}</b>\n` +
            `<i>Phân loại: ${groupName}</i>\n\n` +
            `• <b>Hbb:</b> ${Hbb.toFixed(2)}%\n` +
            `• <b>diffema10 (4H):</b> ${diffema10.toFixed(2)}%\n` +
            `${bbText}\n` +
            `• <b>Biến động 24h:</b> ${coin.change24h > 0 ? '+' : ''}${coin.change24h.toFixed(2)}%\n` +
            `• <a href="${link}">Link OKX</a>`;

          console.log(`🚀 [${signalType}] Gửi Telegram cho ${symbol}...`);
          await axios
            .post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
              chat_id: TELEGRAM_CHAT_ID,
              text: message,
              parse_mode: 'HTML',
              disable_web_page_preview: true
            })
            .catch((err) => console.error('Lỗi gửi Telegram:', err.message));

          sentLog[symbol] = currentTime;
          hasNewAlert = true;
        }
      }

      await sleep(80);
    }

    if (hasNewAlert) saveSentLog(sentLog);

    saveScanResults(scanResults);

    console.log('\n================== KẾT QUẢ QUÉT ==================');
    console.log(`Số coin thỏa mãn tín hiệu: ${scanResults.matched.length}`);
    if (scanResults.matched.length > 0) {
      console.table(scanResults.matched);
    }
    console.log(`📁 Kết quả lưu tại: ${RESULTS_FILE}`);
    console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---\n');
  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
