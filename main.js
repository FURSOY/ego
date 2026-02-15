import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
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

// Son durak verileri (cache)
const stopDataCache = new Map();

// Güncelleme durumu
let updateStatus = {
    checking: false,
    available: false,
    downloading: false,
    downloadProgress: 0,
    downloaded: false,
    version: null,
    error: null,
    lastCheck: null
};

// Sistemde yüklü tarayıcıyı bul (Chrome veya Edge)
function findBrowserPath() {
    const possiblePaths = [
        // Edge (Windows 10/11'de her zaman var)
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        // Chrome
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        // Chrome (kullanıcı dizini)
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        // Edge (kullanıcı dizini)
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
    ];

    for (const browserPath of possiblePaths) {
        if (browserPath && existsSync(browserPath)) {
            console.log('[MAIN] Tarayıcı bulundu:', browserPath);
            return browserPath;
        }
    }

    console.error('[MAIN] Sistemde Chrome veya Edge bulunamadı!');
    return null;
}

// AutoUpdater
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('checking-for-update', () => {
    updateStatus.checking = true;
    updateStatus.lastCheck = new Date().toISOString();
});

autoUpdater.on('update-available', (info) => {
    updateStatus.checking = false;
    updateStatus.available = true;
    updateStatus.downloading = true;
    updateStatus.downloadProgress = 0;
    updateStatus.version = info.version;
});

autoUpdater.on('download-progress', (progress) => {
    updateStatus.downloading = true;
    updateStatus.downloadProgress = Math.round(progress.percent);
});

autoUpdater.on('update-not-available', () => {
    updateStatus.checking = false;
    updateStatus.available = false;
    updateStatus.downloading = false;
});

autoUpdater.on('update-downloaded', (info) => {
    updateStatus.downloading = false;
    updateStatus.downloadProgress = 100;
    updateStatus.downloaded = true;
});

autoUpdater.on('error', (err) => {
    updateStatus.checking = false;
    updateStatus.downloading = false;
    updateStatus.error = err.message;
});

// WebSocket Server
function startWebSocketServer() {
    wss = new WebSocketServer({ port: wsPort });

    wss.on('connection', (ws) => {
        // Mevcut cache'i gönder
        for (const [stopId, data] of stopDataCache) {
            ws.send(JSON.stringify({
                type: 'stop-data',
                stopId,
                buses: data,
                timestamp: new Date().toISOString()
            }));
        }

        ws.on('close', () => { });
    });

    console.log(`[WS] WebSocket server ws://localhost:${wsPort}`);
}

function broadcastToClients(message) {
    if (!wss) return;
    const data = JSON.stringify(message);
    wss.clients.forEach(client => {
        if (client.readyState === 1) client.send(data);
    });
}

// Frontend konsoluna log gönder
function broadcastLog(level, ...args) {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    console.log(msg);
    broadcastToClients({ type: 'debug-log', level, message: msg, timestamp: new Date().toISOString() });
}

function startScraper() {
    const browserPath = findBrowserPath();
    if (!browserPath) {
        broadcastLog('error', '[MAIN] Sistemde Chrome veya Edge bulunamadı! Scraper başlatılamıyor.');
        return;
    }

    broadcastLog('info', '[MAIN] Tarayıcı bulundu:', browserPath);
    broadcastLog('info', '[MAIN] Scraper başlatılıyor...');
    scraperProcess = fork(path.join(__dirname, 'scraper.cjs'));

    scraperProcess.on('message', (msg) => {
        if (msg.type === 'stop-data') {
            stopDataCache.set(msg.stopId, msg.buses);
            broadcastToClients(msg);
            broadcastLog('info', `[SCRAPER] ${msg.stopId}: ${msg.buses.length} otobüs bulundu`);
        } else if (msg.type === 'stop-status') {
            broadcastToClients(msg);
            broadcastLog('info', `[SCRAPER] ${msg.stopId} durum: ${msg.status} - ${msg.message}`);
        }
    });

    scraperProcess.on('error', (err) => {
        broadcastLog('error', '[MAIN] Scraper error:', err.message);
    });

    scraperProcess.on('exit', (code) => {
        broadcastLog('warn', '[MAIN] Scraper kapandı, exit code:', code);
        scraperProcess = null;
    });

    // Tarayıcı yolunu scraper'a gönder
    scraperProcess.send({ action: 'set-browser-path', path: browserPath });
}

function startExpressServer() {
    const expressApp = express();
    expressApp.use(express.json());
    expressApp.use(express.static(path.join(__dirname, 'public')));

    expressApp.get('/api/app-info', (req, res) => {
        res.json({
            version: app.getVersion(),
            name: app.getName(),
            updateStatus,
            wsPort
        });
    });

    expressApp.post('/api/update-stops', (req, res) => {
        console.log('[API] Durak listesi güncelleniyor:', req.body);
        try {
            if (scraperProcess) {
                scraperProcess.send({ action: 'update-stops', stops: req.body });
            }
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    expressApp.post('/api/check-update', (req, res) => {
        autoUpdater.checkForUpdates();
        res.json({ success: true });
    });

    expressApp.post('/api/install-update', (req, res) => {
        if (updateStatus.downloaded) autoUpdater.quitAndInstall();
        res.json({ success: updateStatus.downloaded });
    });

    expressApp.get('/api/health', (req, res) => {
        res.json({
            status: 'ok',
            scraperRunning: scraperProcess !== null,
            connectedClients: wss ? wss.clients.size : 0
        });
    });

    expressApp.listen(serverPort, () => {
        console.log(`[MAIN] Express http://localhost:${serverPort}`);
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: { nodeIntegration: false, contextIsolation: true },
        autoHideMenuBar: true,
        frame: true,
        resizable: true
    });

    mainWindow.loadURL(`http://localhost:${serverPort}`);
    mainWindow.on('closed', () => { mainWindow = null; });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
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
            autoUpdater.checkForUpdates().catch(() => { });
        }, 500);

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });
}

app.on('window-all-closed', () => {
    if (scraperProcess) scraperProcess.send({ action: 'exit' });
    if (wss) wss.close();
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    if (scraperProcess) scraperProcess.send({ action: 'exit' });
    if (wss) wss.close();
});