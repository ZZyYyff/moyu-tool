// renderer/shell.js
const $ = (sel) => document.querySelector(sel);

// Ruling A（前半）：壳层维护 novel 元数据内存缓存（T11 拖放导入 / T12 会话恢复共用）
window.__novels = new Map();

// Ruling A（前半）：按标签类型切换视图 —— novel → 阅读器，web → 网页视图槽。
// T10 发出 tabs:changed 快照（activeId + tabs[].type/novelId）后调用本函数。
function switchActiveTab(type, novelId) {
  const isNovel = type === 'novel';
  // 终审修复：任何切换前先 flush 当前小说进度 —— 切走标签（隐藏阅读器）与小说→小说
  // 直接换书都会丢失 <2s 防抖内的滚动；saveNow 此刻阅读器仍可见、守卫放行；
  // 隐藏后待定防抖被守卫跳过也不会覆盖好进度（见 reader.js）。调用时 reader.js 已就绪。
  if (typeof saveNow === 'function') saveNow();
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

// 终审修复：拖放确认后的操作一律先切回内容模式 —— ad（伪装）模式下 content-view 隐藏，
// 直接建标签/渲染阅读器无任何可见结果（与 showAddressBar 的 Ruling T 先例一致；错误提示无需切）。
function ensureContentMode() {
  if (document.body.dataset.mode === 'ad') setMode('content');
}

// 初始状态：主进程回传 settings + 当前模式
window.api.on('mode:set', (mode) => {
  document.body.dataset.mode = mode;
  $('#ad-view').hidden = mode !== 'ad';
  $('#content-view').hidden = mode !== 'content';
});

window.api.invoke('shell:ready').then(({ settings, mode, tabs }) => {
  // 初始化应用延到 window load（T12 发现的 T5 遗留竞态修复）：shell:ready 的 IPC 响应可能在
  // 后续 <script>（reader.js/ad.js，加载在 shell.js 之后）执行前送达——HTML 解析器在脚本 fetch
  // 间隙会处理 IPC 消息，此时 initAd/openNovel 尚未定义，直接执行会抛错中断整个恢复链路。
  // load 保证所有脚本已执行完毕，结果确定；readyState==='complete'（响应晚于 load 到达）则立即执行。
  const applyInitialState = () => {
    window.__settings = settings;
    setMode(mode);
    initAd(); // 广告伪装视图渲染（Task 5；initAd 内部自行 fetch 主题与 settings，不依赖 __settings）
    // Task 12：会话恢复 —— lastNovels 重建壳层小说元数据缓存（恢复出的 novel 标签切阅读器时 openNovel 依赖；
    // 与主进程 novelsMeta 重建对应，见 main.js 恢复循环）
    const lastNovels = settings && settings.lastNovels;
    if (lastNovels) for (const novel of Object.values(lastNovels)) {
      if (novel && novel.novelId) window.__novels.set(novel.novelId, novel);
    }
    // Task 10：启动时按快照渲染标签栏（无标签时显示空状态，保证 + 按钮可用）
    if (Array.isArray(tabs)) {
      renderTabbar(tabs);
      if (tabs.length === 0) showEmptyState();
      else {
        // Task 12：启动即按快照切视图 —— 恢复的 tabs:changed 可能先于元数据缓存就绪送达
        // （主进程在渲染器加载前就推送），此处幂等补切；web 标签无副作用。
        const active = tabs.find((t) => t.active) || tabs[0];
        switchActiveTab(active.type, active.novelId);
      }
    }
  };
  if (document.readyState === 'complete') applyInitialState();
  else window.addEventListener('load', applyInitialState, { once: true });
});

// 托盘"伪装样式"切换（Task 6）：settings 已持久化，这里重渲染广告视图
window.api.on('settings:changed', (settings) => {
  window.__settings = settings;
  renderAd(settings.adStyle);
});

// 托盘"设置"入口 → 设置面板（Task 13：settings.js 实现；广告菜单同调 openSettings，
// 该函数为 settings.js 顶层全局声明，脚本加载完成后任意入口可用）
window.api.on('open-settings', () => {
  openSettings();
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
  // 终审修复：关闭最后一个小说标签走此分支，先 flush 进度再隐藏阅读器
  // （隐藏后 saveNow 守卫会跳过待定防抖，<2s 内的滚动不得丢失）。
  if (typeof saveNow === 'function') saveNow();
  $('#view-slot').hidden = false;
  $('#reader-view').hidden = true;
  $('#view-slot').innerHTML = '<div class="empty">拖入网址或小说，或点 + 输入网址</div>';
}

// 地址栏显隐：DOM 显隐 + 通知主进程调整视图 bounds（tabs:address-bar）
function showAddressBar() {
  // 终审修复：#addressbar 位于 content-view 内，ad 模式下点击角标菜单"输入网址…"
  // 会落焦点到隐形输入框且无任何反馈 —— 先切回内容模式再显示地址栏。
  if (document.body.dataset.mode === 'ad') setMode('content');
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

// —— 拖放（Task 11）——

// 窗口级 drop：阻止默认（避免整页导航），识别类型
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  // 终审修复：扩展名比较大小写不敏感（Windows 上 BOOK.TXT 应可拖入）；
  // 必须先判 files.length === 1 再解引用 files[0] —— URL 拖入时 files 为空列表，
  // 无条件 files[0] 会抛 TypeError，使下方 uri-list 分支（规格 §5.3/§10.2）永远不可达。
  if (files.length === 1 && /\.(txt|epub)$/i.test(files[0].name.toLowerCase())) {
    const filePath = window.api.getPathForFile(files[0]);
    // 规格 §5.2/§9：超大文件（>50MB）提示，仍可读（解析按章懒读取，渲染不进整文件）
    const big = files[0].size > 50 * 1024 * 1024;
    showConfirm(`打开小说《${files[0].name}》${big ? '（大文件，解析稍慢，仍可读）' : ''}？`, async () => {
      ensureContentMode();
      try {
        const novel = await window.api.invoke('novels:import', filePath);
        await window.api.invoke('tabs:create-novel', novel);
        openNovel(novel);
      } catch (err) {
        // 导入失败：确认条保留并置错误文案（红底），避免无反馈
        showConfirm(`导入失败：${err && err.message ? err.message : err}`, () => hideConfirm());
        $('#confirm-bar').classList.add('error');
      }
    });
    return;
  }
  const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list');
  // 逐行解析：跳过空行与 '#' 注释行（text/uri-list 规范），取第一个 http(s) 行
  const url = text ? text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#') && /^https?:\/\//i.test(l)) : null;
  if (url) {
    showConfirm(`打开 ${url.slice(0, 50)}？`, () => { ensureContentMode(); window.api.invoke('tabs:create', url); });
    return;
  }
  // 规格 §9：拖入不支持的类型 → 忽略并轻提示
  showConfirm('不支持的拖入内容：仅支持 txt/epub 文件或 http(s) 链接', () => hideConfirm());
  $('#confirm-bar').classList.add('error');
});

function showConfirm(text, onOk) {
  $('#confirm-bar').classList.remove('error');
  $('#confirm-text').textContent = text;
  $('#confirm-ok').onclick = () => { hideConfirm(); onOk(); };
  $('#confirm-cancel').onclick = hideConfirm;
  $('#confirm-bar').hidden = false;
}
function hideConfirm() {
  $('#confirm-bar').hidden = true;
  // 防双击"打开"二次执行：handler 置空（每次 showConfirm 重新接线，重复拖入安全）
  $('#confirm-ok').onclick = null;
  $('#confirm-cancel').onclick = null;
}

// 规格 §7：关闭/隐藏时强制写盘 —— 主进程在 win 'hide'/'close' 时推送 flush（主进程驱动，
// 因 Electron+Windows 上 hide() 不触发渲染进程 visibilitychange）；另保留 visibilitychange
// 兜底（其他平台/最小化场景可能触发）。saveNow 为 reader.js 的全局函数，事件触发时已就绪。
window.api.on('app:flush-progress', () => saveNow());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveNow();
});
