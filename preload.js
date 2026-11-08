const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  isElectron: true,
  setMode: (mode, dims) => ipcRenderer.send('window-mode', { mode, dims }),
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  toggleTopmost: () => ipcRenderer.send('window-topmost'),
  onModeSync: (cb) => ipcRenderer.on('window-mode-sync', (_e, mode) => cb(mode)),
  getUpdateStatus: () => ipcRenderer.invoke('update-get-status'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  onUpdateStatus: (cb) => {
    const listener = (_event, status) => cb(status);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  }
});
