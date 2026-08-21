// renderer/reader/reader.js — 小说阅读器（Task 9）
// 双环境可用：Node（测试纯函数）+ 浏览器（经典脚本，函数为全局，shell.js 可直接调用）

// —— 纯函数（可测）——
function computeProgress(chapterIndex, scrollTop, clientHeight, scrollHeight) {
  const range = scrollHeight - clientHeight;
  return { chapterIndex, scrollRatio: range <= 0 ? 0 : Math.max(0, Math.min(1, scrollTop / range)), updatedAt: Date.now() };
}
function restoreScroll(progress) {
  // 终审修复：规格 §5.2 契约"续读精确定位"优先 —— 恢复记录的确切比例而非固定 0.35；
  // clamp 到 [0, 0.95] 防落屏底/屏顶；无记录比例（旧数据）回落 0.35 偏上定位。
  const raw = typeof progress.scrollRatio === 'number' ? progress.scrollRatio : 0.35;
  return { chapterIndex: progress.chapterIndex, ratio: Math.max(0, Math.min(0.95, raw)) };
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
    // 滚动定位到记录的精确比例（restoreScroll clamp 0~0.95，防落屏底）
    // 伪装模式下 content-view 隐藏 → 阅读器无布局（scrollHeight=0）→ 直接定位无效；
    // 临时显形取得真实滚动范围（同一同步任务内执行，无重绘）后还原，保证 §10.8 位置恢复任意模式成立
    const el = $('#reader-content');
    const cv = $('#content-view');
    const wasHidden = cv.hidden;
    if (wasHidden) cv.hidden = false;
    el.scrollTop = Math.max(0, (el.scrollHeight - el.clientHeight) * restoreScroll(saved).ratio);
    if (wasHidden) cv.hidden = true;
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
  // 用户反馈修复：整章曾以单个 div.textContent 渲染 —— HTML 默认折叠换行符，
  // 中文网文"一行一段"全部挤成一段文字墙。改为按换行拆段落、每段一个 <p>
  // （text-indent: 2em 首行缩进见 reader.css）；textContent 渲染保持无 XSS 面。
  const paras = text.split(/\n+/).filter((s) => s.trim().length > 0);
  for (const para of paras) {
    const p = document.createElement('p');
    p.textContent = para;
    el.appendChild(p);
  }
}

// 进度：滚动停止防抖 2s 写盘；隐藏/切走时立即写（saveNow 导出，T10 切换标签时调用）
let progressTimer = null;
function scheduleSave() {
  clearTimeout(progressTimer);
  progressTimer = setTimeout(saveNow, 2000);
}
function saveNow() {
  if (!state || !window.__settings) return;
  // 终审修复：阅读器无布局时跳过写盘。切走小说标签 → reader-view hidden；
  // 切回伪装模式 → content-view hidden（display:none 下 clientHeight/scrollHeight=0，
  // computeProgress 会算出 scrollRatio:0 覆盖好进度）。openNovel 恢复流程的临时显形
  // 不受影响：此刻 reader-view 与 content-view 均可见，守卫放行。
  if (readerView().hidden || $('#content-view').hidden) return;
  const el = $('#reader-content');
  const p = computeProgress(state.chapterIndex, el.scrollTop, el.clientHeight, el.scrollHeight);
  window.api.invoke('novels:progress', state.novel.novelId, p);
}

// —— 阅读设置小面板（brainstorming 2026-08-21：工具栏只留 目录/设置/返回伪装，
// 字号/暗色/字体并入此面板，即点即改、独立于主设置面板）——

// 面板控件 → 合并进 settings.reader 并立即应用 + 持久化（settings:changed 广播回推 __settings）
function setReaderPrefs(partial) {
  const prefs = (window.__settings && window.__settings.reader) || {};
  Object.assign(prefs, partial);
  applyReaderPrefs(prefs);
  window.api.invoke('settings:save', { reader: prefs });
}

