// main/ipc.js
const { ipcMain } = require('electron');
const store = require('./store');

// 注册底座 IPC 通道。参数由 main.js 装配时注入：
// { userDataDir, shellWin, getMode, setMode, getTabsSnapshot }
function register({ userDataDir, shellWin, getMode, setMode, getTabsSnapshot }) {
  ipcMain.handle('shell:ready', () => ({
    settings: store.loadSettings(userDataDir),
    mode: getMode(),
    tabs: getTabsSnapshot(),
  }));
  ipcMain.on('mode:set', (_e, mode) => setMode(mode));
  ipcMain.handle('settings:get', () => store.loadSettings(userDataDir));
  ipcMain.handle('settings:save', (_e, partial) => {
    const s = { ...store.loadSettings(userDataDir), ...partial };
    store.saveSettings(s, userDataDir);
    shellWin.webContents.send('settings:changed', s);
    return s;
  });
}

module.exports = { register };
