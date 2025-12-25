const { app, BrowserWindow, BrowserView, ipcMain, Menu, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const readline = require('readline');
const os = require('os');
const url = require('url');

const statePath = path.join(app.getPath('userData'), 'session.json');

// Global Main Window
let mainWindow;

// View Management
class GdsView {
    constructor(id, filePath) {
        this.id = id;
        this.filePath = filePath;
        this.currentCell = undefined;
        this.isNegative = false;
        this.process = null;

        this.browserView = new BrowserView({
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                nodeIntegration: false,
                contextIsolation: true,
                webSecurity: false
            }
        });

        // Load the viewer HTML
        // Generate viewer.html in userData to avoid ASAR write issues and ensure correct paths
        const viewerPath = path.join(app.getPath('userData'), 'viewer.html');
        const html = generateHtml();
        fs.writeFileSync(viewerPath, html);

        this.browserView.webContents.loadFile(viewerPath);

        // Handle Theme
        this.browserView.webContents.on('did-finish-load', () => {
            let theme = currentTheme;
            if (theme === 'auto') {
                theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
            }
            this.browserView.webContents.send('theme-change', theme);
        });
    }

    destroy() {
        if (this.process) {
            this.process.kill();
        }
        // BrowserView destruction is handled by removing from window and letting GC collect it,
        // effectively (though we should nullify references)
        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                mainWindow.removeBrowserView(this.browserView);
            } catch (e) {
                // Ignore error if removal fails
            }
        }
        if (this.browserView && this.browserView.webContents && !this.browserView.webContents.isDestroyed()) {
            try {
                this.browserView.webContents.destroy();
            } catch (e) {
                // Ignore
            }
        }
    }

    runEngine(targetCell, isNegativeMode) {
        if (this.process) {
            this.process.kill();
            this.process = undefined;
        }

        const tempDir = path.join(os.tmpdir(), `gds_preview_data_${Date.now()}_${this.id}`);

        // Ensure file exists
        if (!fs.existsSync(this.filePath)) {
            console.error(`GDS file not found: ${this.filePath}`);
            return;
        }

        let executable;
        let args = [];
        const isWindows = process.platform === 'win32';
        const binName = isWindows ? 'gds-engine-rust.exe' : 'gds-engine-rust';
        const packagedBinName = isWindows ? 'gds-engine.exe' : 'gds-engine';

        if (app.isPackaged) {
             const possiblePaths = [
                 path.join(process.resourcesPath, 'gds-engine', packagedBinName),
                 path.join(process.resourcesPath, 'resources', 'gds-engine', packagedBinName),
             ];

             executable = possiblePaths.find(p => fs.existsSync(p));

             if (!executable) {
                 console.error(`[Error] gds-engine executable not found. Searched in: ${possiblePaths.join(', ')}`);
                 executable = path.join(process.resourcesPath, 'gds-engine', packagedBinName);
             }
        } else {
             // Development mode: look in ../bin/
             const rootDir = path.resolve(__dirname, '..');
             executable = path.join(rootDir, 'bin', binName);

             if (!fs.existsSync(executable)) {
                 console.warn(`Rust binary not found at ${executable}, trying target dir...`);
                 executable = path.join(rootDir, 'gds-engine-rust', 'target', 'release', binName);
             }
        }

        // Rust Engine Arguments:
        // input, output_dir, cell_name, chunk_size, flow_control_step, use_instancing, [--negative]
        args = [
            this.filePath,
            tempDir,
            targetCell || "",
            gdsConfig.chunkSize.toString(),
            gdsConfig.flowControlStep.toString(),
            (gdsConfig.renderingEngine === 'webgl' && gdsConfig.useInstancing) ? "1" : "0"
        ];

        if (isNegativeMode) {
            args.push("--negative");
        }

        console.log(`[View ${this.id}] Running: ${executable} ${args.join(' ')}`);

        try {
            const process = cp.spawn(executable, args);
            this.process = process;
            let stderr = '';

            process.stderr.on('data', (data) => {
                const msg = data.toString();
                stderr += msg;
                console.log(`[View ${this.id} Rust Stderr] ${msg}`);
            });

            const rl = readline.createInterface({
                input: process.stdout,
                crlfDelay: Infinity
            });

            let isFirstLine = true;

            rl.on('line', (line) => {
                // Check if view is still valid
                if (!this.browserView || !this.browserView.webContents || this.browserView.webContents.isDestroyed()) return;

                try {
                    if (!line.trim()) return;

                    if (line.startsWith("CHUNK_B64|")) {
                        const chunkInfo = JSON.parse(line.substring(10));
                        this.browserView.webContents.send('webview-message', {
                            command: 'addLayerChunkB64',
                            layerKey: chunkInfo.layerKey,
                            chunkIndex: chunkInfo.chunkIndex,
                            totalChunks: chunkInfo.totalChunks,
                            data: chunkInfo.data,
                            type: chunkInfo.type,
                            cellName: chunkInfo.cellName
                        });
                    } else if (line.startsWith("Warning:") || line.startsWith("INFO:")) {
                        console.log(`[View ${this.id} Python Log] ${line}`);
                    } else {
                        const data = JSON.parse(line);

                        if (isFirstLine) {
                             // Initialize
                             this.browserView.webContents.send('webview-message', {
                                 command: 'initialize',
                                 data: data,
                                 engine: gdsConfig.renderingEngine
                             });
                             isFirstLine = false;
                        } else if (data.type === 'ports') {
                            this.browserView.webContents.send('webview-message', {
                                command: 'addPorts',
                                ports: data.ports
                            });
                        } else if (data.layerKey && data.labels) {
                            this.browserView.webContents.send('webview-message', {
                                command: 'addLayerChunk',
                                layerKey: data.layerKey,
                                data: data
                            });
                        } else if (data.command === 'found') {
                            this.browserView.webContents.send('webview-message', data);
                        }
                    }
                } catch (e) {
                    console.error(`[View ${this.id}] Failed to parse line: ${e.message}`);
                }
            });

            process.on('close', (code) => {
                if (this.process !== process) return;
                this.process = undefined;
                if (!this.browserView || !this.browserView.webContents || this.browserView.webContents.isDestroyed()) return;

                if (code !== 0) {
                    console.error(`Python script exited with code ${code}`);
                } else {
                    this.browserView.webContents.send('webview-message', { command: 'status', message: 'Loaded successfully' });
                }
            });
        } catch (e) {
            console.error("Failed to spawn python:", e);
        }
    }
}