function openReaderSettings() {
  const prefs = (window.__settings && window.__settings.reader) || {};
  $('#rs-size').value = prefs.fontSize || 16;
  $('#rs-size-v').textContent = prefs.fontSize || 16;
  $('#rs-dark').checked = !!prefs.dark;
  const font = prefs.fontFamily || 'yahei';
  const radio = document.querySelector(`#reader-settings input[name="rs-font"][value="${font}"]`);
  if (radio) radio.checked = true;
  $('#reader-settings').hidden = false;
}

function closeReaderSettings() {
  $('#reader-settings').hidden = true;
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

// —— 构建阅读器 DOM（toolbar + 内容区 + 目录浮层 + 阅读设置面板）——
function buildReaderDom() {
  const view = readerView();
  view.innerHTML = `
    <div id="reader-toolbar">
      <button data-action="toc" title="章节目录">目录</button>
      <button data-action="settings" title="阅读设置">设置</button>
      <span class="reader-spacer"></span>
      <button data-action="back" title="切回伪装界面">返回伪装</button>
    </div>
    <div id="reader-content"></div>
    <div id="reader-toc" hidden>
      <div id="reader-toc-head"><button data-action="toc-close">← 返回</button><span id="reader-toc-title"></span></div>
      <div id="reader-toc-list"></div>
    </div>
    <div id="reader-settings" hidden>
      <div class="rs-row"><label>字号</label><input id="rs-size" type="range" min="12" max="28" step="1"><span id="rs-size-v"></span></div>
      <div class="rs-row"><label>暗色</label><input id="rs-dark" type="checkbox"></div>
      <div class="rs-row"><label>字体</label>
        <span class="rs-fonts">
          <label><input type="radio" name="rs-font" value="yahei">雅黑</label>
          <label><input type="radio" name="rs-font" value="song">宋体</label>
          <label><input type="radio" name="rs-font" value="kai">楷体</label>
        </span>
      </div>
      <button data-action="rs-close">关闭</button>
    </div>`;
  // 进度保存：scroll 不冒泡，直接监听内容区（brief 的 readerView 委托写法在无 capture 时收不到事件）
  $('#reader-content').addEventListener('scroll', scheduleSave);
  // 工具栏/目录浮层/设置面板统一事件委托（brainstorming 改版：toc 与设置互斥打开）
  view.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'toc') { closeReaderSettings(); openToc(); }
    else if (action === 'toc-close') closeToc();
    else if (action === 'toc-goto') gotoChapter(Number(btn.dataset.i));
    else if (action === 'settings') { closeToc(); openReaderSettings(); }
    else if (action === 'rs-close') closeReaderSettings();
    else if (action === 'back') setMode('ad');
  });
  // 设置面板控件：即点即改（滑杆 input 实时、暗色/字体 change 时写盘）
  $('#rs-size').addEventListener('input', (e) => {
    const v = +e.target.value;
    $('#rs-size-v').textContent = v;
    setReaderPrefs({ fontSize: v });
  });
  $('#rs-dark').addEventListener('change', (e) => setReaderPrefs({ dark: e.target.checked }));
  document.querySelectorAll('#reader-settings input[name="rs-font"]').forEach((r) => {
    r.addEventListener('change', () => setReaderPrefs({ fontFamily: r.value }));
  });
  // 点面板外（非面板、非"设置"按钮）关闭
  document.addEventListener('click', (e) => {
    const panel = $('#reader-settings');
    if (panel.hidden) return;
    if (e.target.closest('#reader-settings') || e.target.closest('[data-action="settings"]')) return;
    closeReaderSettings();
  });
}

// 浏览器环境才构建 DOM；Node 测试环境只导出纯函数
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  buildReaderDom();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeProgress, restoreScroll, openNovel, loadChapter, saveNow, applyReaderPrefs, openToc, closeToc };
}
