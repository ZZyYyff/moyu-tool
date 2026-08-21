// renderer/reader/reader.js — 小说阅读器（Task 9）
// 双环境可用：Node（测试纯函数）+ 浏览器（经典脚本，函数为全局，shell.js 可直接调用）

// —— 纯函数（可测）——
function computeProgress(chapterIndex, scrollTop, clientHeight, scrollHeight) {
  const range = scrollHeight - clientHeight;
  return { chapterIndex, scrollRatio: range <= 0 ? 0 : Math.max(0, Math.min(1, scrollTop / range)), updatedAt: Date.now() };
}
function restoreScroll(progress) {
  return { chapterIndex: progress.chapterIndex, ratio: 0.35 };
}

// —— 阅读器状态 ——
let state = null; // { novel, chapterIndex, currentChapter, nextStart }
// 不重复声明 $：shell.js 已声明顶层 const $，重复声明会抛 SyntaxError 导致本脚本整体不执行
// （T10 评审验证发现，Task 9 遗留缺陷）；浏览器下复用 shell.js 的 $，Node 测试不依赖 $。
const readerView = () => $('#reader-view');

async function openNovel(novel) {
  if (!novel || !novel.novelId) return;
  if (state && state.novel.novelId === novel.novelId) {
    // 同一本书已打开：只恢复可见性，避免重复加载导致滚动跳动
    readerView().hidden = false;
    return;
  }
  state = { novel, chapterIndex: 0, currentChapter: null };
  if (window.__novels) window.__novels.set(novel.novelId, novel); // Ruling A：壳层缓存元数据（T12 复用）
  readerView().hidden = false;
  applyReaderPrefs();
  await loadChapter(0);
  const saved = await window.api.invoke('novels:get-progress', novel.novelId);
  if (saved && typeof saved.chapterIndex === 'number') {
    state.chapterIndex = saved.chapterIndex;
    await loadChapter(saved.chapterIndex);
    // 滚动定位到章内 35% 处（restoreScroll 语义：偏上定位，防止跳到屏底）
    const el = $('#reader-content');
    el.scrollTop = Math.max(0, (el.scrollHeight - el.clientHeight) * restoreScroll(saved).ratio);
  }
}

async function loadChapter(i) {
  if (!state) return;
  const { novel } = state;
  const { title, text } = await window.api.invoke('novels:chapter', novel.novelId, i);
  state.chapterIndex = i;
  state.currentChapter = { title, text };
  const el = $('#reader-content');
  el.scrollTop = 0;
  el.innerHTML = '';
  const h = document.createElement('h2'); h.textContent = title; el.appendChild(h);
  const p = document.createElement('div'); p.textContent = text; el.appendChild(p);
}

// 进度：滚动停止防抖 2s 写盘；隐藏/切走时立即写（saveNow 导出，T10 切换标签时调用）
let progressTimer = null;
function scheduleSave() {
  clearTimeout(progressTimer);
  progressTimer = setTimeout(saveNow, 2000);
}
function saveNow() {
  if (!state || !window.__settings) return;
  const el = $('#reader-content');
  const p = computeProgress(state.chapterIndex, el.scrollTop, el.clientHeight, el.scrollHeight);
  window.api.invoke('novels:progress', state.novel.novelId, p);
}

// —— 工具栏：目录 / 字号 A- A+ / 暗色 / 字体 / 返回伪装 ——
const FONT_CYCLE = ['yahei', 'song', 'kai'];

function changeFontSize(delta) {
  const prefs = window.__settings && window.__settings.reader;
  if (!prefs) return;
  prefs.fontSize = Math.max(12, Math.min(28, (prefs.fontSize || 16) + delta));
  applyReaderPrefs();
  persistReaderPrefs();
}

function toggleDark() {
  const prefs = window.__settings && window.__settings.reader;
  if (!prefs) return;
  prefs.dark = !prefs.dark;
  applyReaderPrefs();
  persistReaderPrefs();
}

