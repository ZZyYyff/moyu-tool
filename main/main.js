// main/main.js
const path = require('path');
const { app, ipcMain, screen } = require('electron');
const windowApi = require('./window');
const ipc = require('./ipc');
const store = require('./store');
const createTray = require('./tray');
const hotkeys = require('./hotkeys');
const initTabManager = require('./tabs');

const userDataDir = app.getPath('userData');
let win, mode = 'ad';
let tray = null; // 模块级引用，防止托盘对象被 GC 后图标消失

app.whenReady().then(() => {
  win = windowApi.createMainWindow(userDataDir, { getMode: () => mode });
  const shellWin = win; // 壳层即主窗口
  // Task 12：lastTabs 持久化 —— 内容比较去重：只在标签集合或 web 标签 url 实际变化时写盘。
  // 激活/标题变化虽触发 tabs:changed，但映射后内容不变 → 零写盘（去重选择，报告说明）。
  let lastPersistedTabs = null;
  function persistTabs() {
    const mapped = tabsApi.getSnapshot()
      .filter((t) => (t.type === 'web' ? t.url : t.novelId))
      .map((t) => (t.type === 'web' ? { type: 'web', url: t.url } : { type: 'novel', novelId: t.novelId }));
    const json = JSON.stringify(mapped);
    if (json === lastPersistedTabs) return;
    lastPersistedTabs = json;
    const s = store.loadSettings(userDataDir);
    s.lastTabs = mapped;
    store.saveSettings(s, userDataDir);
  }
  // Task 10：WebContentsView 多标签管理（notify 把标签快照/加载错误推给壳层渲染）
  const tabsApi = initTabManager({
    win,
    userDataDir,
    notify: (msg) => {
      if (msg.type === 'tabs:changed') { win.webContents.send('tabs:changed', msg); persistTabs(); }
      if (msg.type === 'tab:error') win.webContents.send('tab:error', msg);
    },
  });
  // 模式切换统一入口：更新 mode 状态 + tabsApi.setMode（ad → detachAll / content → attach 当前标签）
  // + Ruling Z：窗口 setBounds 到该模式的记忆尺寸（window 模块顶层 require，无循环依赖）
  const applyMode = (m) => {
    mode = m;
    tabsApi.setMode(m);
    windowApi.applyBoundsForMode(m, userDataDir);
    // 裁定 AB 修正：窗口恒透明，不透明度由渲染层 CSS 控制（reader data-transparent），主进程不再管背景
  };

  // 悬停揭示（brainstorming 2026-08-21）：鼠标悬停窗口显示内容、移开立即切回伪装。
  // 立即切换（用户裁定）；设置开关 hoverReveal 可关（默认开）。主进程驱动 →
  // 需显式推送 mode:set 让壳层同步 DOM（与托盘/热键路径一致）。
  // 实现用轮询而非 mouse-enter/mouse-leave：实测 Electron 43 + Windows 无边框窗口
  // 上这两个事件不触发（终端零输出，用户实测确认），轮询 getCursorScreenPoint 可靠。
  // 裁定 AB：透明背景模式开启期间整体停用（用户要求：透明模式不被悬停隐藏打断）。
  const hoverEnabled = () => {
    const s = store.loadSettings(userDataDir);
    return s.hoverReveal !== false && !(s.reader && s.reader.transparent);
  };
  const launchedAt = Date.now(); // 启动 2s 宽限：光标恰好停在弹窗位置时不立刻揭开伪装
  let hoverInside = null; // 上次判定结果，状态未变不重复切换
  const hoverTimer = setInterval(() => {
    if (win.isDestroyed()) return;
    if (!win.isVisible()) return; // 托盘隐藏期间不判定
    if (Date.now() - launchedAt < 2000) return;
    const cursor = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const inside = cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height;
    if (inside === hoverInside) return;
    hoverInside = inside;
    if (inside) {
      if (hoverEnabled() && mode === 'ad') { applyMode('content'); win.webContents.send('mode:set', 'content'); }
    } else {
      if (hoverEnabled() && mode === 'content') { applyMode('ad'); win.webContents.send('mode:set', 'ad'); }
    }
  }, 200);

  ipc.register({
    userDataDir,
    shellWin,
    getMode: () => mode,
    setMode: applyMode,
    getTabsSnapshot: () => tabsApi.getSnapshot(),
    tabs: tabsApi,
  });

  // Task 12：会话恢复 —— 按 settings.lastTabs 顺序重建标签（窗口位置/阅读进度分别由 window.js、reader 恢复，不重复）。
  // lastPersistedTabs 种子 = 盘上内容：恢复触发的 tabs:changed → persistTabs 内容相同 → 不写盘（幂等）。
  // novel 标签依赖 lastNovels 元数据：重建 novelsMeta（Ruling C 结构）供 novels:chapter 取 storedPath；
  // 元数据缺失（如 novels 目录被清）则跳过该标签，不崩溃。
  const settings = store.loadSettings(userDataDir);
  lastPersistedTabs = JSON.stringify(settings.lastTabs || []);
  for (const t of settings.lastTabs) {
    if (t.type === 'web' && t.url) {
      tabsApi.createWebTab(t.url);
    } else if (t.type === 'novel' && settings.lastNovels && settings.lastNovels[t.novelId]) {
      const novel = settings.lastNovels[t.novelId];
      ipc.novelsMeta.set(t.novelId, { novel, storedPath: ipc.novelStoredPath(t.novelId, userDataDir) });
      tabsApi.createNovelTab(novel);
    }
  }

  // 假关闭按钮 → 真正收进托盘（Task 5 遗留的 handler）
  ipcMain.on('window:hide', () => win.hide());

  // 规格 §7：隐藏/关闭时强制写盘 —— 主进程驱动（实测 Electron 43 + Windows 上 hide()
  // 不触发渲染进程 visibilitychange，故由主进程监听 hide/close 推送 flush，渲染器收到后 saveNow）
  const flushProgress = () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send('app:flush-progress');
  };
  win.on('hide', flushProgress);
  win.on('close', flushProgress);

  // 系统托盘：左键隐藏/恢复；右键菜单 显示窗口/切回内容/伪装样式/设置/退出
  tray = createTray({
    getWindow: () => win,
    getMode: () => mode,
    setMode: (m) => { applyMode(m); win.webContents.send('mode:set', m); },
    switchStyle: (key) => {
      // 复用 ipc settings:save 的逻辑：合并保存 + 通知壳层重渲染
      const s = { ...store.loadSettings(userDataDir), adStyle: key };
      store.saveSettings(s, userDataDir);
      win.webContents.send('settings:changed', s);
    },
    openSettings: () => win.webContents.send('open-settings'),
    // Task 13：托盘"伪装样式"radio 按当前设置勾选（每次右键重建菜单时取最新值）
    getStyle: () => store.loadSettings(userDataDir).adStyle,
  });

  win.on('closed', () => { clearInterval(hoverTimer); app.quit(); });

  // 全局热键：回调表注入一次，注册/改键共用（Ruling B）；裁定 AB 扩展三槽
  hotkeys.setCallbacks({
    toggleWindow: () => win.isVisible() ? win.hide() : win.show(),
    toggleMode: () => {
      applyMode(mode === 'ad' ? 'content' : 'ad');
      win.webContents.send('mode:set', mode);
    },
    toggleTransparent: () => {
      const s = store.loadSettings(userDataDir);
      s.reader = { ...(s.reader || {}), transparent: !(s.reader && s.reader.transparent) };
      store.saveSettings(s, userDataDir);
      win.webContents.send('settings:changed', s); // 壳层 applyReaderPrefs → data-transparent → CSS 透明
    },
    pageUp: () => win.webContents.send('reader:page', -1),
    pageDown: () => win.webContents.send('reader:page', 1),
  });
  hotkeys.registerHotkeys({
    getWindow: () => win,
    toggleMode: () => { applyMode(mode === 'ad' ? 'content' : 'ad'); win.webContents.send('mode:set', mode); },
    notifyConflict: (acc) => console.warn('热键冲突，未注册:', acc),
    userDataDir,
  });
});

app.on('will-quit', () => hotkeys.unregisterHotkeys());

app.on('window-all-closed', () => app.quit());
