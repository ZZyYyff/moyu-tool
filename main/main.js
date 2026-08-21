// main/main.js
const { app } = require('electron');
const { createMainWindow } = require('./window');
const ipc = require('./ipc');

const userDataDir = app.getPath('userData');
let win, mode = 'ad';

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
  win.on('closed', () => app.quit());
});

app.on('window-all-closed', () => app.quit());
