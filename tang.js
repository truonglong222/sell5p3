import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OKX_BASE_URL = 'https://www.okx.com';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_SHORT_FILE = path.join(__dirname, 'stateshort.json');
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

async function fetch3DayChange(coin, rawFuturesMap) {
    const symbol = coin.instId;
    try {
        const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${symbol}&bar=1D&limit=4`;
        const res = await axios.get(url, { timeout: 5000 });
        if (res.data && res.data.code === '0' && res.data.data.length > 0) {
            const candles = res.data.data;
            const lastPrice = parseFloat(rawFuturesMap[symbol]);
            const index3d = Math.min(3, candles.length - 1);
            const open3DaysAgo = parseFloat(candles[index3d][1]);
            const change3Days = open3DaysAgo ? ((lastPrice - open3DaysAgo) / open3DaysAgo) * 100 : 0;
            return { symbol, change3Days };
        }
    } catch (err) {}
    return null;
}

async function main() {
    console.log('--- ĐANG QUÉT DANH SÁCH COIN TĂNG (3 NGÀY) ---');
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
            fetch3DayChange(coin, rawFuturesMap)
        );

        const top40Gainers = results
            .filter(r => r !== null)
            .sort((a, b) => b.change3Days - a.change3Days)
            .slice(0, 40)
            .map(item => item.symbol);

        fs.writeFileSync(STATE_SHORT_FILE, JSON.stringify({ top40Gainers }, null, 2), 'utf8');
        console.log('✓ Đã lưu Top 40 Tăng 3 Ngày vào stateshort.json:', top40Gainers);
    } catch (error) {
        console.error('Lỗi tang.js:', error.message);
    }
}
main();
