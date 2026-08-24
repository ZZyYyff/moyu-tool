// main/window.js
const { BrowserWindow, screen } = require('electron');
const store = require('./store');

// Ruling Z：两种模式各自独立的默认窗口尺寸
const AD_SIZE = { width: 340, height: 280 }; // 伪装模式 = 广告小窗
const CONTENT_SIZE = { width: 1150, height: 750 }; // 内容模式 = 桌面尺寸

let mainWin = null; // Ruling Z：applyBoundsForMode 需访问当前主窗口

function computeDefaultBounds(workArea, winW, winH) {
  return {
    x: Math.max(0, workArea.width - winW - 16),
    y: Math.max(0, workArea.height - winH - 16),
    width: winW,
    height: winH,
  };
}

// Ruling Z：按模式计算窗口 bounds —— 'ad' 用伪装小窗（记忆 adBounds 或默认 340×280），
// 'content' 用桌面尺寸（记忆 contentBounds 或默认 1150×750）；未知模式回落 'ad' 逻辑。
function computeModeBounds(mode, workArea, settings) {
  if (mode === 'content') {
    return settings.contentBounds || computeDefaultBounds(workArea, CONTENT_SIZE.width, CONTENT_SIZE.height);
  }
  return settings.adBounds || computeDefaultBounds(workArea, AD_SIZE.width, AD_SIZE.height);
}

function createMainWindow(userDataDir, { getMode }) {
  const settings = store.loadSettings(userDataDir);
  const workArea = screen.getPrimaryDisplay().workArea;
  const bounds = settings.adBounds || computeDefaultBounds(workArea, AD_SIZE.width, AD_SIZE.height);

  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    minWidth: 300,
    minHeight: 240,
    // 裁定 AB（透明背景模式）：Windows 分层窗口——只有创建时 transparent: true，
    // 运行时 setBackgroundColor(alpha 0) 才能透出桌面；探针实测无边框/置顶/缩放/WebView 均正常
    transparent: true,
    backgroundColor: '#f7f5ef',
    webPreferences: {
      preload: require('path').join(__dirname, '..', 'preload', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWin = win;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile('renderer/index.html');

  // 位置/尺寸持久化（移动或缩放结束时保存一次；Ruling Z：写入当前模式的槽位，
  // 最大化期间不持久化）
  let saveTimer = null;
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      if (win.isMaximized()) return;
      const s = store.loadSettings(userDataDir);
      const b = win.getBounds();
      if (getMode() === 'content') s.contentBounds = b;
      else s.adBounds = b;
      store.saveSettings(s, userDataDir);
    }, 300);
  };
  win.on('move', persist);
  win.on('resize', persist);
  return win;
}

// Ruling Z：切模式时把窗口 setBounds 到该模式的记忆尺寸。
// setBounds 触发 resize → 持久化防抖写回同值（幂等，无副作用）。
function applyBoundsForMode(mode, userDataDir) {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (mainWin.isMaximized()) mainWin.unmaximize();
  const workArea = screen.getPrimaryDisplay().workArea;
  const settings = store.loadSettings(userDataDir);
  mainWin.setBounds(computeModeBounds(mode, workArea, settings));
}

module.exports = { computeDefaultBounds, computeModeBounds, createMainWindow, applyBoundsForMode };
