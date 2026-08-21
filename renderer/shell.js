// renderer/shell.js
const $ = (sel) => document.querySelector(sel);

// Ruling A（前半）：壳层维护 novel 元数据内存缓存（T11 拖放导入 / T12 会话恢复共用）
window.__novels = new Map();

// Ruling A（前半）：按标签类型切换视图 —— novel → 阅读器，web → 网页视图槽。
// T10 发出 tabs:changed 快照（activeId + tabs[].type/novelId）后调用本函数。
function switchActiveTab(type, novelId) {
  const isNovel = type === 'novel';
  $('#reader-view').hidden = !isNovel;
  $('#view-slot').hidden = isNovel;
  if (isNovel && novelId) {
    const novel = window.__novels.get(novelId);
    if (novel && typeof openNovel === 'function') openNovel(novel);
  }
}

function setMode(mode) {
  document.body.dataset.mode = mode;
  $('#ad-view').hidden = mode !== 'ad';
  $('#content-view').hidden = mode !== 'content';
  window.api.send('mode:set', mode);
}

// 初始状态：主进程回传 settings + 当前模式
window.api.on('mode:set', (mode) => {
  document.body.dataset.mode = mode;
  $('#ad-view').hidden = mode !== 'ad';
  $('#content-view').hidden = mode !== 'content';
});

window.api.invoke('shell:ready').then(({ settings, mode }) => {
  window.__settings = settings;
  setMode(mode);
  initAd(); // 广告伪装视图渲染（Task 5；shell:ready 后调用保证 settings 可用）
});

// 托盘"伪装样式"切换（Task 6）：settings 已持久化，这里重渲染广告视图
window.api.on('settings:changed', (settings) => {
  window.__settings = settings;
  renderAd(settings.adStyle);
});

// 托盘/广告菜单"设置"入口占位（Task 13 实现真正的设置面板）
window.api.on('open-settings', () => {
  console.log('open-settings: 设置面板待 Task 13 实现');
});

// —— 小说阅读器接线（Task 9）——
// 预留调用点（T10 接线）：标签栏发出 tabs:changed 快照（activeId + tabs[].type）→ switchActiveTab
window.api.on('tabs:changed', (snapshot) => {
  if (!snapshot || !Array.isArray(snapshot.tabs)) return;
  const active = snapshot.tabs.find((t) => t.id === snapshot.activeId) || snapshot.tabs[0];
  if (active) switchActiveTab(active.type, active.novelId);
});

// T10 创建小说标签时发 tabs:create-novel 回显 → 打开阅读器；
// 本任务先直接调 openNovel 验证（DevTools 手动 import 后调用）
window.api.on('tabs:create-novel', (novel) => {
  if (!novel || !novel.novelId) return;
  window.__novels.set(novel.novelId, novel);
  if (typeof openNovel === 'function') openNovel(novel);
});