class ViewManager {
    constructor() {
        this.views = new Map(); // id -> GdsView
        this.viewOrder = []; // Array<id> for order
        this.activeViewId = null;
        this.nextId = 1;
    }

    saveSession() {
        const data = {
            openFiles: this.viewOrder.map(id => this.views.get(id).filePath),
            activeFileIndex: this.viewOrder.indexOf(this.activeViewId),
            theme: currentTheme,
            config: gdsConfig
        };
        try {
            fs.writeFileSync(statePath, JSON.stringify(data));
        } catch (e) {
            console.error("Failed to save session:", e);
        }
    }

    restoreSession() {
        try {
            if (fs.existsSync(statePath)) {
                const data = JSON.parse(fs.readFileSync(statePath));

                // Restore Theme
                if (data.theme) {
                    currentTheme = data.theme;
                    // updateTheme() is not available here if called before definition?
                    // Actually it is function declaration so it is hoisted.
                    // But currentTheme variable is let, so it is not hoisted.
                    // However, restoreSession is called inside createWindow which is called after module execution.
                    // So currentTheme is initialized.
                    updateTheme();
                    // We also need to update the menu checkmarks, but createMenu is called before restoreSession in createWindow.
                    // So we might need to recreate menu or update it.
                    createMenu();
                }

                // Restore Config
                if (data.config) {
                    Object.assign(gdsConfig, data.config);
                }

                if (data.openFiles && Array.isArray(data.openFiles) && data.openFiles.length > 0) {
                    for (const filePath of data.openFiles) {
                        if (fs.existsSync(filePath)) {
                            this.createTab(filePath, false);
                        }
                    }
                    if (data.activeFileIndex >= 0 && data.activeFileIndex < this.viewOrder.length) {
                        this.setActiveTab(this.viewOrder[data.activeFileIndex]);
                    } else if (this.viewOrder.length > 0) {
                        this.setActiveTab(this.viewOrder[0]);
                    }
                    return true; // Session restored
                }
            }
        } catch (e) {
            console.error("Failed to restore session:", e);
        }
        return false;
    }

