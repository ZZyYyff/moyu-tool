// preload/preload.js
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, cb) => ipcRenderer.on(channel, (_e, data) => cb(data)),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
