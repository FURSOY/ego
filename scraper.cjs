const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

let busesToTrack = [
    {
        id: 'bus-1',
        line: '561',
        stop: '50782',
        url: 'https://www.ego.gov.tr/tr/otobusnerede/index?durak_no=50782&hat_no=561'
    },
    {
        id: 'bus-2',
        line: '561',
        stop: '50781',
        url: 'https://www.ego.gov.tr/tr/otobusnerede/index?durak_no=50781&hat_no=561'
    },
    {
        id: 'bus-3',
        line: '561',
        stop: '50780',
        url: 'https://www.ego.gov.tr/tr/otobusnerede/index?durak_no=50780&hat_no=561'
    }
];

let browser = null;

async function initBrowser() {
    if (!browser || !browser.isConnected()) {
        const startTime = performance.now();
        console.log('[SCRAPER] Tarayıcı başlatılıyor...');

        browser = await puppeteer.launch({
            headless: true,
            ignoreHTTPSErrors: true,
            executablePath: puppeteer.executablePath(),
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--ignore-certificate-errors'
            ]
        });
        console.log(`[SCRAPER] Tarayıcı hazır! (${(performance.now() - startTime).toFixed(0)}ms)`);
    }
    return browser;
}

async function scrapeSingleBus(browserInstance, busConfig) {
    const startTime = performance.now();
    let page = null;
    let pageLoadTime = 0;
    let scrapeTime = 0;

    try {
        const pageStart = performance.now();
        page = await browserInstance.newPage();

        // networkidle2 kullan - sayfa tam yüklensin
        await page.goto(busConfig.url, {
            waitUntil: 'networkidle2',
            timeout: 20000
        });
        pageLoadTime = performance.now() - pageStart;

        const scrapeStart = performance.now();
        const buttonSelector = 'input.btn.red[value="Otobus Nerede?"]';

        await page.waitForSelector(buttonSelector, { timeout: 10000 });
        await page.click(buttonSelector);

        const timeSelector = 'b[style*="color: #B80000"]';
        await page.waitForSelector(timeSelector, { timeout: 10000 });

        const timeElement = await page.$(timeSelector);
        scrapeTime = performance.now() - scrapeStart;

        if (timeElement) {
            const timeText = await page.evaluate(el => el.textContent, timeElement);
            const totalTime = performance.now() - startTime;

            console.log(`[PERF] ${busConfig.id} - Sayfa: ${pageLoadTime.toFixed(0)}ms | Scrape: ${scrapeTime.toFixed(0)}ms | TOPLAM: ${totalTime.toFixed(0)}ms`);

            return {
                found: true,
                time: timeText.trim().replace('Tahmini Varış Süresi: ', ''),
                perfStats: {
                    pageLoadTime: Math.round(pageLoadTime),
                    scrapeTime: Math.round(scrapeTime),
                    totalTime: Math.round(totalTime),
                    fromCache: false
                }
            };
        }

        return {
            found: false,
            time: 'Sefer Yok',
            perfStats: { totalTime: Math.round(performance.now() - startTime), fromCache: false }
        };

    } catch (error) {
        const totalTime = performance.now() - startTime;
        console.log(`[PERF] ${busConfig.id} - HATA: ${error.message} - ${totalTime.toFixed(0)}ms`);

        return {
            found: false,
            time: 'Bağlantı Hatası',
            perfStats: { totalTime: Math.round(totalTime), fromCache: false, error: error.message }
        };
    } finally {
        if (page) {
            try { await page.close(); } catch (e) { }
        }
    }
}

