const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

// Varsayılan otobüsler
let busesToTrack = [
    { id: 'bus-1', line: '561', stop: '50782' },
    { id: 'bus-2', line: '561', stop: '50781' },
    { id: 'bus-3', line: '561', stop: '50780' }
];

// Aktif tarayıcılar
const activeBrowsers = new Map();

// Veri gönderme fonksiyonu
function sendData(busId, data) {
    if (process.send) {
        process.send({
            type: 'bus-data',
            busId,
            data,
            timestamp: new Date().toISOString()
        });
    }
}

// Durum gönderme fonksiyonu
function sendStatus(busId, status, message = '') {
    if (process.send) {
        process.send({
            type: 'bus-status',
            busId,
            status,
            message,
            timestamp: new Date().toISOString()
        });
    }
}

// URL oluştur
function buildUrl(bus) {
    return `https://www.ego.gov.tr/tr/otobusnerede/index?durak_no=${bus.stop}&hat_no=${bus.line}`;
}

// Tek otobüs için sürekli döngü
async function startBusLoop(bus) {
    let browser = null;
    let page = null;
    let consecutiveErrors = 0;
    const MAX_ERRORS = 3;

    console.log(`[${bus.id}] Döngü başlatılıyor...`);
    sendStatus(bus.id, 'starting', 'Tarayıcı başlatılıyor');

    while (true) {
        try {
            // Tarayıcı yoksa veya kapalıysa başlat
            if (!browser || !browser.isConnected()) {
                console.log(`[${bus.id}] Tarayıcı açılıyor...`);

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

                activeBrowsers.set(bus.id, browser);
                page = await browser.newPage();

                // Sayfa yükle
                console.log(`[${bus.id}] Sayfa yükleniyor...`);
                sendStatus(bus.id, 'loading', 'Sayfa yükleniyor');

                await page.goto(buildUrl(bus), {
                    waitUntil: 'networkidle2',
                    timeout: 30000
                });

                console.log(`[${bus.id}] Sayfa hazır!`);
            }

            // Buton tıkla
            const buttonSelector = 'input.btn.red[value="Otobus Nerede?"]';
            sendStatus(bus.id, 'clicking', 'Veri çekiliyor');

            await page.waitForSelector(buttonSelector, { timeout: 10000, visible: true });
            await page.click(buttonSelector);

            // Sonuç bekle
            const timeSelector = 'b[style*="color: #B80000"]';

            try {
                await page.waitForSelector(timeSelector, { timeout: 15000 });

                const timeElement = await page.$(timeSelector);
                if (timeElement) {
                    const timeText = await page.evaluate(el => el.textContent, timeElement);
                    const cleanTime = timeText.trim().replace('Tahmini Varış Süresi: ', '');

                    console.log(`[${bus.id}] Veri: ${cleanTime}`);
                    sendStatus(bus.id, 'active', cleanTime);
                    sendData(bus.id, {
                        found: true,
                        time: cleanTime,
                        line: bus.line,
                        stop: bus.stop
                    });

                    consecutiveErrors = 0;
                }
            } catch (timeoutErr) {
                // Otobüs bulunamadı
                console.log(`[${bus.id}] Sefer yok`);
                sendStatus(bus.id, 'inactive', 'Sefer Yok');
                sendData(bus.id, {
                    found: false,
                    time: 'Sefer Yok',
                    line: bus.line,
                    stop: bus.stop
                });
                consecutiveErrors = 0;
            }

            // Kısa bekleme - butona hemen tekrar tıkla
            await new Promise(r => setTimeout(r, 500));

        } catch (error) {
            consecutiveErrors++;
            console.error(`[${bus.id}] Hata (${consecutiveErrors}/${MAX_ERRORS}):`, error.message);
            sendStatus(bus.id, 'error', error.message);

            if (consecutiveErrors >= MAX_ERRORS) {
                console.log(`[${bus.id}] Çok fazla hata, 30 saniye bekleniyor...`);
                sendStatus(bus.id, 'waiting', '30 saniye bekleniyor');

                // Tarayıcıyı kapat
                if (browser) {
                    try { await browser.close(); } catch (e) { }
                    browser = null;
                    page = null;
                    activeBrowsers.delete(bus.id);
                }

                await new Promise(r => setTimeout(r, 30000));
                consecutiveErrors = 0;
            } else {
                // Kısa bekleme sonra tekrar dene
                await new Promise(r => setTimeout(r, 3000));

                // Sayfayı yeniden yükle
                if (page && browser && browser.isConnected()) {
                    try {
                        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                    } catch (reloadErr) {
                        // Tarayıcıyı yeniden başlat
                        if (browser) {
                            try { await browser.close(); } catch (e) { }
                            browser = null;
                            page = null;
                            activeBrowsers.delete(bus.id);
                        }
                    }
                }
            }
        }
    }
}

// Tüm otobüs döngülerini başlat
async function startAllLoops() {
    console.log('[SCRAPER] Tüm döngüler başlatılıyor...');

    for (const bus of busesToTrack) {
        // Her döngüyü ayrı promise olarak başlat (paralel)
        startBusLoop(bus).catch(err => {
            console.error(`[${bus.id}] Fatal error:`, err);
        });

        // Tarayıcılar arası küçük gecikme
        await new Promise(r => setTimeout(r, 1000));
    }
}

// IPC mesaj dinleyici
process.on('message', async (msg) => {
    if (msg.action === 'start') {
        startAllLoops();
    } else if (msg.action === 'update-buses') {
        if (msg.buses && Array.isArray(msg.buses)) {
            // Eski tarayıcıları kapat
            for (const [busId, browser] of activeBrowsers) {
                try { await browser.close(); } catch (e) { }
            }
            activeBrowsers.clear();

            // Yeni listeyi güncelle
            busesToTrack = msg.buses.map(bus => ({
                id: bus.id,
                line: bus.line,
                stop: bus.stop
            }));

            console.log('[SCRAPER] Otobüs listesi güncellendi:', busesToTrack.length);

            // Döngüleri yeniden başlat
            startAllLoops();
        }
    } else if (msg.action === 'exit') {
        console.log('[SCRAPER] Kapatılıyor...');
        for (const [busId, browser] of activeBrowsers) {
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