function cycleFont() {
  const prefs = window.__settings && window.__settings.reader;
  if (!prefs) return;
  const cur = prefs.fontFamily || 'yahei';
  const idx = FONT_CYCLE.indexOf(cur);
  prefs.fontFamily = FONT_CYCLE[(idx + 1) % FONT_CYCLE.length];
  applyReaderPrefs();
  persistReaderPrefs();
}

// 工具栏改动持久化到 settings.json（settings:changed 回推后 window.__settings 同步更新）
function persistReaderPrefs() {
  if (!window.__settings) return;
  window.api.invoke('settings:save', { reader: { ...window.__settings.reader } });
}

// 应用阅读偏好到 DOM（T13 设置面板复用，务必保持导出）：
// fontSize → CSS 变量 --fs；fontFamily/dark → reader-view 的 data 属性。
// prefs 可显式传入（T13 设置面板保存时传入本地值立即生效）；缺省读 window.__settings.reader
// （openNovel / 工具栏改动路径；偏好经 settings:changed 广播同步到 __settings，
//   故设置面板保存后下次 openNovel 也会读到新偏好）
function applyReaderPrefs(prefs) {
  prefs = prefs || (window.__settings && window.__settings.reader);
  if (!prefs) return;
  readerView().dataset.font = prefs.fontFamily;
  readerView().dataset.dark = String(prefs.dark);
  readerView().style.setProperty('--fs', (prefs.fontSize || 16) + 'px');
}

// —— 目录浮层 ——
function openToc() {
  if (!state) return;
  const list = $('#reader-toc-list');
  list.innerHTML = '';
  $('#reader-toc-title').textContent = state.novel.title;
  state.novel.chapters.forEach((c, i) => {
    const b = document.createElement('button');
    b.textContent = c.title;
    b.dataset.action = 'toc-goto';
    b.dataset.i = String(i);
    if (i === state.chapterIndex) b.classList.add('current');
    list.appendChild(b);
  });
  $('#reader-toc').hidden = false;
  list.scrollTop = 0;
}

function closeToc() {
  $('#reader-toc').hidden = true;
}

function gotoChapter(i) {
  loadChapter(i);
  saveNow();
  closeToc();
}

// —— 构建阅读器 DOM（toolbar + 内容区 + 目录浮层）——
function buildReaderDom() {
  const view = readerView();
  view.innerHTML = `
    <div id="reader-toolbar">
      <button data-action="toc" title="章节目录">目录</button>
      <button data-action="font-minus" title="缩小字号">A-</button>
      <button data-action="font-plus" title="放大字号">A+</button>
      <button data-action="dark" title="切换暗色">暗色</button>
      <button data-action="font" title="切换字体">字体</button>
      <span class="reader-spacer"></span>
      <button data-action="back" title="切回伪装界面">返回伪装</button>
    </div>
    <div id="reader-content"></div>
    <div id="reader-toc" hidden>
      <div id="reader-toc-head"><button data-action="toc-close">← 返回</button><span id="reader-toc-title"></span></div>
      <div id="reader-toc-list"></div>
    </div>`;
  // 进度保存：scroll 不冒泡，直接监听内容区（brief 的 readerView 委托写法在无 capture 时收不到事件）
  $('#reader-content').addEventListener('scroll', scheduleSave);
  // 工具栏/目录浮层统一事件委托
  view.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'toc') openToc();
    else if (action === 'toc-close') closeToc();
    else if (action === 'toc-goto') gotoChapter(Number(btn.dataset.i));
    else if (action === 'font-plus') changeFontSize(1);
    else if (action === 'font-minus') changeFontSize(-1);
    else if (action === 'dark') toggleDark();
    else if (action === 'font') cycleFont();
    else if (action === 'back') setMode('ad');
  });
}

// 浏览器环境才构建 DOM；Node 测试环境只导出纯函数
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  buildReaderDom();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeProgress, restoreScroll, openNovel, loadChapter, saveNow, applyReaderPrefs, openToc, closeToc };
}
