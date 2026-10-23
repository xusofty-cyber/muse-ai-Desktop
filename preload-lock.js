const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lockAPI', {
  unlock: (password) => ipcRenderer.invoke('lock:unlock', password),
  getStatus: () => ipcRenderer.invoke('lock:get-status'),
  getLocale: () => ipcRenderer.invoke('locale-get'),
});
