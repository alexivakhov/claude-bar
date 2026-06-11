const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('claudeBar', {
  onUpdate:  (cb) => ipcRenderer.on('usage-update', (_, data) => cb(data)),
  // B7b: forward non-reauth errors to renderer for stale indicator
  onError:   (cb) => ipcRenderer.on('usage-error', (_, err) => cb(err)),
  openLogin: () => ipcRenderer.send('open-login'),
  resize:    (w, h) => ipcRenderer.send('window-resize', { w, h }),
  setPin:    (pinned) => ipcRenderer.send('pin-toggle', pinned),
});
