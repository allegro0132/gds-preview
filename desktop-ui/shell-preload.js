const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shellAPI', {
    closeTab: (id) => ipcRenderer.send('shell-close-tab', id),
    selectTab: (id) => ipcRenderer.send('shell-select-tab', id),
    openFile: (path) => ipcRenderer.send('shell-open-file', path),
    reorderTabs: (newOrderIds) => ipcRenderer.send('shell-reorder-tabs', newOrderIds),
    onUpdateTabs: (callback) => ipcRenderer.on('shell-update-tabs', (event, tabs) => callback(tabs)),
    onThemeChange: (callback) => ipcRenderer.on('theme-change', (event, theme) => callback(theme))
});

ipcRenderer.on('main-process-log', (event, type, message) => {
    if (console[type]) {
        console[type](`[Main] ${message}`);
    } else {
        console.log(`[Main] ${message}`);
    }
});