    destroyAll() {
        for (const view of this.views.values()) {
            view.destroy();
        }
        this.views.clear();
        this.viewOrder = [];
        this.activeViewId = null;
    }

    createTab(filePath, activate = true) {
        const id = this.nextId++;
        const view = new GdsView(id, filePath, mainWindow);
        this.views.set(id, view);
        this.viewOrder.push(id);

        // Initially add browser view but might not be visible or top?
        // Actually we only attach the active one usually, or attach all and manage visibility?
        // Attaching only active is better for performance usually, but attaching all allows background processing?
        // Electron recommends attaching all but using setTopBrowserView.
        mainWindow.addBrowserView(view.browserView);

        this.updateShell();
        if (activate) {
            this.setActiveTab(id);
        }
    }

    closeTab(id) {
        const view = this.views.get(id);
        if (!view) return;

        view.destroy();
        this.views.delete(id);
        this.viewOrder = this.viewOrder.filter(vId => vId !== id);

        if (this.activeViewId === id) {
            // Switch to another tab
            if (this.viewOrder.length > 0) {
                // Switch to last one
                this.setActiveTab(this.viewOrder[this.viewOrder.length - 1]);
            } else {
                this.activeViewId = null;
            }
        }
        this.updateShell();
        this.saveSession();
    }

    setActiveTab(id) {
        if (!this.views.has(id)) return;

        this.activeViewId = id;

        // Bring to top
        const view = this.views.get(id);
        mainWindow.setTopBrowserView(view.browserView);

        // Resize
        this.resizeActiveView();

        this.updateShell();
        this.saveSession();
    }

    reorderTabs(newOrderIds) {
        // Validate IDs
        const validIds = newOrderIds.filter(id => this.views.has(id));
        // Add any missing IDs (safety check)
        this.viewOrder.forEach(id => {
            if (!validIds.includes(id)) {
                validIds.push(id);
            }
        });
        this.viewOrder = validIds;
        this.updateShell();
        this.saveSession();
    }

    resizeActiveView() {
        if (!this.activeViewId || !mainWindow) return;
        const view = this.views.get(this.activeViewId);
        const bounds = mainWindow.getBounds();
        const contentBounds = mainWindow.getContentBounds();

        // Shell height is 38px
        view.browserView.setBounds({
            x: 0,
            y: 38,
            width: contentBounds.width,
            height: contentBounds.height - 38
        });
    }

    updateShell() {
        if (!mainWindow) return;
        // Map over viewOrder instead of views.values() to preserve order
        const tabs = this.viewOrder.map(id => {
            const v = this.views.get(id);
            return {
                id: v.id,
                title: path.basename(v.filePath),
                fullPath: v.filePath,
                active: v.id === this.activeViewId
            };
        });
        mainWindow.webContents.send('shell-update-tabs', tabs);
    }

    getActiveView() {
        return this.views.get(this.activeViewId);
    }

    getViewByWebContentsId(id) {
        for (const view of this.views.values()) {
            if (view.browserView.webContents.id === id) {
                return view;
            }
        }
        return null;
    }

    broadcastConfigChange() {
        // Regenerate HTML
        const html = generateHtml();
        const viewerPath = path.join(app.getPath('userData'), 'viewer.html');
        fs.writeFileSync(viewerPath, html);

        // Reload all views? Or just update settings?
        // If structural change (workers), reload.
        for (const view of this.views.values()) {
             view.browserView.webContents.reload();
        }
    }
}

const viewManager = new ViewManager();

// --- Log Forwarding ---
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function broadcastLog(type, args) {
    // Basic formatting
    const message = args.map(a => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'object') return JSON.stringify(a);
        return String(a);
    }).join(' ');

    // Send to Shell (Main Window)
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('main-process-log', type, message);
    }

    // Send to Active View
    const activeView = viewManager.getActiveView();
    if (activeView && !activeView.browserView.webContents.isDestroyed()) {
         activeView.browserView.webContents.send('main-process-log', type, message);
    }
}

console.log = function(...args) {
    originalLog.apply(console, args);
    broadcastLog('log', args);
};

console.error = function(...args) {
    originalError.apply(console, args);
    broadcastLog('error', args);
};

console.warn = function(...args) {
    originalWarn.apply(console, args);
    broadcastLog('warn', args);
};
// ----------------------

