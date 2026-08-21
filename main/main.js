// main/main.js
const path = require('path');
const { app, ipcMain } = require('electron');
const { createMainWindow } = require('./window');
const ipc = require('./ipc');
const store = require('./store');
const createTray = require('./tray');
const hotkeys = require('./hotkeys');
const initTabManager = require('./tabs');

const userDataDir = app.getPath('userData');
let win, mode = 'ad';
let tray = null; // 模块级引用，防止托盘对象被 GC 后图标消失

app.whenReady().then(() => {
  win = createMainWindow(userDataDir);
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
  const applyMode = (m) => { mode = m; tabsApi.setMode(m); };
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
  });

  win.on('closed', () => app.quit());

  // 全局热键：回调表注入一次，注册/改键共用（Ruling B）
  hotkeys.setCallbacks({
    toggleWindow: () => win.isVisible() ? win.hide() : win.show(),
    toggleMode: () => {
      applyMode(mode === 'ad' ? 'content' : 'ad');
      win.webContents.send('mode:set', mode);
    },
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
