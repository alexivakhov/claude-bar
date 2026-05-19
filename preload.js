const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('claudeBar', {
  onUpdate:  (cb) => ipcRenderer.on('usage-update', (_, data) => cb(data)),
  openLogin: () => ipcRenderer.send('open-login'),
  resize:    (w, h) => ipcRenderer.send('window-resize', { w, h }),
});
