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
      if (timeData._short1h && now - timeData._short1h < COOLDOWN_TIME) {
        temp._short1h = timeData._short1h;
      }
      if (Object.keys(temp).length > 0) cleanedLog[coin] = temp;
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(cleanedLog, null, 2), 'utf8');
  } catch (e) {}
}

// ------------------- HÀM LƯU KẾT QUẢ QUÉT VÀO FILE 24H.JSON -------------------
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

// ------------------- LẤY DỮ LIỆU NẾN 1H -------------------
async function getCandleData(symbol) {
  try {
    const url1H = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1H&limit=60`;
    const res1H = await axios.get(url1H, { timeout: 5000 });

    if (!res1H.data || res1H.data.code !== '0' || res1H.data.data.length < 30) return null;

    return res1H.data.data;
  } catch (error) {
    console.error(`Lỗi lấy dữ liệu nến (${symbol}):`, error.message);
    return null;
  }
}

// ------------------- KIỂM TRA ĐIỀU KIỆN SHORT MỚI -------------------
function checkShortSignal(raw1H) {
  if (!raw1H || raw1H.length < 25) return null;

  const candle0 = raw1H[0];
  const highPrice0 = parseFloat(candle0[2]); // High của nến hiện tại

  // 1. BB của nến vừa đóng (raw1H[1] -> raw1H[20])
  const closedForBB1 = raw1H.slice(1, 21).reverse().map(c => parseFloat(c[4]));
  const bb1 = calculateBollingerBands(closedForBB1, 20);

  // 2. BB của nến hiện tại (raw1H[0] -> raw1H[19])
  const closedForBB0 = raw1H.slice(0, 20).reverse().map(c => parseFloat(c[4]));
  const bb0 = calculateBollingerBands(closedForBB0, 20);

  // 3. BB của nến số 4 (raw1H[4] -> raw1H[23])
  const closedForBB4 = raw1H.slice(4, 24).reverse().map(c => parseFloat(c[4]));
  const bb4 = calculateBollingerBands(closedForBB4, 20);

  if (!bb1 || !bb0 || !bb4 || bb1.upper === 0 || bb4.upper === 0) return null;

  // Tính Hbb từ BB nến vừa đóng
  const hBB = ((bb1.upper - bb1.lower) / bb1.upper) * 100;

  // Điều kiện 1: diffbbu1h (-0.5% < diffbbu < 2%)
  const diffbbu1h = ((highPrice0 - bb1.upper) / bb1.upper) * 100;
  const isMatchDiffBBu1h = diffbbu1h > -0.5 && diffbbu1h < 2;

  // Điều kiện 2: diffbbu4 < -1%
  const diffbbu4 = ((bb0.upper - bb4.upper) / bb4.upper) * 100;
  const isMatchDiffBBu4 = diffbbu4 < -1;

  if (isMatchDiffBBu1h && isMatchDiffBBu4) {
    return {
      diffbbu1h,
      diffbbu4,
      hBB
    };
  }

  return null;
}

// ------------------- HÀM CHÍNH -------------------
async function main() {
  try {
    console.log('--- BẮT ĐẦU TIẾN TRÌNH QUÉT THỊ TRƯỜNG SHORT ---');

    const sentLog = loadSentLog();
    const currentTime = Date.now();
    let hasNewAlert = false;

    // Danh sách lưu kết quả phiên quét
    const scanResults = {
      totalScanned: 0,
      matched: []
    };

    // BƯỚC 1: Lấy coin có Volume > 5M USDT
    const highVolCoins = await getHighVolumeCoins();
    scanResults.totalScanned = highVolCoins.length;
    console.log(`📋 Tìm thấy ${highVolCoins.length} coins có Vol 24h > 5M USDT...`);

    // BƯỚC 2: Quét điều kiện Short
    for (const coin of highVolCoins) {
      const raw1H = await getCandleData(coin.instId);
      if (!raw1H) {
        await sleep(80);
        continue;
      }

      const sig = checkShortSignal(raw1H);
      if (sig) {
        const symbol = coin.instId;
        const isCooldown = sentLog[symbol]?._short1h && (currentTime - sentLog[symbol]._short1h < COOLDOWN_TIME);

        // Lưu thông tin kết quả khớp
        scanResults.matched.push({
          symbol,
          volCcy24h: coin.volCcy24h,
          diffbbu4: sig.diffbbu4,
          diffbbu1h: sig.diffbbu1h,
          hBB: sig.hBB,
          teleSent: !isCooldown
        });

        if (!sentLog[symbol]) sentLog[symbol] = {};
        const lastSent = sentLog[symbol]._short1h || 0;

        if (currentTime - lastSent >= COOLDOWN_TIME) {
          const coinName = symbol.replace('-USDT-SWAP', '');
          const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

          const message = `🔴 <b>${coinName} (SHORT)</b>\n` +
            `• DiffBBu4: <b>${sig.diffbbu4.toFixed(2)}%</b>\n` +
            `• DiffBBu1h: <b>${sig.diffbbu1h.toFixed(2)}%</b>\n` +
            `• Hbb (BB Width): <b>${sig.hBB.toFixed(2)}%</b>\n` +
            `• Vol 24h: <b>$${(coin.volCcy24h / 1_000_000).toFixed(2)}M</b>\n` +
            `• <a href="${link}">Trade trên OKX</a>`;

          console.log(`🚀 [SHORT MATCHED] Gửi Telegram cho ${symbol}...`);
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

          sentLog[symbol]._short1h = currentTime;
          hasNewAlert = true;
        }
      }

      await sleep(80);
    }

    if (hasNewAlert) saveSentLog(sentLog);

    // BƯỚC 3: Lưu vào file 24h.json và in kết quả ra console
    saveScanResults(scanResults);

    console.log('\n================== KẾT QUẢ QUÉT ==================');
    console.log(`Tổng số coin đã quét: ${scanResults.totalScanned}`);
    console.log(`Số tín hiệu thỏa điều kiện: ${scanResults.matched.length}`);
    if (scanResults.matched.length > 0) {
      console.table(scanResults.matched.map(item => ({
        'Symbol': item.symbol,
        'Vol 24h ($M)': (item.volCcy24h / 1_000_000).toFixed(2) + 'M',
        'DiffBBu4 (%)': item.diffbbu4.toFixed(2) + '%',
        'DiffBBu1h (%)': item.diffbbu1h.toFixed(2) + '%',
        'Hbb (%)': item.hBB.toFixed(2) + '%',
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
