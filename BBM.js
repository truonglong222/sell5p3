// ------------------- HÀM CHÍNH -------------------
async function main() {
    try {
        console.log('--- BẮT ĐẦU TIẾN TRÌNH QUÉT THỊ TRƯỜNG (NHÓM A SHORT) ---');

        const sentLog = loadSentLog();
        const currentTime = Date.now();
        let hasNewAlert = false;

        // Bộ đếm thống kê qua từng bước lọc
        const stats = {
            step1_volume5M: 0,
            step2_validEma: 0,
            step3_groupA_diffEma: 0,     // -8% < diffEMA < -3%
            step4_groupA_signalBB: 0,    // -0.5% < diffbbu < 2%
            step5_groupA_diffbbl1d: 0,   // diffbbl1d > 2%
            step6_passedCooldown: 0      // Vượt qua thời gian chờ & gửi Telegram
        };

        // BƯỚC 1: Lấy các coin có Volume > 5M USDT
        const highVolCoins = await getHighVolumeCoins();
        stats.step1_volume5M = highVolCoins.length;
        console.log(`📋 [Bước 1] Tìm thấy ${stats.step1_volume5M} coins có Vol 24h >= 5M USDT...`);

        // BƯỚC 2: Tính diffEMA cho tất cả coin vừa lọc được
        console.log('⏳ [Bước 2] Đang tính diffEMA cho các coin...');
        const calculatedCoins = [];

        for (const coin of highVolCoins) {
            const data = await getCoinDataWithDiffEma(coin.instId, coin.volCcy24h);
            if (data) calculatedCoins.push(data);
            await sleep(80);
        }
        stats.step2_validEma = calculatedCoins.length;

        // BƯỚC 3: Phân loại NHÓM A (-8% < diffEMA < -3%) & Tính Vol 60h, diffbbl1d
        console.log('⏳ [Bước 3] Đang lọc Nhóm A (-8% < diffEMA < -3%) và lấy dữ liệu 1D...');
        const groupA = [];
        for (const c of calculatedCoins) {
            if (c.diffEMA > -8 && c.diffEMA < -3) {
                const vol60h = calculateVol60h(c.raw1H);
                c.vol60h = vol60h !== null ? vol60h : 0;

                const data1D = await checkDiff1D(c.symbol);
                c.diffbbl1d = data1D ? data1D.diffbbl1d : null;
                groupA.push(c);

                await sleep(60); // Buffer rate-limit
            }
        }
        stats.step3_groupA_diffEma = groupA.length;

        // Ghi file 24h.json
        const formatItemA = c => ({
            symbol: c.symbol,
            diffEMA: parseFloat(c.diffEMA.toFixed(2)),
            vol60h: parseFloat(c.vol60h.toFixed(2)),
            diffbbl1d: c.diffbbl1d !== null ? parseFloat(c.diffbbl1d.toFixed(2)) : null,
            volCcy24h: c.volCcy24h
        });

        save24hJson({ groupNeg8ToNeg3: groupA.map(formatItemA) });

        // Gửi Tín Hiệu SHORT về Telegram
        const sendAlert = async (symbol, type, diffEmaVal, cooldownKey, extraData = {}) => {
            if (!sentLog[symbol]) sentLog[symbol] = {};
            const lastSent = sentLog[symbol][cooldownKey] || 0;

            if (currentTime - lastSent >= COOLDOWN_TIME) {
                stats.step6_passedCooldown++;
                const coinName = symbol.replace('-USDT-SWAP', '');
                const link = `https://www.okx.com/trade-swap/${symbol.toLowerCase()}`;

                let message = `🔴 <b>${coinName} (${type})</b>\n` +
                              `• DiffEMA: <b>${diffEmaVal > 0 ? '+' : ''}${diffEmaVal.toFixed(2)}%</b>\n`;

                if (extraData.diffbbu !== undefined) {
                    message += `• DiffBBu (1H): <b>${extraData.diffbbu > 0 ? '+' : ''}${extraData.diffbbu.toFixed(2)}%</b>\n`;
                }

                if (extraData.diffbbl1d !== undefined && extraData.diffbbl1d !== null) {
                    message += `• DiffBBL (1D): <b>${extraData.diffbbl1d > 0 ? '+' : ''}${extraData.diffbbl1d.toFixed(2)}%</b>\n`;
                }

                if (extraData.hBB !== undefined) {
                    message += `• Hbb (BB Width): <b>${extraData.hBB.toFixed(2)}%</b>\n`;
                }

                if (extraData.vol60h !== undefined) {
                    message += `• Vol 60h: <b>${extraData.vol60h > 0 ? '+' : ''}${extraData.vol60h.toFixed(2)}%</b>\n`;
                }

                message += `• <a href="${link}">Trade trên OKX</a>`;

                console.log(`🚀 [${type} MATCHED] Gửi Telegram cho ${symbol}...`);
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                }).catch(err => console.error('Lỗi gửi Telegram:', err.message));

                sentLog[symbol][cooldownKey] = currentTime;
                hasNewAlert = true;
            } else {
                const remainingMin = Math.ceil((COOLDOWN_TIME - (currentTime - lastSent)) / 60000);
                console.log(`⏳ [COOLDOWN] ${symbol} đã gửi tín hiệu, còn ${remainingMin} phút.`);
            }
        };

        // BƯỚC 4 & 5: Quét tín hiệu chi tiết
        console.log(`🔍 [Bước 4 & 5] Quét tín hiệu NHÓM A (${groupA.length} coins)...`);
        for (const item of groupA) {
            const sig = checkSignalGroupA(item);
            if (sig) {
                stats.step4_groupA_signalBB++;

                // Điều kiện lọc 1D: diffbbl1d > 2%
                if (item.diffbbl1d !== null && item.diffbbl1d > 2) {
                    stats.step5_groupA_diffbbl1d++;
                    await sendAlert(item.symbol, 'SHORT', item.diffEMA, '_short1h', { 
                        vol60h: item.vol60h,
                        diffbbu: sig.diffbbu,
                        diffbbl1d: item.diffbbl1d,
                        hBB: sig.hBB 
                    });
                } else {
                    console.log(`⏩ [LỌC 1D LOẠI] ${item.symbol} vì diffbbl1d (${item.diffbbl1d !== null ? item.diffbbl1d.toFixed(2) : 'N/A'}% <= 2%)`);
                }
            }
        }

        if (hasNewAlert) saveSentLog(sentLog);

        // BƯỚC 6: Bảng thống kê phễu lọc (Funnel Filter Report)
        console.log('\n================ BÁO CÁO PHỄU LỌC (FUNNEL REPORT) ================');
        console.log(`1. Volume >= 5M USDT           : ${stats.step1_volume5M} coins`);
        console.log(`2. Lấy đủ nến & tính diffEMA   : ${stats.step2_validEma} coins`);
        console.log(`3. Nhóm A (-8% < diffEMA < -3%): ${stats.step3_groupA_diffEma} coins`);
        console.log(`4. Khớp BB 1H (-0.5% < diffbbu < 2%) : ${stats.step4_groupA_signalBB} coins`);
        console.log(`5. Khớp BB 1D (diffbbl1d > 2%) : ${stats.step5_groupA_diffbbl1d} coins`);
        console.log(`6. Bắn Telegram (qua Cooldown) : ${stats.step6_passedCooldown} coins`);
        console.log('==================================================================\n');

        console.log('--- HOÀN THÀNH QUÉT THỊ TRƯỜNG ---');
    } catch (err) {
        console.error('Lỗi hệ thống trong main():', err.message);
    }
}
