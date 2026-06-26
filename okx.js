import axios from "axios";

// Lấy toàn bộ Future-USDT
export async function getAllUSDTFutures() {
  const url = "https://www.okx.com/api/v5/market/tickers?instType=SWAP";
  const res = await axios.get(url);

  return res.data.data
    .filter(i => i.instId.includes("-USDT-SWAP"))
    .map(i => ({
      instId: i.instId,
      last: parseFloat(i.last),
      open24h: parseFloat(i.open24h),
      volCcy24h: parseFloat(i.volCcy24h || 0),
    }));
}

// Lấy candles để tính EMA20
export async function getEMA20(instId) {
  const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=1H&limit=50`;
  const res = await axios.get(url);

  const closes = res.data.data
    .map(c => parseFloat(c[4]))
    .reverse();

  return calcEMA(closes, 20);
}

// EMA helper
function calcEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data[0];

  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }

  return ema;
}

// % giảm 24h
export function getChange24h(coin) {
  return ((coin.last - coin.open24h) / coin.open24h) * 100;
}
