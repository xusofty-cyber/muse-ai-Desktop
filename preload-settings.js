const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hotkeyAPI', {
  get: () => ipcRenderer.invoke('hotkeys-get'),
  set: (bindings) => ipcRenderer.invoke('hotkeys-set', bindings),
});

contextBridge.exposeInMainWorld('automationAPI', {
  get: () => ipcRenderer.invoke('automation-get'),
  set: (updates) => ipcRenderer.invoke('automation-set', updates),
  toggleSite: (hostname, enabled) => ipcRenderer.invoke('automation-toggle-site', hostname, enabled),
  setAction: (actionKey, enabled) => ipcRenderer.invoke('automation-set-action', actionKey, enabled),
  setSiteAction: (hostname, actionKey, enabled) => ipcRenderer.invoke('automation-set-site-action', hostname, actionKey, enabled),
});

contextBridge.exposeInMainWorld('proxyAPI', {
  get: () => ipcRenderer.invoke('proxy-get'),
  set: (config) => ipcRenderer.invoke('proxy-set', config),
});

contextBridge.exposeInMainWorld('settingsTabAPI', {
  onSwitchTab: (callback) => {
    ipcRenderer.on('switch-tab', (e, tabId) => {
      if (typeof callback === 'function') callback(tabId);
    });
  },
});

contextBridge.exposeInMainWorld('themeAPI', {
  get: () => ipcRenderer.invoke('theme-get'),
  set: (theme) => ipcRenderer.invoke('theme-set', theme),
  onChanged: (callback) => {
    ipcRenderer.on('theme:changed', (e, t) => {
      if (typeof callback === 'function') callback(t);
    });
  },
});

contextBridge.exposeInMainWorld('uiAPI', {
  get: () => ipcRenderer.invoke('ui-settings-get'),
  set: (settings) => ipcRenderer.invoke('ui-settings-set', settings),
  onChanged: (callback) => {
    ipcRenderer.on('ui-settings:changed', (e, u) => {
      if (typeof callback === 'function') callback(u);
    });
  },
});

