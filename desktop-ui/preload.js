const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('acquireVsCodeApi', () => {
    return {
        postMessage: (message) => {
            ipcRenderer.send('vscode-message', message);
        },
        getState: () => { return {}; },
        setState: (state) => { }
    };
});

// Forward messages from main process to renderer window
ipcRenderer.on('webview-message', (event, data) => {
    window.postMessage(data, '*');
});

ipcRenderer.on('theme-change', (event, theme) => {
    if (theme === 'dark') {
        document.body.classList.add('dark-theme');
        document.body.classList.remove('light-theme');
    } else {
        document.body.classList.add('light-theme');
        document.body.classList.remove('dark-theme');
    }
});

ipcRenderer.on('main-process-log', (event, type, message) => {
    if (console[type]) {
        console[type](`[Main] ${message}`);
    } else {
        console.log(`[Main] ${message}`);
    }
});

window.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
});

window.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    // We only support file drops
    if (e.dataTransfer.files.length > 0) {
        const filePaths = Array.from(e.dataTransfer.files).map(f => f.path);
        ipcRenderer.send('view-file-drop', filePaths);
    }
});
