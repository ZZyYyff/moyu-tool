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
    // 裁定 AB（透明背景模式）：窗口恒为 Windows 分层透明窗口（创建时 transparent: true），
    // 背景固定全透明 —— 不透明度完全由渲染层 CSS 控制（阅读器纸白/暗色/透明、广告主题、
    // 网页自带背景）；探针实测无边框/置顶/缩放/WebView 均正常。
    // 不用运行时 setBackgroundColor 切透明：Windows 分层窗口上运行时切换不可靠（用户实测仍有窗口）。
    transparent: true,
    backgroundColor: '#00000000',
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

// 模式切换的位置连续性：目标 bounds 只取尺寸，位置以当前窗口右下角为锚。
// 若按双槽各自恢复位置，两槽位置分叉（如内容模式拖动过窗口、伪装槽仍在默认右下角）时
// 悬停揭示会无限振荡——光标悬在伪装窗上，内容窗却 setBounds 到另一处，200ms 轮询
// 随即判定"移开"再切回，窗口在两个位置间闪烁。右下角锚点与双尺寸默认定位（右下 16px）
// 几何一致：默认状态下切换前后窗口右下角重合，行为与双槽恢复完全相同。
function anchorBottomRight(current, target) {
  return { ...target, x: current.x + current.width - target.width, y: current.y + current.height - target.height };
}

// 锚定后可能越出工作区（如伪装小窗停在屏幕边缘，放大成内容大窗）——收进窗口当前
// 所在显示器的工作区；窗口某维大于工作区时该维对齐工作区左上。收敛方向只向左/上，
// 悬停揭示放大窗口时光标仍落在新窗口内。
function clampToWorkArea(bounds, workArea) {
  const x = bounds.width >= workArea.width
    ? workArea.x
    : Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - bounds.width);
  const y = bounds.height >= workArea.height
    ? workArea.y
    : Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - bounds.height);
  return { ...bounds, x: Math.round(x), y: Math.round(y) };
}

// Ruling Z：切模式时把窗口 setBounds 到该模式的记忆尺寸；位置按当前窗口右下角锚定
// （见 anchorBottomRight）。setBounds 触发 resize → 持久化防抖把锚定后的 bounds 写回
// 当前模式槽位，两槽位置自然收敛，历史分叉的存量设置在首次切换时即被治愈。
function applyBoundsForMode(mode, userDataDir) {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (mainWin.isMaximized()) mainWin.unmaximize();
  const settings = store.loadSettings(userDataDir);
  const current = mainWin.getBounds(); // unmaximize 后即还原的常规 bounds
  const target = computeModeBounds(mode, screen.getPrimaryDisplay().workArea, settings);
  const workArea = screen.getDisplayMatching(current).workArea; // 不跨显示器跳变
  mainWin.setBounds(clampToWorkArea(anchorBottomRight(current, target), workArea));
}

module.exports = {
  computeDefaultBounds,
  computeModeBounds,
  createMainWindow,
  applyBoundsForMode,
  anchorBottomRight,
  clampToWorkArea,
};
