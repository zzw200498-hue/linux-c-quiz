/**
 * 预加载脚本：只把「窗口控制」这几个动作暴露给页面，不给页面 node 权限。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  min: () => ipcRenderer.send('quiz:min'),
  max: () => ipcRenderer.send('quiz:max'),
  close: () => ipcRenderer.send('quiz:close'),
  ws: () => ipcRenderer.invoke('quiz:ws'),
  pickWorkspace: () => ipcRenderer.invoke('quiz:open-ws'),
});
