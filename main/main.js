const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 340, height: 280,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    minWidth: 300, minHeight: 240,
    webPreferences: {
      preload: require('path').join(__dirname, '..', 'preload', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('renderer/index.html');
  win.setAlwaysOnTop(true, 'screen-saver');
  win.on('closed', () => app.quit());
});

app.on('window-all-closed', () => app.quit());
