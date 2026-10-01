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

// Cấu hình Cooldown: 2 tiếng
const COOLDOWN_TIME = 2 * 60 * 60 * 1000;
const MIN_VOL_CCY24H = 5_000_000; // Volume 24h > 5 triệu USDT

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
      ud4h: results.ud4h,
      targetCoinsCount: results.targetCoins.length,
      targetCoinsList: results.targetCoins,
      matchedCount: results.matched.length,
      matchedList: results.matched
    };
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(outputData, null, 2), 'utf8');
  } catch (e) {
    console.error('Lỗi khi lưu 24h.json:', e.message);
  }
}

// ------------------- HÀM TÍNH TOÁN KỸ THUẬT -------------------

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

function calculateEMAArray(prices, period = 20) {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const emaArray = [];

  let initialSma = 0;
  for (let i = 0; i < period; i++) {
    initialSma += prices[i];
  }
  let prevEma = initialSma / period;
  emaArray.push(prevEma);

  for (let i = period; i < prices.length; i++) {
    const currentEma = prices[i] * k + prevEma * (1 - k);
    emaArray.push(currentEma);
    prevEma = currentEma;
  }
  return emaArray;
}

// ------------------- LỌC THỊ TRƯỜNG (VOL > 5M & bd24h > 5%) -------------------

async function getFilteredMarkets() {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
    const res = await axios.get(url, { timeout: 10000 });
    if (!res.data || res.data.code !== '0') return { allSwapsCount: 0, volPassedCount: 0, filteredCoins: [] };

    const tickers = res.data.data.filter((item) => item.instId.endsWith('-USDT-SWAP'));
    const volFiltered = tickers.filter((item) => parseFloat(item.volCcy24h || 0) > MIN_VOL_CCY24H);

    const filteredCoins = [];
    for (const item of volFiltered) {
      const open24h = parseFloat(item.open24h || 0);
      const lastPrice = parseFloat(item.last || 0);
      if (open24h <= 0) continue;

      const change24hVal = ((lastPrice - open24h) / open24h) * 100;
      if (change24hVal > 5) {
        filteredCoins.push({
          instId: item.instId,
          open24h,
          last: lastPrice,
          change24hVal: parseFloat(change24hVal.toFixed(2))
        });
      }
    }

    return {
      allSwapsCount: tickers.length,
      volPassedCount: volFiltered.length,
      filteredCoins
    };
  } catch (error) {
    console.error('Lỗi khi lấy danh sách Tickers OKX:', error.message);
    return { allSwapsCount: 0, volPassedCount: 0, filteredCoins: [] };
  }
}

// ------------------- LẤY DỮ LIỆU NẾN -------------------

async function getCandles(symbol, bar = '5m', limit = 100) {
  try {
    const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 6000 });
    if (!res.data || res.data.code !== '0' || !Array.isArray(res.data.data)) return null;
    return res.data.data;
  } catch (error) {
    console.error(`Lỗi lấy dữ liệu nến ${bar} (${symbol}):`, error.message);
    return null;
  }
}

// ------------------- TIẾN TRÌNH CHÍNH -------------------

