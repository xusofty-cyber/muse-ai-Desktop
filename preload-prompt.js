// 备份密码输入窗口的 preload (2026-11-22 审查 H1)。只暴露读取提示内容与提交结果两个接口。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('promptAPI', {
  getOptions: () => ipcRenderer.invoke('prompt:get-options'),
  submit: (value) => ipcRenderer.send('prompt:submit', typeof value === 'string' ? value : null),
  cancel: () => ipcRenderer.send('prompt:submit', null),
});
