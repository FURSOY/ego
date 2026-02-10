const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

// Varsayılan duraklar
let stopsToTrack = ['50782', '50781', '50780'];

// Aktif tarayıcılar
const activeBrowsers = new Map();

// Veri gönderme
function sendData(stopId, buses) {
    if (process.send) {
        process.send({
            type: 'stop-data',
            stopId,
            buses,
            timestamp: new Date().toISOString()
        });
    }
}

// Durum gönderme
function sendStatus(stopId, status, message = '') {
    if (process.send) {
        process.send({
            type: 'stop-status',
            stopId,
            status,
            message,
            timestamp: new Date().toISOString()
        });
    }
}

// URL oluştur
function buildUrl(stopId) {
    return `https://www.ego.gov.tr/tr/otobusnerede/index?durak_no=${stopId}&hat_no=`;
}

// Tabloyu parse et - tüm otobüsleri çek
async function parseAllBuses(page) {
    return await page.evaluate(() => {
        const results = [];

        // Gerçek tablo class'ı "list"
        const rows = document.querySelectorAll('table.list tr');

        let currentLine = null;
        let currentLineName = null;

        for (const row of rows) {
            const cells = row.querySelectorAll('td');

            // Hat bilgisi satırı: 2 hücre, font-weight:bold
            if (cells.length === 2 && cells[0].style.fontWeight === 'bold') {
                currentLine = cells[0].textContent.trim();
                currentLineName = cells[1].textContent.trim();
                continue;
            }

            // Varış süresi satırı: colspan=2, kırmızı bold text
            const timeEl = row.querySelector('b[style*="color"]');
            if (timeEl && currentLine) {
                const timeText = timeEl.textContent.trim();
                const cleanTime = timeText.replace('Tahmini Varış Süresi: ', '').replace('Tahmini Varış Süresi:', '').trim();

                results.push({
                    line: currentLine,
                    lineName: currentLineName || '',
                    time: cleanTime
                });

                currentLine = null;
                currentLineName = null;
            }
        }

        return results;
    });
}

// Tek durak için sürekli döngü
async function startStopLoop(stopId) {
    let browser = null;
    let page = null;
    let consecutiveErrors = 0;
    const MAX_ERRORS = 3;

    console.log(`[${stopId}] Döngü başlatılıyor...`);
    sendStatus(stopId, 'starting', 'Tarayıcı başlatılıyor');

    while (true) {
        try {
            // Tarayıcı yoksa başlat
            if (!browser || !browser.isConnected()) {
                console.log(`[${stopId}] Tarayıcı açılıyor...`);

                browser = await puppeteer.launch({
                    headless: true,
                    ignoreHTTPSErrors: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu',
                        '--ignore-certificate-errors'
                    ]
                });

                activeBrowsers.set(stopId, browser);
                page = await browser.newPage();

                console.log(`[${stopId}] Sayfa yükleniyor...`);
                sendStatus(stopId, 'loading', 'Sayfa yükleniyor');

                await page.goto(buildUrl(stopId), {
                    waitUntil: 'networkidle2',
                    timeout: 30000
                });

                console.log(`[${stopId}] Sayfa hazır!`);
            }

            // Buton tıkla
            const buttonSelector = 'input.btn.red[value="Otobus Nerede?"]';
            sendStatus(stopId, 'clicking', 'Veri çekiliyor');

            await page.waitForSelector(buttonSelector, { timeout: 10000, visible: true });
            await page.click(buttonSelector);

            // Tablo sonucu bekle
            try {
                // Tablonun gelmesini bekle
                await page.waitForSelector('table.list', { timeout: 15000 });
                // Kısa bekleme - tablo dolsun
                await new Promise(r => setTimeout(r, 2000));

                const buses = await parseAllBuses(page);

                if (buses.length > 0) {
                    console.log(`[${stopId}] ${buses.length} otobüs bulundu`);
                    sendStatus(stopId, 'active', `${buses.length} otobüs`);
                    sendData(stopId, buses);
                } else {
                    console.log(`[${stopId}] Otobüs bulunamadı`);
                    sendStatus(stopId, 'empty', 'Sefer yok');
                    sendData(stopId, []);
                }

                consecutiveErrors = 0;
            } catch (timeoutErr) {
                console.log(`[${stopId}] Tablo yüklenemedi`);
                sendStatus(stopId, 'error', 'Tablo yüklenemedi');
                // Boş veri gönderme - mevcut veriler korunsun
                consecutiveErrors = 0;
            }

            // Kısa bekleme - hemen tekrar tıkla
            await new Promise(r => setTimeout(r, 500));

        } catch (error) {
            consecutiveErrors++;
            console.error(`[${stopId}] Hata (${consecutiveErrors}/${MAX_ERRORS}):`, error.message);
            sendStatus(stopId, 'error', error.message);

            if (consecutiveErrors >= MAX_ERRORS) {
                console.log(`[${stopId}] Çok fazla hata, 30 saniye bekleniyor...`);
                sendStatus(stopId, 'waiting', '30 saniye bekleniyor');

                if (browser) {
                    try { await browser.close(); } catch (e) { }
                    browser = null;
                    page = null;
                    activeBrowsers.delete(stopId);
                }

                await new Promise(r => setTimeout(r, 30000));
                consecutiveErrors = 0;
            } else {
                await new Promise(r => setTimeout(r, 3000));

                if (page && browser && browser.isConnected()) {
                    try {
                        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                    } catch (reloadErr) {
                        if (browser) {
                            try { await browser.close(); } catch (e) { }
                            browser = null;
                            page = null;
                            activeBrowsers.delete(stopId);
                        }
                    }
                }
            }
        }
    }
}

// Tüm durak döngülerini başlat
async function startAllLoops() {
    console.log('[SCRAPER] Tüm döngüler başlatılıyor:', stopsToTrack);

    for (const stopId of stopsToTrack) {
        startStopLoop(stopId).catch(err => {
            console.error(`[${stopId}] Fatal error:`, err);
        });

        await new Promise(r => setTimeout(r, 1000));
    }
}

// IPC mesaj dinleyici
process.on('message', async (msg) => {
    if (msg.action === 'update-stops') {
        if (msg.stops && Array.isArray(msg.stops)) {
            // Eski tarayıcıları kapat
            for (const [stopId, browser] of activeBrowsers) {
                try { await browser.close(); } catch (e) { }
            }
            activeBrowsers.clear();

            stopsToTrack = msg.stops;
            console.log('[SCRAPER] Durak listesi güncellendi:', stopsToTrack);

            startAllLoops();
        }
    } else if (msg.action === 'exit') {
        console.log('[SCRAPER] Kapatılıyor...');
        for (const [stopId, browser] of activeBrowsers) {
            try { await browser.close(); } catch (e) { }
        }
        process.exit(0);
    }
});

process.on('uncaughtException', (err) => {
    console.error('[SCRAPER] Uncaught:', err.message);
});

// Başlangıçta otomatik başlat
startAllLoops();
