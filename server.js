import express from 'express';
import path from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Puppeteer'a gizlilik eklentisini kur
puppeteer.use(StealthPlugin());

const app = express();
const port = process.env.PORT || 3000;

const busesToTrack = [
    {
        id: 'bus-1',
        line: '561',
        stop: '50782',
        url: 'https://www.ego.gov.tr/tr/otobusnerede/index?durak_no=50782&hat_no=561'
    },
    {
        id: 'bus-2',
        line: '540',
        stop: '50781',
        url: 'https://www.ego.gov.tr/tr/otobusnerede/index?durak_no=50781&hat_no=540'
    },
    {
        id: 'bus-3',
        line: '561',
        stop: '50780',
        url: 'https://www.ego.gov.tr/tr/otobusnerede/index?durak_no=50780&hat_no=561'
    }
];

async function scrapeSingleBus(url) {
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle2' });

        const buttonSelector = 'input.btn.red[value="Otobus Nerede?"]';
        await page.waitForSelector(buttonSelector);
        await page.click(buttonSelector);

        const timeSelector = 'b[style*="color: #B80000"]';
        await page.waitForSelector(timeSelector, { timeout: 10000 });

        const timeElement = await page.$(timeSelector);
        if (timeElement) {
            const timeText = await page.evaluate(el => el.textContent, timeElement);
            return { found: true, time: timeText.trim().replace('Tahmini Varış Süresi: ', '') };
        }
    } catch (error) {
        console.error(error);
        // Hata ayıklama için hata mesajını tarayıcıya gönder
        return { found: false, time: `Hata: ${error.message.substring(0, 200)}` };
    } finally {
        if (browser) {
            await browser.close();
        }
    }
    return { found: false, time: 'Veri bulunamadı.' };
}

// Frontend dosyalarını (HTML, CSS) sunmak için public klasörünü kullan
const __dirname = path.resolve(path.dirname(''));
app.use(express.static(path.join(__dirname, 'public')));

// Otobüs verilerini sağlayan API endpoint'i
app.get('/api/bustimes', async (req, res) => {
    console.log('API isteği alındı. Otobüs verileri çekiliyor...');

    // Tüm otobüsleri eş zamanlı olarak (paralel) kazı
    const promises = busesToTrack.map(bus => scrapeSingleBus(bus.url));
    const results = await Promise.all(promises);

    // Sonuçları frontend'in beklediği formatla birleştir
    const responseData = results.map((result, index) => ({
        id: busesToTrack[index].id,
        line: busesToTrack[index].line,
        ...result
    }));

    console.log('Veriler gönderiliyor:', responseData);
    res.json(responseData);
});

// Sunucuyu başlat
app.listen(port, () => {
    console.log(`Sunucu başlatıldı. Takip ekranına http://localhost:${port} adresinden ulaşabilirsiniz.`);
});