// Configuration
const gdsConfig = {
    renderingEngine: 'webgl',
    fastModeThreshold: 10,
    labelFontSize: 12,
    portFontSize: 12,
    portArrowScale: 1.0,
    maxSteps: 5000,
    maxWorkers: -1,
    chunkSize: 2000,
    pythonPath: 'python', // Adjust if needed
    enableProfiling: false,
    flowControlStep: 5,
    useInstancing: true
};

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function generateHtml() {
    let webviewDir;
    if (app.isPackaged) {
        webviewDir = path.join(__dirname, 'webview-ui');
    } else {
        webviewDir = path.resolve(__dirname, '../webview-ui');
    }

    // Read workers
    const geometryWorkerPath = path.join(webviewDir, 'workers', 'geometry.js');
    const searchWorkerPath = path.join(webviewDir, 'workers', 'search.js');

    const svgPanZoomUri = "https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js";
    const earcutUri = "https://unpkg.com/earcut@2.2.4/dist/earcut.min.js";

    let geometryWorkerCode = fs.readFileSync(geometryWorkerPath, 'utf-8');
    geometryWorkerCode = `const earcutCdn = "${earcutUri}";\n` + geometryWorkerCode;

    const searchWorkerCode = fs.readFileSync(searchWorkerPath, 'utf-8');

    // Write workers to disk
    const geometryWorkerDest = path.join(app.getPath('userData'), 'geometry-worker.js');
    fs.writeFileSync(geometryWorkerDest, geometryWorkerCode);

    const searchWorkerDest = path.join(app.getPath('userData'), 'search-worker.js');
    fs.writeFileSync(searchWorkerDest, searchWorkerCode);

    // Read HTML
    const htmlPath = path.join(webviewDir, 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');

    const config = {
        engine: gdsConfig.renderingEngine,
        fastModeThreshold: gdsConfig.fastModeThreshold,
        labelFontSize: gdsConfig.labelFontSize,
        portFontSize: gdsConfig.portFontSize,
        portArrowScale: gdsConfig.portArrowScale,
        maxSteps: gdsConfig.maxSteps,
        maxWorkers: gdsConfig.maxWorkers,
        chunkSize: gdsConfig.chunkSize,
        pythonPath: gdsConfig.pythonPath,
        enableProfiling: gdsConfig.enableProfiling,
        flowControlStep: gdsConfig.flowControlStep,
        useInstancing: gdsConfig.useInstancing,
        workerUrl: `file://${geometryWorkerDest}`,
        searchWorkerUrl: `file://${searchWorkerDest}`
    };

    const configContent = `window.gdsConfig = ${JSON.stringify(config)};`;
    const configPath = path.join(app.getPath('userData'), 'config.js');
    fs.writeFileSync(configPath, configContent);

    const nonce = getNonce();

    // Use absolute paths for resources to support loading from userData
    const stylePath = path.join(webviewDir, 'style.css');
    const scriptPath = path.join(webviewDir, 'main.js');
    const themePath = path.join(__dirname, 'theme.css');

    const styleUri = `file://${stylePath}`;
    const scriptUri = `file://${scriptPath}`;
    const themeUri = `file://${themePath}`;
    const configUri = `file://${configPath}`;

    html = html.replace(/{{nonce}}/g, nonce);
    html = html.replace(/{{cspSource}}/g, "'self' https: data: blob: 'unsafe-inline' 'unsafe-eval' file:");
    html = html.replace(/{{styleUri}}/g, styleUri);
    // Note: theme.css is injected here, make sure it applies to viewer
    html = html.replace('</head>', `<link href="${themeUri}" rel="stylesheet" /></head>`);
    html = html.replace(/{{scriptUri}}/g, scriptUri);
    html = html.replace(/{{svgPanZoomUri}}/g, svgPanZoomUri);
    html = html.replace(/{{earcutUri}}"><\/script>/g, `{{earcutUri}}"></script><script src="${configUri}"></script>`);
    html = html.replace(/{{earcutUri}}/g, earcutUri);
    html = html.replace(/window.gdsConfig = {{gdsConfig}};/g, '// Config loaded from config.js');

    return html;
}

let currentTheme = 'auto'; // 'light', 'dark', 'auto'

function updateTheme() {
    let theme = currentTheme;
    if (theme === 'auto') {
        theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    }

    if (mainWindow) {
        mainWindow.webContents.send('theme-change', theme);

        if (process.platform === 'win32') {
            mainWindow.setTitleBarOverlay({
                color: theme === 'dark' ? '#252526' : '#f3f3f3',
                symbolColor: theme === 'dark' ? '#cccccc' : '#616161'
            });
        }
    }

    // Propagate to all views
    if (viewManager) {
        for (const view of viewManager.views.values()) {
            if (!view.browserView.webContents.isDestroyed()) {
                view.browserView.webContents.send('theme-change', theme);
            }
        }
    }
}

nativeTheme.on('updated', () => {
    if (currentTheme === 'auto') {
        updateTheme();
    }
});

function createMenu() {
    const template = [
        {
            label: 'File',
            submenu: [
                {
                    label: 'Open GDS...',
                    accelerator: 'CmdOrCtrl+O',
                    click: async () => {
                        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
                            properties: ['openFile', 'multiSelections'],
                            filters: [
                                { name: 'GDS Files', extensions: ['gds', 'gds2', 'oas'] },
                                { name: 'All Files', extensions: ['*'] }
                            ]
                        });
                        if (!canceled && filePaths.length > 0) {
                            filePaths.forEach(fp => viewManager.createTab(fp));
                        }
                    }
                },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { type: 'separator' },
                {
                    label: 'Toggle Shell DevTools',
                    accelerator: 'CmdOrCtrl+Shift+I',
                    click: () => {
                         if (mainWindow) {
                             const wc = mainWindow.webContents;
                             if (wc.isDevToolsOpened()) {
                                 wc.closeDevTools();
                             } else {
                                 wc.openDevTools({ mode: 'detach' });
                             }
                         }
                    }
                },
                {
                    label: 'Toggle View DevTools',
                    accelerator: 'CmdOrCtrl+Shift+U',
                    click: () => {
                        const view = viewManager.getActiveView();
                        if (view) {
                             const wc = view.browserView.webContents;
                             if (wc.isDevToolsOpened()) {
                                 wc.closeDevTools();
                             } else {
                                 wc.openDevTools({ mode: 'detach' });
                             }
                        }
                    }
                }
            ]
        },
        {
            label: 'Theme',
            submenu: [
                {
                    label: 'Auto',
                    type: 'radio',
                    checked: currentTheme === 'auto',
                    click: () => {
                        currentTheme = 'auto';
                        updateTheme();
                        viewManager.saveSession();
                    }
                },
                {
                    label: 'Light',
                    type: 'radio',
                    checked: currentTheme === 'light',
                    click: () => {
                        currentTheme = 'light';
                        updateTheme();
                        viewManager.saveSession();
                    }
                },
                {
                    label: 'Dark',
                    type: 'radio',
                    checked: currentTheme === 'dark',
                    click: () => {
                        currentTheme = 'dark';
                        updateTheme();
                        viewManager.saveSession();
                    }
                }
            ]
        },
        {
            label: 'Control',
            submenu: [
                {
                    label: 'Reset',
                    click: () => {
                        const view = viewManager.getActiveView();
                        if (view) {
                            view.browserView.webContents.send('webview-message', { command: 'reset' });
                        }
                    }
                },
                {
                    label: 'Stop Loading',
                    click: () => {
                        const view = viewManager.getActiveView();
                        if (view) {
                            view.browserView.webContents.send('webview-message', { command: 'stop' });
                        }
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

function createWindow() {
    createMenu();

    const isWindows = process.platform === 'win32';
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        titleBarStyle: isWindows ? 'hidden' : 'hiddenInset',
        titleBarOverlay: isWindows ? {
            color: '#252526',
            symbolColor: '#cccccc',
            height: 38
        } : undefined,
        trafficLightPosition: { x: 10, y: 10 },
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'shell-preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        }
    });

    const indexPath = path.join(__dirname, 'shell.html');
    mainWindow.loadURL(url.pathToFileURL(indexPath).toString());

    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
        console.error('Failed to load shell.html:', errorCode, errorDescription);
    });

    mainWindow.webContents.on('did-finish-load', () => {
        updateTheme();

        // Try to restore session
        const restored = viewManager.restoreSession();

        // If no session restored and no views, load blank
        if (!restored && viewManager.views.size === 0) {
             // Extract blank.gds from ASAR if needed, as Python cannot read from ASAR
             const blankSource = path.join(__dirname, 'blank.gds');
             const blankDest = path.join(app.getPath('userData'), 'blank.gds');

             try {
                 if (fs.existsSync(blankSource)) {
                     fs.copyFileSync(blankSource, blankDest);
                     viewManager.createTab(blankDest);
                 }
             } catch (e) {
                 console.error("Failed to extract blank.gds:", e);
             }
        }
    });

    mainWindow.on('resize', () => {
        viewManager.resizeActiveView();
    });

    mainWindow.on('closed', function () {
        viewManager.destroyAll();
        mainWindow = null;
    });
}

// IPC Handlers for Shell
ipcMain.on('shell-close-tab', (event, id) => {
    viewManager.closeTab(id);
});

ipcMain.on('shell-select-tab', (event, id) => {
    viewManager.setActiveTab(id);
});

ipcMain.on('shell-open-file', (event, filePath) => {
    viewManager.createTab(filePath);
});

ipcMain.on('shell-reorder-tabs', (event, newOrderIds) => {
    viewManager.reorderTabs(newOrderIds);
});

ipcMain.on('view-file-drop', (event, filePaths) => {
    filePaths.forEach(fp => viewManager.createTab(fp));
});

ipcMain.on('shell-open-dialog', async () => {
    console.log('IPC: shell-open-dialog');
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: 'GDS Files', extensions: ['gds', 'gds2', 'oas'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });
    if (!canceled && filePaths.length > 0) {
        filePaths.forEach(fp => viewManager.createTab(fp));
    }
});

ipcMain.on('shell-popup-menu', () => {
    const menu = Menu.getApplicationMenu();
    if (menu) {
        menu.popup({ window: mainWindow });
    }
});

ipcMain.on('shell-reload-active-view', () => {
    console.log('IPC: shell-reload-active-view');
    const view = viewManager.getActiveView();
    if (view) {
        view.browserView.webContents.send('webview-message', { command: 'reset' });
    }
});

ipcMain.on('shell-stop-active-view', () => {
    console.log('IPC: shell-stop-active-view');
    const view = viewManager.getActiveView();
    if (view) {
        view.browserView.webContents.send('webview-message', { command: 'stop' });
    }
});

// IPC Handlers from Viewers
ipcMain.on('vscode-message', (event, message) => {
    const view = viewManager.getViewByWebContentsId(event.sender.id);
    if (!view) return;

    switch (message.command) {
        case 'ready':
            console.log(`Webview ready (View ${view.id})`);
            view.runEngine(view.currentCell, view.isNegative);
            break;
        case 'changeCell':
            view.currentCell = message.cellName;
            view.runEngine(view.currentCell, view.isNegative);
            break;
        case 'reloadNegative':
            view.isNegative = message.isNegative;
            view.runEngine(view.currentCell, view.isNegative);
            break;
        case 'reset':
            view.isNegative = false;
            view.runEngine(view.currentCell);
            break;
        case 'stop':
            if (view.process) {
                view.process.kill();
                view.process = undefined;
                view.browserView.webContents.send('webview-message', { command: 'status', message: 'Stopped by user' });
            }
            break;
        case 'ready_for_next':
             if (view.process && view.process.stdin) {
                 view.process.stdin.write("\n");
             }
             break;
        case 'updateConfig':
             if (message.key && message.value !== undefined) {
                 console.log(`Config Update: ${message.key} = ${message.value}`);
                 gdsConfig[message.key] = message.value;
                 viewManager.saveSession();

                 if (['maxWorkers', 'chunkSize', 'flowControlStep', 'useInstancing'].includes(message.key)) {
                     viewManager.broadcastConfigChange();
                 } else if (['renderingEngine', 'pythonPath'].includes(message.key)) {
                     // For these we should probably just reload the current view's python
                     view.runEngine(view.currentCell, view.isNegative);
                 } else if (['fastModeThreshold', 'labelFontSize', 'portFontSize', 'portArrowScale', 'maxSteps'].includes(message.key)) {
                     const settings = {};
                     settings[message.key] = message.value;
                     // Broadcast settings to all views or just active? Usually all settings are global
                     for (const v of viewManager.views.values()) {
                        v.browserView.webContents.send('webview-message', {
                             command: 'updateSettings',
                             ...settings
                         });
                     }
                 }
             }
             break;
        case 'find':
             if (view.process && view.process.stdin) {
                 view.process.stdin.write(JSON.stringify(message) + "\n");
             }
             break;
    }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});