// Her otobüs kendi browser'ını açar - paralel çalışma için
async function scrapeSingleBusWithOwnBrowser(busConfig) {
    const startTime = performance.now();
    let browser = null;
    let page = null;
    let browserTime = 0;
    let pageLoadTime = 0;
    let scrapeTime = 0;

    try {
        const browserStart = performance.now();
        browser = await puppeteer.launch({
            headless: true,
            ignoreHTTPSErrors: true,
            executablePath: puppeteer.executablePath(),
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--ignore-certificate-errors'
            ]
        });
        browserTime = performance.now() - browserStart;

        const pageStart = performance.now();
        page = await browser.newPage();

        await page.goto(busConfig.url, {
            waitUntil: 'networkidle2',
            timeout: 20000
        });
        pageLoadTime = performance.now() - pageStart;

        const scrapeStart = performance.now();
        const buttonSelector = 'input.btn.red[value="Otobus Nerede?"]';

        await page.waitForSelector(buttonSelector, { timeout: 10000 });
        await page.click(buttonSelector);

        const timeSelector = 'b[style*="color: #B80000"]';
        await page.waitForSelector(timeSelector, { timeout: 10000 });

        const timeElement = await page.$(timeSelector);
        scrapeTime = performance.now() - scrapeStart;

        if (timeElement) {
            const timeText = await page.evaluate(el => el.textContent, timeElement);
            const totalTime = performance.now() - startTime;

            console.log(`[PERF] ${busConfig.id} - Browser: ${browserTime.toFixed(0)}ms | Sayfa: ${pageLoadTime.toFixed(0)}ms | Scrape: ${scrapeTime.toFixed(0)}ms | TOPLAM: ${totalTime.toFixed(0)}ms`);

            return {
                id: busConfig.id,
                line: busConfig.line,
                stop: busConfig.stop,
                found: true,
                time: timeText.trim().replace('Tahmini Varış Süresi: ', ''),
                perfStats: {
                    browserTime: Math.round(browserTime),
                    pageLoadTime: Math.round(pageLoadTime),
                    scrapeTime: Math.round(scrapeTime),
                    totalTime: Math.round(totalTime)
                }
            };
        }

        return {
            id: busConfig.id,
            line: busConfig.line,
            stop: busConfig.stop,
            found: false,
            time: 'Sefer Yok',
            perfStats: { totalTime: Math.round(performance.now() - startTime) }
        };

    } catch (error) {
        const totalTime = performance.now() - startTime;
        console.log(`[PERF] ${busConfig.id} - HATA: ${error.message} - ${totalTime.toFixed(0)}ms`);

        // Hata tipine göre mesaj belirle
        let errorMessage = 'Bulunamadı';
        if (error.message.includes('net::') ||
            error.message.includes('ERR_') ||
            error.message.includes('ENOTFOUND') ||
            error.message.includes('ETIMEDOUT') ||
            error.message.includes('Navigation')) {
            errorMessage = 'Bağlantı Hatası';
        }

        return {
            id: busConfig.id,
            line: busConfig.line,
            stop: busConfig.stop,
            found: false,
            time: errorMessage,
            perfStats: { totalTime: Math.round(totalTime), error: error.message }
        };
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) { }
        }
    }
}

async function scrapeAllBuses() {
    const apiStartTime = performance.now();

    console.log('\n========================================');
    console.log('[API] Veri çekiliyor:', new Date().toLocaleTimeString('tr-TR'));
    console.log('========================================');

    try {
        // PARALEL scrape - her otobüs için ayrı browser
        const promises = busesToTrack.map(bus => scrapeSingleBusWithOwnBrowser(bus));
        const results = await Promise.all(promises);

        const apiTotalTime = performance.now() - apiStartTime;

        console.log('----------------------------------------');
        console.log(`[API] TOPLAM: ${apiTotalTime.toFixed(0)}ms | Ort: ${(apiTotalTime / busesToTrack.length).toFixed(0)}ms/otobüs`);
        console.log('========================================\n');

        return {
            data: results,
            performance: {
                totalApiTime: Math.round(apiTotalTime),
                avgTimePerBus: Math.round(apiTotalTime / busesToTrack.length),
                fromCache: false,
                timestamp: new Date().toISOString()
            }
        };

    } catch (error) {
        console.error('[SCRAPER] Fatal error:', error);

        return {
            data: busesToTrack.map(bus => ({
                id: bus.id, line: bus.line, stop: bus.stop,
                found: false, time: 'Sunucu hatası',
                perfStats: { totalTime: 0, fromCache: false }
            })),
            performance: { totalApiTime: 0, fromCache: false }
        };
    }
}

// IPC mesaj dinleyici
process.on('message', async (msg) => {
    if (msg.action === 'scrape') {
        try {
            const result = await scrapeAllBuses();
            if (process.send) process.send(result);
        } catch (err) {
            if (process.send) process.send({ error: err.message });
        }
    } else if (msg.action === 'update-buses') {
        // Otobüs listesini güncelle
        if (msg.buses && Array.isArray(msg.buses)) {
            busesToTrack = msg.buses.map(bus => ({
                id: bus.id,
                line: bus.line,
                stop: bus.stop,
                url: `https://www.ego.gov.tr/tr/otobusnerede/index?durak_no=${bus.stop}&hat_no=${bus.line}`
            }));
            console.log('[SCRAPER] Otobüs listesi güncellendi:', busesToTrack.length, 'otobüs');
        }
    } else if (msg.action === 'exit') {
        if (browser) try { await browser.close(); } catch (e) { }
        process.exit(0);
    }
});

process.on('uncaughtException', (err) => {
    console.error('[SCRAPER] Uncaught:', err.message);
});
