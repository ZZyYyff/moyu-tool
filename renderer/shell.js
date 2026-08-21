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

window.api.invoke('shell:ready').then(({ settings, mode, tabs }) => {
  window.__settings = settings;
  setMode(mode);
  initAd(); // 广告伪装视图渲染（Task 5；shell:ready 后调用保证 settings 可用）
  // Task 10：启动时按快照渲染标签栏（无标签时显示空状态，保证 + 按钮可用）
  if (Array.isArray(tabs)) {
    renderTabbar(tabs);
    if (tabs.length === 0) showEmptyState();
  }
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

// —— 多标签（Task 10）——

// 标签栏渲染：标签（点击激活 / × 关闭）+ 末尾 + 按钮（打开地址栏）
function renderTabbar(snapshot) {
  const bar = $('#tabbar');
  bar.innerHTML = '';
  snapshot.forEach(t => {
    const el = document.createElement('div');
    el.className = 'tab' + (t.active ? ' active' : '');
    const title = document.createElement('span');
    title.textContent = t.title;
    el.appendChild(title);
    el.onclick = () => window.api.send('tabs:activate', t.id); // 评审修正：invoke 只配 ipcMain.handle，此处通道为 on → send
    const close = document.createElement('button');
    close.textContent = '×';
    close.onclick = (e) => { e.stopPropagation(); window.api.send('tabs:close', t.id); };
    el.appendChild(close);
    bar.appendChild(el);
  });
  const plus = document.createElement('button');
  plus.textContent = '+';
  plus.className = 'plus';
  plus.onclick = () => showAddressBar();
  bar.appendChild(plus);
}

function showEmptyState() {
  $('#view-slot').hidden = false;
  $('#reader-view').hidden = true;
  $('#view-slot').innerHTML = '<div class="empty">拖入网址或小说，或点 + 输入网址</div>';
}

// 地址栏显隐：DOM 显隐 + 通知主进程调整视图 bounds（tabs:address-bar）
function showAddressBar() {
  $('#addressbar').hidden = false;
  $('#addr-input').focus();
  window.api.send('tabs:address-bar', true);
}
function hideAddressBar() {
  $('#addressbar').hidden = true;
  window.api.send('tabs:address-bar', false);
}

// Ruling A 完整落实：快照到达 → 渲染标签栏 + 按 active 标签类型切视图（novel → 阅读器，web → 视图槽）
window.api.on('tabs:changed', (msg) => {
  if (!msg || !Array.isArray(msg.tabs)) return;
  renderTabbar(msg.tabs);
  if (msg.tabs.length === 0) { showEmptyState(); return; }
  const active = msg.tabs.find((t) => t.id === msg.activeId) || msg.tabs[0];
  if (active) switchActiveTab(active.type, active.novelId);
});

// 网页加载失败 → 错误页 + 重试按钮（主进程已把失败标签的视图摘除，DOM 错误页可点）
window.api.on('tab:error', (msg) => {
  $('#view-slot').innerHTML = `<div class="errpage">加载失败 (${msg.code})：<br>${msg.description}<br><button onclick="window.api.send('tabs:reload-active')">重试</button></div>`;
});

// 地址栏：回车开标签（无协议自动补 https://）；后退/前进/刷新
$('#addr-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  let u = $('#addr-input').value.trim();
  if (!u) return;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  window.api.invoke('tabs:create', u);
  $('#addr-input').value = '';
  hideAddressBar();
});
$('#addr-back').addEventListener('click', () => window.api.send('tabs:navigate', -1));
$('#addr-fwd').addEventListener('click', () => window.api.send('tabs:navigate', 1));
$('#addr-reload').addEventListener('click', () => window.api.send('tabs:reload-active'));
