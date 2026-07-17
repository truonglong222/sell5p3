import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OKX_BASE_URL = 'https://www.okx.com';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_LONG_FILE = path.join(__dirname, 'statelong.json');
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
        if (executing.size >= limit) await Promise.race(executing);
    }
    return Promise.all(ret);
}

async function fetch5DayChange(coin, rawFuturesMap) {
    const symbol = coin.instId;
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1D&limit=6`;
        const res = await axios.get(url, { timeout: 5000 });
        if (res.data && res.data.code === '0' && res.data.data.length > 0) {
            const candles = res.data.data;
            const lastPrice = parseFloat(rawFuturesMap[symbol]);
            const index5d = Math.min(5, candles.length - 1);
            const close5DaysAgo = parseFloat(candles[index5d][4]);
            const change5Days = close5DaysAgo ? ((lastPrice - close5DaysAgo) / close5DaysAgo) * 100 : 0;
            return { symbol, change5Days };
        }
    } catch (err) {}
    return null;
}

async function main() {
    console.log('--- ĐANG QUÉT DANH SÁCH COIN GIẢM (5 NGÀY) ---');
    try {
        const tickersUrl = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SWAP`;
        const response = await axios.get(tickersUrl);
        if (!response.data || response.data.code !== '0') return;

        const rawFutures = response.data.data.filter(t => 
            t.instId.endsWith('-USDT-SWAP') && parseFloat(t.vol24h) >= 2000000
        );

        const rawFuturesMap = {};
        rawFutures.forEach(t => { rawFuturesMap[t.instId] = t.last; });

        const results = await asyncPool(MAX_CONCURRENT_REQUESTS, rawFutures, (coin) => 
            fetch5DayChange(coin, rawFuturesMap)
        );

        const top20Losers = results
            .filter(r => r !== null)
            .sort((a, b) => a.change5Days - b.change5Days)
            .slice(0, 20)
            .map(item => item.symbol);

        fs.writeFileSync(STATE_LONG_FILE, JSON.stringify({ top20Losers }, null, 2), 'utf8');
        console.log('✓ Đã lưu Top 20 Giảm 5 Ngày vào statelong.json:', top20Losers);
    } catch (error) {
        console.error('Lỗi giam.js:', error.message);
    }
}
main();
