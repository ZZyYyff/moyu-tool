// main/window.js
const { BrowserWindow, screen } = require('electron');
const store = require('./store');

function computeDefaultBounds(workArea, winW, winH) {
  return {
    x: Math.max(0, workArea.width - winW - 16),
    y: Math.max(0, workArea.height - winH - 16),
    width: winW,
    height: winH,
  };
}

function createMainWindow(userDataDir) {
  const settings = store.loadSettings(userDataDir);
  const workArea = screen.getPrimaryDisplay().workArea;
  const bounds = settings.windowBounds || computeDefaultBounds(workArea, 340, 280);

  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    minWidth: 300,
    minHeight: 240,
    webPreferences: {
      preload: require('path').join(__dirname, '..', 'preload', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile('renderer/index.html');

  // 位置/尺寸持久化（移动或缩放结束时保存一次）
  let saveTimer = null;
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const s = store.loadSettings(userDataDir);
      s.windowBounds = win.getBounds();
      store.saveSettings(s, userDataDir);
    }, 300);
  };
  win.on('move', persist);
  win.on('resize', persist);
  return win;
}

module.exports = { computeDefaultBounds, createMainWindow };
