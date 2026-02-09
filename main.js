import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { fork } from 'child_process';
import { WebSocketServer } from 'ws';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let serverPort = 3000;
let wsPort = 3001;
let scraperProcess = null;
let wss = null;

// Son otobüs verileri (cache)
const busDataCache = new Map();

// Güncelleme durumu
let updateStatus = {
    checking: false,
    available: false,
    downloaded: false,
    version: null,
    error: null,
    lastCheck: null
};

// AutoUpdater yapılandırması
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('checking-for-update', () => {
    console.log('[UPDATE] Güncelleme kontrol ediliyor...');
    updateStatus.checking = true;
    updateStatus.lastCheck = new Date().toISOString();
});

autoUpdater.on('update-available', (info) => {
    console.log('[UPDATE] Güncelleme mevcut:', info.version);
    updateStatus.checking = false;
    updateStatus.available = true;
    updateStatus.version = info.version;
});

autoUpdater.on('update-not-available', () => {
    console.log('[UPDATE] Uygulama güncel.');
    updateStatus.checking = false;
    updateStatus.available = false;
});

autoUpdater.on('update-downloaded', (info) => {
    console.log('[UPDATE] Güncelleme indirildi:', info.version);
    updateStatus.downloaded = true;
});

autoUpdater.on('error', (err) => {
    console.log('[UPDATE] Güncelleme hatası:', err.message);
    updateStatus.checking = false;
    updateStatus.error = err.message;
});

// WebSocket Server başlat
function startWebSocketServer() {
    wss = new WebSocketServer({ port: wsPort });

    wss.on('connection', (ws) => {
        console.log('[WS] Yeni bağlantı');

        // Mevcut cache'i gönder
        for (const [busId, data] of busDataCache) {
            ws.send(JSON.stringify({
                type: 'bus-data',
                busId,
                data,
                timestamp: new Date().toISOString()
            }));
        }

        ws.on('close', () => {
            console.log('[WS] Bağlantı kapandı');
        });
    });

    console.log(`[WS] WebSocket server ws://localhost:${wsPort} adresinde çalışıyor`);
}

// Tüm bağlı client'lara veri gönder
function broadcastToClients(message) {
    if (!wss) return;

    const data = JSON.stringify(message);
    wss.clients.forEach(client => {
        if (client.readyState === 1) { // OPEN
            client.send(data);
        }
    });
}

function startScraper() {
    console.log('[MAIN] Scraper process başlatılıyor...');
    scraperProcess = fork(path.join(__dirname, 'scraper.cjs'));

    scraperProcess.on('message', (msg) => {
        // Scraper'dan gelen verileri WebSocket'e ilet
        if (msg.type === 'bus-data') {
            busDataCache.set(msg.busId, msg.data);
            broadcastToClients(msg);
        } else if (msg.type === 'bus-status') {
            broadcastToClients(msg);
        }
    });

    scraperProcess.on('error', (err) => {
        console.error('[MAIN] Scraper error:', err);
    });

    scraperProcess.on('exit', (code) => {
        console.log('[MAIN] Scraper exited with code:', code);
        scraperProcess = null;
    });

    return scraperProcess;
}

function startExpressServer() {
    const expressApp = express();

    expressApp.use(express.json());
    expressApp.use(express.static(path.join(__dirname, 'public')));

    // Uygulama bilgisi endpoint'i
    expressApp.get('/api/app-info', (req, res) => {
        res.json({
            version: app.getVersion(),
            name: app.getName(),
            updateStatus: updateStatus,
            wsPort: wsPort
        });
    });

    // Otobüs güncelleme endpoint'i
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

    // Güncelleme kontrol endpoint'i
    expressApp.post('/api/check-update', (req, res) => {
        autoUpdater.checkForUpdates();
        res.json({ success: true });
    });

    // Güncellemeyi uygula endpoint'i
    expressApp.post('/api/install-update', (req, res) => {
        if (updateStatus.downloaded) {
            autoUpdater.quitAndInstall();
        }
        res.json({ success: updateStatus.downloaded });
    });

    expressApp.get('/api/health', (req, res) => {
        res.json({
            status: 'ok',
            scraperRunning: scraperProcess !== null,
            connectedClients: wss ? wss.clients.size : 0,
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
        startWebSocketServer();
        startScraper();
        startExpressServer();

        setTimeout(() => {
            createWindow();
            // Başlangıçta güncelleme kontrol et
            autoUpdater.checkForUpdates().catch(err => {
                console.log('[UPDATE] Güncelleme kontrolü başarısız:', err.message);
            });
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
    if (wss) {
        wss.close();
    }
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    if (scraperProcess) {
        scraperProcess.send({ action: 'exit' });
    }
    if (wss) {
        wss.close();
    }
});