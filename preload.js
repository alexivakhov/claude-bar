const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('claudeBar', {
  onUpdate:  (cb) => ipcRenderer.on('usage-update', (_, data) => cb(data)),
  // B7b: forward non-reauth errors to renderer for stale indicator
  onError:   (cb) => ipcRenderer.on('usage-error', (_, err) => cb(err)),
  // Poll interval and other settings pushed from main
  onConfig:  (cb) => ipcRenderer.on('config-update', (_, cfg) => cb(cfg)),
  // Quiet daily update check found a newer release
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_, info) => cb(info)),
  onHistoryUpdate: (cb) => ipcRenderer.on('history-update', (_, data) => cb(data)),
  openLogin: () => ipcRenderer.send('open-login'),
  refresh:   () => ipcRenderer.send('manual-refresh'),
  installUpdate: () => ipcRenderer.send('install-update'),
  resize:    (w, h) => ipcRenderer.send('window-resize', { w, h }),
  setPin:    (pinned) => ipcRenderer.send('pin-toggle', pinned),
});
