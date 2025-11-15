import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let serverPort = 3000;

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
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
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
        return { found: false, time: 'Bulunamadı' };
    } finally {
        if (browser) {
            await browser.close();
        }
    }
    return { found: false, time: 'Bulunamadı' };
}

function startExpressServer() {
    const expressApp = express();

    expressApp.use(express.static(path.join(__dirname, 'public')));

    expressApp.get('/api/bustimes', async (req, res) => {
        console.log('API isteği alındı. Otobüs verileri çekiliyor...');

        const promises = busesToTrack.map(bus => scrapeSingleBus(bus.url));
        const results = await Promise.all(promises);

        const responseData = results.map((result, index) => ({
            id: busesToTrack[index].id,
            line: busesToTrack[index].line,
            ...result
        }));

        console.log('Veriler gönderiliyor:', responseData);
        res.json(responseData);
    });

    expressApp.listen(serverPort, () => {
        console.log(`Express sunucu ${serverPort} portunda başlatıldı`);
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        },
        autoHideMenuBar: true,
        frame: true,
        resizable: true
    });

    mainWindow.loadURL(`http://localhost:${serverPort}`);

    mainWindow.on('closed', function () {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    startExpressServer();
    setTimeout(() => {
        createWindow();
    }, 1000);

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});