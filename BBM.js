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

// Cấu hình Cooldown: 2 TIẾNG
const COOLDOWN_TIME = 2 * 60 * 60 * 1000;
const MIN_VOLUME_USDT = 5000000; // 5 Triệu USDT

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
      if (timeData._short15m && now - timeData._short15m < COOLDOWN_TIME) {
        temp._short15m = timeData._short15m;
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

// ------------------- LẤY DANH SÁCH COIN VOLUME > 5M USDT -------------------
async function getHighVolumeCoins() {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') return [];

    const tickers = res.data.data;
    return tickers.filter(item => {
      if (!item.instId.endsWith('-USDT-SWAP')) return false;
      const volCcy = parseFloat(item.volCcy24h || 0);
      return volCcy >= MIN_VOLUME_USDT;
    }).map(item => ({
      instId: item.instId,
      volCcy24h: parseFloat(item.volCcy24h || 0)
    }));
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return [];
  }
}

// ------------------- LẤY DỮ LIỆU NẾN 15M -------------------
async function getCandleData(symbol) {
  try {
    // Lấy nến 15m (bar=15m)
    const url15M = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=15m&limit=40`;
    const res15M = await axios.get(url15M, { timeout: 5000 });

    if (!res15M.data || res15M.data.code !== '0' || res15M.data.data.length < 20) return null;

    return res15M.data.data;
  } catch (error) {
    console.error(`Lỗi lấy dữ liệu nến (${symbol}):`, error.message);
    return null;
  }
}

// ------------------- KIỂM TRA ĐIỀU KIỆN SHORT 15M -------------------
function checkShortSignal(raw15M) {
  if (!raw15M || raw15M.length < 20) return null;

  // Nến hiện tại raw15M[0]: [ts, open, high, low, close, ...]
  const candle0 = raw15M[0];
  const openPrice0 = parseFloat(candle0[1]); // Giá mở cửa nến 15m hiện tại

  // Tính BB(20) bao gồm cả nến hiện tại (từ index 0 đến 19)
  const closePrices = raw15M.slice(0, 20).reverse().map(c => parseFloat(c[4]));
  const bb15m = calculateBollingerBands(closePrices, 20);

  if (!bb15m || bb15m.upper === 0) return null;

  // Độ lệch giữa giá mở nến hiện tại và BB Upper
  const diffbbu15m = ((openPrice0 - bb15m.upper) / bb15m.upper) * 100;

  if (diffbbu15m > 0.5) {
    return {
      diffbbu15m,
      openPrice0,
      upperBB: bb15m.upper
    };
  }

  return null;
}

// ------------------- HÀM CHÍNH -------------------
async function main() {
  try {
    console.log('--- BẮT ĐẦU TIẾN TRÌNH QUÉT THỊ TRƯỜNG SHORT (15M) ---');

    const sentLog = loadSentLog();
    const currentTime = Date.now();
    let hasNewAlert = false;

    const scanResults = {
      totalScanned: 0,
      matched: []
    };

    // BƯỚC 1: Lấy coin có Volume > 5M USDT
    const highVolCoins = await getHighVolumeCoins();
    scanResults.totalScanned = highVolCoins.length;
    console.log(`📋 Tìm thấy ${highVolCoins.length} coins có Vol 24h > 5M USDT...`);

    // BƯỚC 2: Quét điều kiện Short 15m
    for (const coin of highVolCoins) {
      const raw15M = await getCandleData(coin.instId);
      if (!raw15M) {
        await sleep(80);
        continue;
      }

      const sig = checkShortSignal(raw15M);
      if (sig) {
        const symbol = coin.instId;
        const isCooldown = sentLog[symbol]?._short15m && (currentTime - sentLog[symbol]._short15m < COOLDOWN_TIME);

        scanResults.matched.push({
          symbol,
          volCcy24h: coin.volCcy24h,
          diffbbu15m: sig.diffbbu15m,
          teleSent: !isCooldown
        });

        if (!sentLog[symbol]) sentLog[symbol] = {};
        const lastSent = sentLog[symbol]._short15m || 0;

        if (currentTime - lastSent >= COOLDOWN_TIME) {
          const coinName = symbol.replace('-USDT-SWAP', '');
          const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

          // Tin nhắn ngắn gọn theo yêu cầu
          const message = `🔴 <b>${coinName} SHORT</b>\n` +
            `• DiffBBu15m: <b>+${sig.diffbbu15m.toFixed(2)}%</b>\n` +
            `• <a href="${link}">Trade trên OKX</a>`;

          console.log(`🚀 [SHORT MATCHED] Gửi Telegram cho ${symbol}...`);
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

          sentLog[symbol]._short15m = currentTime;
          hasNewAlert = true;
        }
      }

      await sleep(80);
    }

    if (hasNewAlert) saveSentLog(sentLog);

    // BƯỚC 3: Lưu kết quả
    saveScanResults(scanResults);

    console.log('\n================== KẾT QUẢ QUÉT ==================');
    console.log(`Tổng số coin đã quét: ${scanResults.totalScanned}`);
    console.log(`Số tín hiệu thỏa điều kiện: ${scanResults.matched.length}`);
    if (scanResults.matched.length > 0) {
      console.table(scanResults.matched.map(item => ({
        'Symbol': item.symbol,
        'Vol 24h ($M)': (item.volCcy24h / 1_000_000).toFixed(2) + 'M',
        'DiffBBu15m (%)': item.diffbbu15m.toFixed(2) + '%',
        'Đã gửi Tele': item.teleSent ? 'Có' : 'Bỏ qua (Cooldown)'
      })));
    }
    console.log(`📁 File kết quả đã lưu: ${RESULTS_FILE}`);
    console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---\n');

  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
