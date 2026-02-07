import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { fork } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let serverPort = 3000;
let scraperProcess = null;

function startScraper() {
    console.log('[MAIN] Scraper process başlatılıyor...');
    scraperProcess = fork(path.join(__dirname, 'scraper.cjs'));

    scraperProcess.on('error', (err) => {
        console.error('[MAIN] Scraper error:', err);
    });

    scraperProcess.on('exit', (code) => {
        console.log('[MAIN] Scraper exited with code:', code);
        scraperProcess = null;
    });

    return scraperProcess;
}

function scrapeData() {
    return new Promise((resolve, reject) => {
        if (!scraperProcess) {
            startScraper();
        }

        const timeout = setTimeout(() => {
            reject(new Error('Scraping timeout (60s)'));
        }, 60000);

        scraperProcess.once('message', (msg) => {
            clearTimeout(timeout);
            if (msg.error) {
                reject(new Error(msg.error));
            } else {
                resolve(msg);
            }
        });

        scraperProcess.send({ action: 'scrape' });
    });
}

function startExpressServer() {
    const expressApp = express();

    expressApp.use(express.json());
    expressApp.use(express.static(path.join(__dirname, 'public')));

    expressApp.get('/api/bustimes', async (req, res) => {
        console.log('[API] İstek alındı');
        try {
            const result = await scrapeData();
            res.json(result);
        } catch (error) {
            console.error('[API] Hata:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    expressApp.post('/api/update-buses', (req, res) => {
        console.log('[API] Otobüs listesi güncelleniyor:', req.body);
        try {
            if (scraperProcess) {
                scraperProcess.send({ action: 'update-buses', buses: req.body });
            }
            res.json({ success: true });
        } catch (error) {
            console.error('[API] Güncelleme hatası:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    expressApp.get('/api/health', (req, res) => {
        res.json({
            status: 'ok',
            scraperRunning: scraperProcess !== null,
            timestamp: new Date().toISOString()
        });
    });

    expressApp.listen(serverPort, () => {
        console.log(`[MAIN] Express sunucu http://localhost:${serverPort} adresinde çalışıyor`);
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

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        startScraper();
        startExpressServer();

        setTimeout(() => {
            createWindow();
        }, 500);

        app.on('activate', function () {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });
}

app.on('window-all-closed', function () {
    if (scraperProcess) {
        scraperProcess.send({ action: 'exit' });
    }
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    if (scraperProcess) {
        scraperProcess.send({ action: 'exit' });
    }
});