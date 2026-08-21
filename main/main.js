// main/main.js
const { app, ipcMain } = require('electron');
const { createMainWindow } = require('./window');
const ipc = require('./ipc');
const store = require('./store');
const createTray = require('./tray');

const userDataDir = app.getPath('userData');
let win, mode = 'ad';
let tray = null; // 模块级引用，防止托盘对象被 GC 后图标消失

app.whenReady().then(() => {
  win = createMainWindow(userDataDir);
  const shellWin = win; // 壳层即主窗口
  ipc.register({
    userDataDir,
    shellWin,
    getMode: () => mode,
    setMode: (m) => { mode = m; },
    getTabsSnapshot: () => [],
  });

  // 假关闭按钮 → 真正收进托盘（Task 5 遗留的 handler）
  ipcMain.on('window:hide', () => win.hide());

  // 系统托盘：左键隐藏/恢复；右键菜单 显示窗口/切回内容/伪装样式/设置/退出
  tray = createTray({
    getWindow: () => win,
    getMode: () => mode,
    setMode: (m) => { mode = m; win.webContents.send('mode:set', m); },
    switchStyle: (key) => {
      // 复用 ipc settings:save 的逻辑：合并保存 + 通知壳层重渲染
      const s = { ...store.loadSettings(userDataDir), adStyle: key };
      store.saveSettings(s, userDataDir);
      win.webContents.send('settings:changed', s);
    },
    openSettings: () => win.webContents.send('open-settings'),
  });

  win.on('closed', () => app.quit());
});

app.on('window-all-closed', () => app.quit());
