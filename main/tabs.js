// main/tabs.js
const { app, WebContentsView } = require('electron');

const TABBAR_H = 34, ADDRBAR_H = 32;

// 用户反馈修复：剥离 UA 中的 "Electron/x.y" 标记。带该标记时，B 站等站点
// 强制桌面布局（min-width 1100px），窗口再窄也不跟随；普通 Chrome UA 在
// 窄视口下会切移动布局，页面随窗口缩放 —— 与浏览器体验一致。
// 注意：app.userAgent 在 app ready 之前是 undefined，main.js 顶层 require 本模块
// 时求值会崩 —— 惰性计算，且仅在创建标签时（必然在 ready 之后）使用。
let chromeUA = null;
function getChromeUA() {
  if (!chromeUA && app.userAgent) chromeUA = app.userAgent.replace(/\sElectron\/[\d.]+/i, '');
  return chromeUA;
}

module.exports = function initTabManager({ win, userDataDir, notify }) {
  let nextId = 1;
  let activeId = null;
  let mode = 'ad';
  const tabs = new Map(); // id -> Tab
  let addressBarVisible = false;

  const currentView = () => { const t = tabs.get(activeId); return t && t.type === 'web' ? t.view : null; };

  function viewBounds() {
    const [w, h] = win.getContentSize();
    const y = TABBAR_H + (addressBarVisible ? ADDRBAR_H : 0);
    return { x: 0, y, width: w, height: Math.max(0, h - y) };
  }

  function layout() {
    const v = currentView();
    if (v && mode === 'content') {
      v.setBounds(viewBounds());
      fitToWindow(tabs.get(activeId)); // 用户反馈修复：缩放适配（防抖，仅溢出时生效）
    }
  }

  // 用户反馈修复：小窗口下固定布局站点（如 B 站 min-width 1100px）内容溢出视口，
  // "网页不完整"。设计要点（探针实测修正）：
  // - 缩放后页面会在更大 CSS 视口里重新排版填满，测量值随 zoom 漂移 → 只在 zoom=1
  //   时测量并记忆页面真实宽度 tab.fitNeed；缩放期间凭记忆判断，永不振荡。
  // - 恢复带 5% 迟滞：物理宽度 >= fitNeed*1.05 才回 1:1。
  // - 响应式站点 zoom=1 时无溢出 → 永不触发。
  let fitTimer = null;
  function fitToWindow(tab) {
    const view = tab && tab.view;
    if (!view || view.webContents.isDestroyed()) return;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(async () => {
      const wc = view.webContents;
      try {
        const m = await wc.executeJavaScript(
          '({ cw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth })'
        );
        if (typeof m.cw !== 'number' || typeof m.sw !== 'number' || !m.cw) return;
        const zoom = wc.getZoomFactor();
        if (zoom >= 0.999) {
          if (m.sw > m.cw + 20) {
            tab.fitNeed = m.sw; // 记忆 zoom=1 时的真实内容宽度
            wc.setZoomFactor(Math.max(0.25, m.cw / m.sw)); // 溢出 → 缩小到恰好容纳（下限 0.25）
          } else {
            tab.fitNeed = null;
          }
        } else if (tab.fitNeed && m.cw * zoom >= tab.fitNeed * 1.03) {
          // 物理宽度 >= 记忆宽度×1.03 → 恢复 1:1 并重新评估（3% 迟滞：默认内容窗
          // 1150px 对 B 站 1100px min-width 恰好能复位；5% 时差 3px 卡住 —— 探针实测修正。
          // 复位后重排一轮：fitNeed 会更新为真实宽度，收敛无振荡）
          wc.setZoomFactor(1);
          fitToWindow(tab);
        } else if (m.sw > m.cw + 20) {
          // 已缩放但仍溢出：记忆的 fitNeed 过期（懒加载/二次布局）→ 重置重测，一轮收敛
          wc.setZoomFactor(1);
          tab.fitNeed = null;
          fitToWindow(tab);
        }
      } catch { /* 页面不可评估（导航中/已卸载）忽略 */ }
    }, 150);
  }

  function attach() {
    const t = tabs.get(activeId);
    if (!t || t.type !== 'web' || !t.view || mode !== 'content') return;
    if (t.failed) return; // 加载失败的标签不挂视图，让 DOM 错误页可见（仅 tabs:reload-active 重试成功后恢复）
    if (win.contentView.children.includes(t.view)) { t.view.setBounds(viewBounds()); fitToWindow(t); return; } // 已挂载：只更新 bounds
    win.contentView.addChildView(t.view);
    t.view.setBounds(viewBounds());
    fitToWindow(t); // 挂载后立即评估缩放（attach 不走 layout，探针实测缺这一步 fit 不触发）
  }

  function detachAll() {
    for (const t of tabs.values()) if (t.view && win.contentView.children.includes(t.view)) win.contentView.removeChildView(t.view);
  }

  function setMode(m) { mode = m; if (m === 'ad') detachAll(); else attach(); }

  function createWebTab(url) {
    // 规格 §8：仅放行 http/https（与 will-navigate / window.open 拦截一致；
    // renderer 拖放/地址栏已预校验，此处是主进程入口兜底）
    if (typeof url !== 'string' || !/^https?:/i.test(url)) return null;
    const id = nextId++;
    const view = new WebContentsView({
      webPreferences: {
        partition: `persist:tab-${id}`,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    const tab = { id, type: 'web', url, title: url, muted: true, failed: false, view };
    tabs.set(id, tab);
    const ua = getChromeUA(); if (ua) view.webContents.setUserAgent(ua);
    view.webContents.setAudioMuted(true);
    view.webContents.setWindowOpenHandler(({ url: u }) => {
      if (/^https?:/i.test(u)) createWebTab(u);
      return { action: 'deny' };
    });
    view.webContents.on('will-navigate', (e, u) => {
      if (!/^https?:/i.test(u)) e.preventDefault();
    });
    view.webContents.on('did-fail-load', (e, code, desc, validatedUrl, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        e.preventDefault(); // 抑制原生错误页，由 DOM 错误页（tab:error）接管
        tab.failed = true;
        if (win.contentView.children.includes(view)) win.contentView.removeChildView(view);
        notify({ type: 'tab:error', id, code, description: desc, url: validatedUrl });
      }
    });
    // 注意：错误页（chrome-error 提交）也会触发 did-finish-load，此时 tab.failed 仍为 true，
    // 不能在这里清 failed —— 只有 tabs:reload-active（重试）会清除 failed 并重新挂载。
    view.webContents.on('did-finish-load', () => { if (!tab.failed && activeId === id) attach(); });
    // 评审修正：失败标签的唯一恢复时机是"真实成功导航提交"。实测 chrome-error 提交不触发
    // did-navigate（仅 did-start-navigation/did-finish-load），故这里清 failed 安全：
    // 后退到历史页 / 重试成功 / 页内新导航成功 → 重新挂载；错误页提交 → 不会走到这里。
    // Task 12：url 变化时 push（tabs:changed → persistTabs 落盘 lastTabs），保证导航后退出能恢复最终地址；
    // 重试成功（url 未变）不 push —— failed 清除逻辑在 push 之外，不受影响。
    view.webContents.on('did-navigate', (_e, u) => {
      if (tab.url !== u) { tab.url = u; push(); }
      if (tab.failed) { tab.failed = false; if (activeId === id) attach(); }
    });
    view.webContents.on('page-title-updated', (_e, t) => { tab.title = t; push(); });
    // 加载完成后重置缩放并按 zoom=1 重新测量适配（等布局稳定，懒加载站点可能二次布局）
    view.webContents.on('did-finish-load', () => {
      view.webContents.setZoomFactor(1);
      tab.fitNeed = null;
      setTimeout(() => fitToWindow(tab), 1500);
    });
    activateTab(id);
    view.webContents.loadURL(url).catch(() => {});
    return id;
  }

  function createNovelTab(novel) {
    const id = nextId++;
    tabs.set(id, { id, type: 'novel', novelId: novel.novelId, title: novel.title, muted: true });
    activateTab(id);
    return id;
  }

  function closeTab(id) {
    const t = tabs.get(id);
    if (!t) return;
    if (t.type === 'web' && t.view) {
      if (win.contentView.children.includes(t.view)) win.contentView.removeChildView(t.view);
      t.view.webContents.close();
    }
    tabs.delete(id);
    if (activeId === id) activeId = tabs.size ? [...tabs.keys()][tabs.size - 1] : null;
    if (activeId !== null) activateTab(activeId);
    push();
  }

  function activateTab(id) {
    if (!tabs.has(id)) return;
    if (activeId !== null && activeId !== id) {
      const prev = tabs.get(activeId);
      if (prev.type === 'web' && prev.view) {
        win.contentView.removeChildView(prev.view);
        prev.view.webContents.setAudioMuted(true);
      }
    }
    activeId = id;
    const t = tabs.get(id);
    if (t.type === 'web' && t.view) {
      t.view.webContents.setAudioMuted(false);
      attach();
    }
    push();
  }

  function navigate(delta) {
    const t = tabs.get(activeId);
    if (t && t.type === 'web' && t.view) {
      if (delta < 0) t.view.webContents.navigationHistory.goBack();
      else t.view.webContents.navigationHistory.goForward();
    }
  }

  function setAddressBarVisible(v) { addressBarVisible = v; layout(); }

  function getSnapshot() {
    // 含 novelId（brief 代码遗漏，Ruling A 需要）：novel 标签切到阅读器时 switchActiveTab 凭 novelId 查 window.__novels
    // Task 12：快照补 url —— persistTabs 持久化 lastTabs 时取 t.url（did-navigate 已维护）
    return [...tabs.values()].map(t => ({ id: t.id, type: t.type, title: t.title, active: t.id === activeId, muted: t.muted, novelId: t.novelId, url: t.url }));
  }

  function push() { notify({ type: 'tabs:changed', tabs: getSnapshot(), activeId }); }

  win.on('resize', layout);

  return {
    createWebTab, createNovelTab, closeTab, activateTab, getSnapshot,
    setMode, layout, navigate, getActiveTabId: () => activeId,
    setAddressBarVisible, getTab: (id) => tabs.get(id),
  };
};