async function main() {
  try {
    console.log('--- BẮT ĐẦU QUÉT THỊ TRƯỜNG OKX ---');

    const sentLog = loadSentLog();
    const currentTime = Date.now();
    let hasNewAlert = false;

    const { allSwapsCount, volPassedCount, filteredCoins: targetCoins } = await getFilteredMarkets();
    console.log(
      `📊 Tổng USDT Swap: ${allSwapsCount} | Vol > 5M: ${volPassedCount} | Thỏa bd24h > 5%: ${targetCoins.length} coin`
    );

    // --- TÍNH CHỈ SỐ UD TOÀN TẬP COIN ĐÃ LỌC ---
    console.log(`⏳ Đang tải nến 4H tính chỉ số ud cho ${targetCoins.length} coin...`);
    let totalUp4hCoins = 0;
    let totalDown4hCoins = 0;

    for (const coin of targetCoins) {
      const candles4h = await getCandles(coin.instId, '4H', 2);
      if (candles4h && candles4h.length >= 2) {
        const closedCandle = candles4h[1];
        const openPrice = parseFloat(closedCandle[1]);
        const closePrice = parseFloat(closedCandle[4]);

        if (closePrice > openPrice) {
          totalUp4hCoins++;
        } else if (closePrice < openPrice) {
          totalDown4hCoins++;
        }
      }
      await sleep(60);
    }

    const marketUD = totalUp4hCoins - totalDown4hCoins;
    const marketUDStr = marketUD > 0 ? `+${marketUD}` : `${marketUD}`;
    console.log(`📈 Kết quả ud (4H): ${marketUDStr} (Tăng: ${totalUp4hCoins} | Giảm: ${totalDown4hCoins})\n`);

    const scanResults = {
      ud4h: marketUDStr,
      targetCoins,
      matched: []
    };

    let countValidCandles = 0;

    // Các biến đếm điều kiện độc lập
    let countBd24 = 0;
    let countDiffEma40 = 0;
    let countDiffEma20Long = 0;
    let countDiffEma20Short = 0;
    let countHbb = 0;
    let countBbdLong = 0;
    let countBbtShort = 0;
    let countDiffEma40_15mLong = 0;

    let countMatchedLong = 0;
    let countMatchedShort = 0;

    for (const coin of targetCoins) {
      const symbol = coin.instId;

      const candles5m = await getCandles(symbol, '5m', 100);
      if (!candles5m || candles5m.length < 65) {
        await sleep(80);
        continue;
      }
      countValidCandles++;

      const candle0 = candles5m[0];
      const high0 = parseFloat(candle0[2]);
      const low0 = parseFloat(candle0[3]);

      // --- 1. BOLLINGER BANDS (20) TRÊN NẾN 5m SỐ 1 VỪA ĐÓNG ---
      const closesBB5m = candles5m.slice(1, 21).map((c) => parseFloat(c[4])).reverse();
      const bb5m = calculateBollingerBands(closesBB5m, 20);

      if (!bb5m || bb5m.lower <= 0 || bb5m.upper <= 0 || bb5m.middle <= 0) {
        await sleep(80);
        continue;
      }

      const bbd = ((low0 - bb5m.lower) / bb5m.lower) * 100;
      const bbt = ((high0 - bb5m.upper) / bb5m.upper) * 100;
      const hbbPercent = ((bb5m.upper - bb5m.lower) / bb5m.middle) * 100;

      // --- 2. EMA20, diffema40 VÀ diffema20 TRÊN NẾN 5m ---
      const allClosedCandles = candles5m.slice(1).reverse();
      const closedPrices = allClosedCandles.map((c) => parseFloat(c[4]));
      const emaSeries5m = calculateEMAArray(closedPrices, 20);

      if (emaSeries5m.length < 40) {
        await sleep(80);
        continue;
      }

      const ema20_n1 = emaSeries5m[emaSeries5m.length - 1];
      const ema20_n20 = emaSeries5m[emaSeries5m.length - 20];
      const ema20_n40 = emaSeries5m[emaSeries5m.length - 40];

      if (!ema20_n40 || ema20_n40 <= 0 || !ema20_n20 || ema20_n20 <= 0) {
        await sleep(80);
        continue;
      }

      const diffema40 = ((ema20_n1 - ema20_n40) / ema20_n40) * 100;
      const diffema20 = ((ema20_n1 - ema20_n20) / ema20_n20) * 100;

      // Đánh giá các điều kiện cơ bản
      const passBd24 = coin.change24hVal > 5;
      const passDiffEma40 = diffema40 > 3;
      const passDiffEma20Long = diffema20 > 1;
      const passDiffEma20Short = diffema20 < 1;
      const passHbb = hbbPercent > 3;

      const passBbdLong = bbd < 0;
      const passBbtShort = bbt > 0;

      if (passBd24) countBd24++;
      if (passDiffEma40) countDiffEma40++;
      if (passDiffEma20Long) countDiffEma20Long++;
      if (passDiffEma20Short) countDiffEma20Short++;
      if (passHbb) countHbb++;
      if (passBbdLong) countBbdLong++;
      if (passBbtShort) countBbtShort++;

      // Tiền kiểm tra tín hiệu
      const passBaseLong = passBd24 && passDiffEma40 && passDiffEma20Long && passHbb && passBbdLong;
      const isShort = passBd24 && passDiffEma40 && passDiffEma20Short && passHbb && passBbtShort;

      let isLong = false;
      let diffema40_15mStr = 'N/A';

      // --- OPTIMIZATION: CHỈ TẢI NẾN 15m KHI THỎA ĐIỀU KIỆN LONG CƠ BẢN ---
      if (passBaseLong) {
        const candles15m = await getCandles(symbol, '15m', 100);
        if (candles15m && candles15m.length >= 65) {
          const closed15m = candles15m.slice(1).reverse();
          const closedPrices15m = closed15m.map((c) => parseFloat(c[4]));
          const emaSeries15m = calculateEMAArray(closedPrices15m, 20);

          if (emaSeries15m.length >= 40) {
            const ema20_15m_n1 = emaSeries15m[emaSeries15m.length - 1];
            const ema20_15m_n40 = emaSeries15m[emaSeries15m.length - 40];

            if (ema20_15m_n40 > 0) {
              const diffema40_15m = ((ema20_15m_n1 - ema20_15m_n40) / ema20_15m_n40) * 100;
              diffema40_15mStr = `${diffema40_15m > 0 ? '+' : ''}${diffema40_15m.toFixed(2)}%`;

              if (diffema40_15m > 4) {
                countDiffEma40_15mLong++;
                isLong = true;
              }
            }
          }
        }
      }

      if (!isLong && !isShort) {
        await sleep(80);
        continue;
      }

      const signalType = isLong ? 'LONG' : 'SHORT';
      const change24hStr = `${coin.change24hVal > 0 ? '+' : ''}${coin.change24hVal.toFixed(2)}%`;
      const diffema40Str = `${diffema40 > 0 ? '+' : ''}${diffema40.toFixed(2)}%`;
      const diffema20Str = `${diffema20 > 0 ? '+' : ''}${diffema20.toFixed(2)}%`;
      const hbbStr = `${hbbPercent.toFixed(2)}%`;

      if (isLong) countMatchedLong++;
      if (isShort) countMatchedShort++;

      const coinName = symbol.replace('-USDT-SWAP', '');
      const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

      if (!sentLog[symbol]) sentLog[symbol] = {};
      const alertKey = isLong ? 'longAlert' : 'shortAlert';
      const lastSentTime = sentLog[symbol][alertKey];
      const isCooldown = currentTime - (lastSentTime || 0) < COOLDOWN_TIME;

      const matchedItem = {
        symbol,
        type: signalType,
        Hbb: hbbStr,
        diffema40: diffema40Str,
        diffema20: diffema20Str,
        bd24h: change24hStr,
        link,
        teleSent: !isCooldown
      };

      if (isLong) {
        matchedItem.diffema40_15m = diffema40_15mStr;
      }

      scanResults.matched.push(matchedItem);

      if (!isCooldown) {
        const icon = isLong ? '🟢' : '🔴';
        let message =
          `<b>ud (4H): ${marketUDStr}</b>\n` +
          `${icon} <b>TÍN HIỆU ${signalType}: ${coinName}</b>\n` +
          `• <b>Hbb (5m):</b> ${hbbStr}\n` +
          `• <b>diffema40 (5m):</b> ${diffema40Str}\n`;

        if (isLong) {
          message += `• <b>diffema40 (15m):</b> ${diffema40_15mStr}\n`;
        }

        message +=
          `• <b>diffema20 (5m):</b> ${diffema20Str}\n` +
          `• <b>bd24h:</b> ${change24hStr}\n` +
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

        sentLog[symbol][alertKey] = currentTime;
        hasNewAlert = true;
      }

      await sleep(80);
    }

    if (hasNewAlert) saveSentLog(sentLog);
    saveScanResults(scanResults);

    // --- LOG BẰNG VĂN BẢN (TEXT LOG) ---
    console.log('\n================ THỐNG KÊ CHI TIẾT ================');
    console.log(`• Chỉ số ud (4H): ${marketUDStr}`);
    console.log(`• Nến 5m tải thành công: ${countValidCandles}/${targetCoins.length} coin\n`);

    console.log('--- SỐ LƯỢNG COIN THỎA ĐIỀU KIỆN ĐỘC LẬP ---');
    console.log(`• bd24h > 5%: ${countBd24} coin`);
    console.log(`• diffema40 (5m) > 3%: ${countDiffEma40} coin`);
    console.log(`• diffema20 (5m) > 1% (Long): ${countDiffEma20Long} coin`);
    console.log(`• diffema20 (5m) < 1% (Short): ${countDiffEma20Short} coin`);
    console.log(`• Hbb > 3%: ${countHbb} coin`);
    console.log(`• bbd < 0 (Chạm/Lủng Band Dưới): ${countBbdLong} coin`);
    console.log(`• bbt > 0 (Chạm/Lủng Band Trên): ${countBbtShort} coin`);
    console.log(`• diffema40 (15m) > 5% (Long): ${countDiffEma40_15mLong} coin\n`);

    console.log('--- KẾT QUẢ KHỚP TÍN HIỆU HOÀN CHỈNH ---');
    console.log(`• KHỚP TẤT CẢ LONG: ${countMatchedLong} coin`);
    console.log(`• KHỚP TẤT CẢ SHORT: ${countMatchedShort} coin`);
    console.log('===================================================\n');

    if (scanResults.matched.length > 0) {
      console.log('--- DANH SÁCH COIN KHỚP TÍN HIỆU ---');
      scanResults.matched.forEach((item, index) => {
        const status = item.teleSent ? 'Đã gửi Tele' : 'Đang Cooldown';
        const extra15m = item.diffema40_15m ? ` | diffema40(15m): ${item.diffema40_15m}` : '';
        console.log(
          `${index + 1}. [${item.type}] ${item.symbol} | Hbb: ${item.Hbb} | diffema40(5m): ${item.diffema40}${extra15m} | diffema20(5m): ${item.diffema20} | bd24h: ${item.bd24h} | ${status}`
        );
      });
      console.log('');
    } else {
      console.log('❌ Không có coin nào thỏa mãn tất cả tiêu chí.\n');
    }

    console.log(`📁 File kết quả đã lưu: ${RESULTS_FILE}`);
    console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---\n');
  } catch (err) {
    console.error('Lỗi hệ thống trong main():', err.message);
  }
}

main();
