// renderer/reader/reader.js — 小说阅读器 v2（参照 Reader 重设计）
// 双环境可用：Node（测试纯函数）+ 浏览器（经典脚本，函数为全局，shell.js 可直接调用）
//
// v2 要点：
// - 进度模型 v2：{ chapterIndex, charOffset }（对齐 Reader 的字符偏移语义），段落级
//   精度——改字号/翻页不丢位置；旧 scrollRatio 数据回落兼容
// - 翻页/滚动双模式：page（点击左右 1/3 翻页区、滚轮、←→、自动翻页、章尾自动进章）
//   / scroll（章底自动追加下一章，单向连续）
// - 面板体系：目录 / 书签 / 全文搜索 / 设置 v2（排版/主题/翻页/章节解析），右浮层互斥

// —— 纯函数（可测）——
// 旧版进度（滚动比例），保留作 charOffset 缺失时的回落
function computeProgress(chapterIndex, scrollTop, clientHeight, scrollHeight) {
  const range = scrollHeight - clientHeight;
  return { chapterIndex, scrollRatio: range <= 0 ? 0 : Math.max(0, Math.min(1, scrollTop / range)), updatedAt: Date.now() };
}
function restoreScroll(progress) {
  const raw = typeof progress.scrollRatio === 'number' ? progress.scrollRatio : 0.35;
  return { chapterIndex: progress.chapterIndex, ratio: Math.max(0, Math.min(0.95, raw)) };
}

// 章文本 → 非空段落偏移表 [{off, len}]：off 为段落在章文本中的字符偏移，
// 与存储文本（行 \n 连接）同一坐标系，搜索/书签/进度的 charOffset 全部以此为基准
function paragraphOffsets(text) {
  const paras = [];
  let base = 0, rest = String(text || '');
  for (;;) {
    const m = rest.match(/\n+/);
    if (!m) { if (rest.length) paras.push({ off: base, len: rest.length }); break; }
    const seg = rest.slice(0, m.index);
    if (seg.trim().length) paras.push({ off: base, len: seg.length });
    base += m.index + m[0].length;
    rest = rest.slice(m.index + m[0].length);
    if (!rest.length) break;
  }
  return paras;
}

// 进度 v2 恢复决策：charOffset 有效用之；否则回落旧 scrollRatio（缺省 0.35）
function restoreProgress(progress) {
  if (progress && typeof progress.charOffset === 'number' && progress.charOffset >= 0) {
    return { kind: 'offset', chapterIndex: progress.chapterIndex || 0, charOffset: progress.charOffset };
  }
  if (progress && typeof progress.chapterIndex === 'number') {
    const r = restoreScroll(progress);
    return { kind: 'ratio', chapterIndex: r.chapterIndex, ratio: r.ratio };
  }
  return null;
}

// 全书百分比：第 ch 章 + 章内偏移比例 → 0-100（一位小数）
function chapterPercent(chapterIndex, charOffset, chapterChars, chapterCount) {
  if (!chapterCount) return 0;
  const frac = chapterChars > 0 ? Math.max(0, Math.min(1, charOffset / chapterChars)) : 0;
  const pct = ((chapterIndex + frac) / chapterCount) * 100;
  return Math.round(Math.max(0, Math.min(100, pct)) * 10) / 10;
}

// charOffset → 该章内的 scrollTop（段落级精度：命中段内按比例前进）。
// paras 需带 el/offsetTop（调用方保证已有布局）；返回绝对 scrollTop
function scrollToOffsetValue(paras, charOffset) {
  if (!paras.length) return 0;
  let hit = paras[0];
  for (const p of paras) { if (p.off <= charOffset) hit = p; else break; }
  const frac = hit.len > 0 ? Math.max(0, Math.min(1, (charOffset - hit.off) / hit.len)) : 0;
  return Math.max(0, hit.el.offsetTop + hit.el.offsetHeight * frac - 8);
}

// —— 阅读器状态 ——
let state = null; // { novel, chapterIndex, currentText, paras, appending, autoTimer }
// 不重复声明 $：shell.js 已声明顶层 const $，重复声明会抛 SyntaxError 导致本脚本整体不执行
const readerView = () => $('#reader-view');
const readerEl = () => $('#reader-content');
const prefs = () => (window.__settings && window.__settings.reader) || {};

async function openNovel(novel) {
  if (!novel || !novel.novelId) return;
  if (state && state.novel.novelId === novel.novelId) {
    // 同一本书已打开：只恢复可见性，避免重复加载导致滚动跳动
    readerView().hidden = false;
    return;
  }
  stopAutoPage();
  state = { novel, chapterIndex: 0, currentText: '', paras: [], appending: false, autoTimer: null };
  if (window.__novels) window.__novels.set(novel.novelId, novel); // Ruling A：壳层缓存元数据
  readerView().hidden = false;
  applyReaderPrefs();
  await loadChapter(0);
  const saved = await window.api.invoke('novels:get-progress', novel.novelId);
  if (saved && typeof saved.chapterIndex === 'number' && saved.chapterIndex > 0) {
    await loadChapter(saved.chapterIndex);
  }
  // 进度恢复：charOffset（v2）按段落定位；旧 scrollRatio 按滚动比例。
  // 伪装模式下 content-view 隐藏 → 无布局（offsetTop/scrollHeight 全 0）→
  // 临时显形取得真实布局（同一同步任务内执行，无重绘）后还原
  const plan = restoreProgress(saved);
  if (plan && plan.kind === 'offset' && state.paras.length) {
    restoreAt(plan.chapterIndex, () => scrollToOffsetValue(state.paras, plan.charOffset));
  } else if (plan && plan.kind === 'ratio') {
    restoreAt(plan.chapterIndex, () => {
      const el = readerEl();
      return Math.max(0, (el.scrollHeight - el.clientHeight) * plan.ratio);
    });
  }
}

// 临时显形定位：fn 返回目标 scrollTop（此刻 reader-view/content-view 已可见，布局真实）
function restoreAt(chapterIndex, fn) {
  const el = readerEl();
  const cv = $('#content-view');
  const wasHidden = cv.hidden;
  if (wasHidden) cv.hidden = false;
  el.scrollTop = fn();
  if (wasHidden) cv.hidden = true;
  void chapterIndex;
}

// 渲染单章（page 模式与 gotoChapter 路径；scroll 连续追加见 appendChapterBlock）
async function loadChapter(i) {
  if (!state) return;
  const { novel } = state;
  const { title, text } = await window.api.invoke('novels:chapter', novel.novelId, i);
  state.chapterIndex = i;
  state.currentText = text;
  state.appending = false;
  const el = readerEl();
  el.scrollTop = 0;
  el.innerHTML = '';
  el.appendChild(buildChapterSection(i, title, text, paragraphOffsets(text)));
  collectParas();
  closePanels();
  updateStatus();
}

// 章节块：<section data-ch> + h2 + 带 data-off 的段落（charOffset 写进 DOM）
function buildChapterSection(i, title, text, offsets) {
  const sec = document.createElement('section');
  sec.className = 'chapter';
  sec.dataset.ch = String(i);
  const h = document.createElement('h2');
  h.textContent = title;
  sec.appendChild(h);
  const paras = String(text || '').split(/\n+/);
  let pi = 0;
  for (const para of paras) {
    if (!para.trim().length) continue;
    const p = document.createElement('p');
    p.textContent = para;
    p.dataset.ch = String(i);
    const off = offsets[pi] ? offsets[pi].off : 0;
    p.dataset.off = String(off);
    sec.appendChild(p);
    pi++;
  }
  return sec;
}

// 缓存段落引用（进度采集/恢复用；offsetTop 实时读 DOM，此处只缓存 el/off/len）
function collectParas() {
  const list = [];
  readerEl().querySelectorAll('p[data-off]').forEach((el) => {
    list.push({ el, ch: Number(el.dataset.ch), off: Number(el.dataset.off), len: (el.textContent || '').length });
  });
  state.paras = list;
}

// scroll 模式：滚近章底自动追加下一章（单向连续；页模式章尾翻页进章，不走这里）
async function maybeAppendNext() {
  if (!state || prefs().mode !== 'scroll' || state.appending) return;
  const el = readerEl();
  if (el.scrollHeight - el.scrollTop - el.clientHeight > 60) return;
  const next = state.chapterIndex + 1;
  if (next >= state.novel.chapters.length) return;
  state.appending = true;
  const { title, text } = await window.api.invoke('novels:chapter', state.novel.novelId, next);
  const offsets = paragraphOffsets(text);
  el.appendChild(buildChapterSection(next, title, text, offsets));
  collectParas();
  // appending 保持 true：一章只追加一次，gotoChapter/loadChapter 重置
}

// —— 进度采集与保存 ——
let progressTimer = null;
function scheduleSave() {
  clearTimeout(progressTimer);
  progressTimer = setTimeout(saveNow, 2000);
}
// DOM → 当前进度 {chapterIndex, charOffset}：取首个可见段落（顶部 4px 容差内最后一段）
function currentProgress() {
  if (!state) return null;
  const el = readerEl();
  const edge = el.scrollTop + 4;
  let hit = state.paras[0];
  for (const p of state.paras) {
    if (p.el.offsetTop <= edge) hit = p; else break;
  }
  if (!hit) return null;
  return { chapterIndex: hit.ch, charOffset: hit.off, updatedAt: Date.now() };
}
function saveNow() {
  if (!state || !window.__settings) return;
  // 阅读器无布局时跳过写盘（display:none 下会算出 0 覆盖好进度）
  if (readerView().hidden || $('#content-view').hidden) return;
  const p = currentProgress();
  if (!p) return;
  window.api.invoke('novels:progress', state.novel.novelId, p);
  updateStatus(p);
}

// —— 状态栏：章名 · 百分比 · 章序 ——
function updateStatus(p) {
  if (!state) return;
  const prog = p || currentProgress();
  if (!prog) return;
  const chapterLen = state.currentText ? state.currentText.length : 0;
  const pct = chapterPercent(prog.chapterIndex, prog.charOffset, chapterLen, state.novel.chapters.length);
  $('#rs-chapter').textContent = state.novel.chapters[prog.chapterIndex] ? state.novel.chapters[prog.chapterIndex].title : '';
  $('#rs-percent').textContent = pct.toFixed(1) + '%';
  $('#rs-pos').textContent = (prog.chapterIndex + 1) + '/' + state.novel.chapters.length;
}

// —— 翻页引擎 ——
// delta=1 向后 / -1 向前。page 模式：保留行数翻页（连续感），章尾自动进下一章、
// 章首退回上一章章尾；scroll 模式：整屏滚动（热键路径）
async function turnPage(delta) {
  if (!state) return;
  const el = readerEl();
  const mode = prefs().mode || 'page';
  if (mode === 'page') {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
    const atTop = el.scrollTop <= 2;
    if (delta > 0 && atBottom) {
      if (state.chapterIndex + 1 < state.novel.chapters.length) await loadChapter(state.chapterIndex + 1);
      else stopAutoPage();
      scheduleSave();
      return;
    }
    if (delta < 0 && atTop) {
      if (state.chapterIndex > 0) {
        await loadChapter(state.chapterIndex - 1);
        el.scrollTop = el.scrollHeight; // 落到上一章章尾
      }
      scheduleSave();
      return;
    }
    const overlap = pageOverlapPx();
    el.scrollTop += delta * Math.max(40, el.clientHeight - overlap);
  } else {
    el.scrollTop += delta * el.clientHeight;
  }
  scheduleSave();
  updateStatus();
}
function pageOverlapPx() {
  const n = Math.max(0, Math.min(3, Number(prefs().pageOverlap)));
  if (!n) return 0;
  const lh = parseFloat(getComputedStyle(readerEl()).lineHeight) || 30;
  return lh * n;
}

// 热键翻页入口（shell.js 调；兼容旧名）
function pageReader(delta) {
  if (!state) return;
  turnPage(delta);
}

// 滚轮：page 模式拦截翻页（触盘小位移累积过阈值才翻，防一格滚三页）；
// scroll 模式交还原生滚动
let wheelAcc = 0;
function onWheel(e) {
  if (!state || (prefs().mode || 'page') !== 'page') return;
  e.preventDefault();
  wheelAcc += e.deltaY;
  if (Math.abs(wheelAcc) >= 60) {
    turnPage(wheelAcc > 0 ? 1 : -1);
    wheelAcc = 0;
  }
}

// 点击翻页区（page 模式、非透明）：左 1/3 上一页、右 1/3 下一页；透明模式让位给拖动
function onClickZone(e) {
  if (!state || (prefs().mode || 'page') !== 'page') return;
  if (readerView().dataset.transparent === 'true') return;
  if (e.target.closest('button') || e.target.closest('[id^="reader-"]')) return; // 面板/工具栏不翻页
  const rect = readerEl().getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (x < rect.width / 3) turnPage(-1);
  else if (x > (rect.width * 2) / 3) turnPage(1);
}

// 键盘：←→/PgUp PgDn 翻页、空格自动翻页（阅读器可见时接管；输入框聚焦时不抢）
function onKeyDown(e) {
  if (!state || readerView().hidden || $('#content-view').hidden) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); turnPage(-1); }
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); turnPage(1); }
  else if (e.key === ' ') { e.preventDefault(); toggleAutoPage(); }
  else if (e.key === 'Escape') closePanels();
}

// 自动翻页（Reader 空格键习惯）：按 prefs.autoPageMs 间隔向后翻，工具栏可暂停
function toggleAutoPage() {
  if (state && state.autoTimer) stopAutoPage();
  else startAutoPage();
}
function startAutoPage() {
  if (!state || state.autoTimer) return;
  const ms = Math.max(500, Number(prefs().autoPageMs) || 3000);
  $('#reader-auto').textContent = '⏸';
  state.autoTimer = setInterval(() => {
    if (readerView().hidden || $('#content-view').hidden) { stopAutoPage(); return; }
    turnPage(1);
  }, ms);
}
function stopAutoPage() {
  if (state && state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = null; }
  const btn = $('#reader-auto');
  if (btn) btn.textContent = '⏵';
}

// —— 阅读设置（setReaderPrefs：合并 settings.reader 并立即应用 + 持久化）——
function setReaderPrefs(partial) {
  const p = prefs();
  Object.assign(p, partial);
  applyReaderPrefs(p);
  window.api.invoke('settings:save', { reader: p });
}

let appliedMode = null;
function applyReaderPrefs(p) {
  p = p || prefs();
  if (!p) return;
  const view = readerView();
  if (!view) return;
  view.dataset.font = p.fontFamily;
  view.dataset.theme = p.theme || 'paper';
  view.dataset.dark = String(p.theme === 'dark' || !!p.dark); // dark 兼容旧数据/旧 CSS
  view.dataset.mode = p.mode || 'page';
  view.dataset.indent = String(p.indent !== false);
  view.dataset.transparent = String(!!p.transparent); // 裁定 AB
  // 透明激活态上移到父容器（阅读器可见时才生效）
  $('#content-view').dataset.transparent = String(!!p.transparent && !view.hidden);
  view.style.setProperty('--fs', (p.fontSize || 16) + 'px');
  view.style.setProperty('--lh', String(p.lineGap || 1.9));
  view.style.setProperty('--pgap', (p.paraGap != null ? p.paraGap : 0.6) + 'em');
  view.style.setProperty('--cgap', (p.charGap || 0) + 'px');
  view.style.setProperty('--margin', (p.margin != null ? p.margin : 32) + 'px');
  view.style.setProperty('--fc', p.color || '');
  // 阅读中途切模式：滚动模式可能已追加多章 → 重载当前章单章渲染
  if (state && appliedMode && appliedMode !== (p.mode || 'page')) {
    loadChapter(state.chapterIndex);
  }
  appliedMode = p.mode || 'page';
}

function openReaderSettings() {
  hideOtherPanels('#reader-settings');
  const p = prefs();
  $('#rs-size').value = p.fontSize || 16;
  $('#rs-size-v').textContent = p.fontSize || 16;
  $('#rs-linegap').value = p.lineGap || 1.9;
  $('#rs-linegap-v').textContent = p.lineGap || 1.9;
  $('#rs-paragap').value = p.paraGap != null ? p.paraGap : 0.6;
  $('#rs-paragap-v').textContent = $('#rs-paragap').value;
  $('#rs-margin').value = p.margin != null ? p.margin : 32;
  $('#rs-margin-v').textContent = $('#rs-margin').value;
  $('#rs-indent').checked = p.indent !== false;
  $('#rs-theme').value = p.theme || 'paper';
  $('#rs-color').value = p.color || (p.dark ? '#b8b8b8' : '#333333');
  $('#rs-mode-page').checked = (p.mode || 'page') === 'page';
  $('#rs-mode-scroll').checked = (p.mode || 'page') === 'scroll';
  $('#rs-overlap').value = p.pageOverlap != null ? p.pageOverlap : 1;
  $('#rs-overlap-v').textContent = $('#rs-overlap').value;
  $('#rs-auto').value = p.autoPageMs || 3000;
  $('#rs-auto-v').textContent = ((p.autoPageMs || 3000) / 1000) + 's';
  $('#rs-transparent').checked = !!p.transparent;
  const font = p.fontFamily || 'yahei';
  const radio = document.querySelector(`#reader-settings input[name="rs-font"][value="${font}"]`);
  if (radio) radio.checked = true;
  const rule = p.chapterRule || {};
  $('#rs-rule').value = rule.mode || 'auto';
  $('#rs-rule-keyword').value = rule.keyword || '';
  $('#rs-rule-regex').value = rule.regex || '';
  $('#reader-settings').hidden = false;
  window.api.send('ui:panel-open', true); // 面板打开期间悬停揭示停用
}
function closeReaderSettings() {
  $('#reader-settings').hidden = true;
  window.api.send('ui:panel-open', false);
}

// —— 目录 ——
// 面板互斥（含直接调函数的路径）：打开一个先关其余
function hideOtherPanels(except) {
  ['#reader-toc', '#reader-settings', '#reader-bookmarks', '#reader-search', '#reader-source', '#reader-sources'].forEach((s) => {
    if (s !== except) { const el = $(s); if (el) el.hidden = true; }
  });
}
function openToc() {
  if (!state) return;
  hideOtherPanels('#reader-toc');
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
  $('#reader-toc-refresh').hidden = !state.novel.isOnline; // 在线书才有"刷新目录"
  $('#reader-toc').hidden = false;
  list.scrollTop = 0;
}
function closeToc() { $('#reader-toc').hidden = true; }
async function gotoChapter(i) {
  await loadChapter(i);
  saveNow();
}

// —— 书签 ——
async function openBookmarks() {
  if (!state) return;
  hideOtherPanels('#reader-bookmarks');
  $('#reader-bookmarks').hidden = false;
  await renderBookmarks();
}
async function renderBookmarks() {
  const list = $('#reader-bm-list');
  list.innerHTML = '';
  let marks = [];
  try { marks = await window.api.invoke('novels:bookmarks', state.novel.novelId) || []; } catch { marks = []; }
  if (!marks.length) {
    const empty = document.createElement('div');
    empty.className = 'bm-empty';
    empty.textContent = '暂无书签，点上方"加书签"在当前位置插入';
    list.appendChild(empty);
  }
  marks.forEach((m, idx) => {
    const row = document.createElement('div');
    row.className = 'bm-row';
    const go = document.createElement('button');
    go.className = 'bm-go';
    go.textContent = (m.label || '书签') + ' · ' + (m.percent != null ? m.percent.toFixed(1) + '%' : '');
    go.onclick = async () => {
      await loadChapter(m.chapterIndex);
      restoreAt(m.chapterIndex, () => scrollToOffsetValue(state.paras, m.charOffset));
      saveNow();
      $('#reader-bookmarks').hidden = true;
    };
    row.appendChild(go);
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = '删除书签';
    del.onclick = async () => {
      marks.splice(idx, 1);
      await window.api.invoke('novels:bookmarks-save', state.novel.novelId, marks);
      renderBookmarks();
    };
    row.appendChild(del);
    list.appendChild(row);
  });
}
async function addBookmark() {
  if (!state) return;
  const p = currentProgress();
  if (!p) return;
  let marks = [];
  try { marks = await window.api.invoke('novels:bookmarks', state.novel.novelId) || []; } catch { marks = []; }
  const chapterLen = state.currentText ? state.currentText.length : 0;
  const c = state.novel.chapters[p.chapterIndex];
  marks.push({
    chapterIndex: p.chapterIndex,
    charOffset: p.charOffset,
    label: (c ? c.title : '') + ' 附近',
    percent: chapterPercent(p.chapterIndex, p.charOffset, chapterLen, state.novel.chapters.length),
    createdAt: Date.now(),
  });
  await window.api.invoke('novels:bookmarks-save', state.novel.novelId, marks);
  renderBookmarks();
}

// —— 全文搜索 ——
function openSearch() {
  if (!state) return;
  hideOtherPanels('#reader-search');
  $('#reader-search').hidden = false;
  $('#reader-search-q').focus();
}
async function runSearch() {
  if (!state) return;
  const q = $('#reader-search-q').value.trim();
  const box = $('#reader-search-results');
  box.innerHTML = '';
  if (!q) return;
  let results = [];
  try { results = await window.api.invoke('novels:search-text', state.novel.novelId, q) || []; } catch { results = []; }
  const head = document.createElement('div');
  head.className = 'bm-empty';
  head.textContent = results.length ? `共 ${results.length} 处命中` : '无命中';
  box.appendChild(head);
  results.forEach((r) => {
    const b = document.createElement('button');
    b.className = 'search-hit';
    b.textContent = `[${r.title}] ${r.excerpt}`;
    b.onclick = async () => {
      await loadChapter(r.chapterIndex);
      restoreAt(r.chapterIndex, () => scrollToOffsetValue(state.paras, r.charOffset));
      saveNow();
    };
    box.appendChild(b);
  });
}

function closePanels() {
  ['#reader-toc', '#reader-settings', '#reader-bookmarks', '#reader-search', '#reader-source', '#reader-sources'].forEach((s) => { const el = $(s); if (el) el.hidden = true; });
  if (window.__settings) window.api.send('ui:panel-open', false);
}

// —— 书城（在线书源搜索 + 加入书架）——
function openSourcePanel() {
  if (!state) return;
  hideOtherPanels('#reader-source');
  $('#reader-source').hidden = false;
  $('#src-q').focus();
}

async function runSourceSearch() {
  if (!state) return;
  const q = $('#src-q').value.trim();
  const box = $('#src-results');
  box.innerHTML = '';
  if (!q) return;
  const head = document.createElement('div');
  head.className = 'bm-empty';
  head.textContent = '搜索中…';
  box.appendChild(head);
  let results = [];
  try { results = await window.api.invoke('booksources:search', q) || []; } catch { results = []; }
  box.innerHTML = '';
  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'bm-empty';
    empty.textContent = '无结果（检查书源是否启用/规则是否过期）';
    box.appendChild(empty);
    return;
  }
  results.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'bm-row';
    const go = document.createElement('button');
    go.className = 'bm-go';
    go.textContent = `《${r.title}》 ${r.author || ''} · ${r.sourceName}`;
    row.appendChild(go);
    const add = document.createElement('button');
    add.textContent = '加入书架';
    add.dataset.action = 'src-shelf';
    add.dataset.sourceId = r.sourceId;
    add.dataset.bookUrl = r.url;
    add.dataset.title = r.title;
    add.dataset.author = r.author || '';
    row.appendChild(add);
    box.appendChild(row);
  });
}

async function addToShelf(ds) {
  if (!ds || !ds.sourceId) return;
  const btn = document.querySelector(`[data-action="src-shelf"][data-source-id="${ds.sourceId}"][data-book-url="${CSS.escape(ds.bookUrl)}"]`);
  if (btn) { btn.textContent = '导入中…'; btn.disabled = true; }
  try {
    const novel = await window.api.invoke('novels:import-online', {
      sourceId: ds.sourceId, bookUrl: ds.bookUrl, title: ds.title, author: ds.author,
    });
    await window.api.invoke('tabs:create-novel', novel);
    $('#reader-source').hidden = true;
  } catch (err) {
    if (btn) { btn.textContent = '失败'; btn.disabled = false; }
    const head = document.querySelector('#src-results .bm-empty');
    const note = document.createElement('div');
    note.className = 'bm-empty';
    note.textContent = '导入失败：' + (err && err.message ? err.message : err);
    if (head) head.after(note); else $('#src-results').appendChild(note);
  }
}

// —— 书源管理（列表启停/删除 + JSON 导入）——
async function openSourcesManage() {
  hideOtherPanels('#reader-sources');
  $('#reader-sources').hidden = false;
  await renderSourcesList();
}
async function renderSourcesList() {
  const list = $('#srcs-list');
  list.innerHTML = '';
  let sources = [];
  try { sources = await window.api.invoke('booksources:list') || []; } catch { sources = []; }
  if (!sources.length) {
    const empty = document.createElement('div');
    empty.className = 'bm-empty';
    empty.textContent = '暂无书源：粘贴 JSON 导入，或导入他人分享的书源文件';
    list.appendChild(empty);
  }
  sources.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'srcs-row';
    const enable = document.createElement('input');
    enable.type = 'checkbox';
    enable.checked = s.enabled !== false;
    enable.dataset.action = 'srcs-toggle';
    enable.dataset.id = s.id;
    row.appendChild(enable);
    const name = document.createElement('span');
    name.className = 'srcs-name';
    name.textContent = s.name + (s.search ? '' : '');
    name.title = s.search ? s.search.url : '';
    row.appendChild(name);
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = '删除书源';
    del.dataset.action = 'srcs-del';
    del.dataset.id = s.id;
    row.appendChild(del);
    list.appendChild(row);
  });
}
async function persistSources(sources) {
  const normed = await window.api.invoke('booksources:save', sources);
  await renderSourcesList();
  return normed;
}
async function toggleSource(id, enabled) {
  const sources = await window.api.invoke('booksources:list') || [];
  const s = sources.find((x) => x.id === id);
  if (s) { s.enabled = !!enabled; await persistSources(sources); }
}
async function deleteSource(id) {
  let sources = await window.api.invoke('booksources:list') || [];
  sources = sources.filter((x) => x.id !== id);
  await persistSources(sources);
}
async function importSourcesJson() {
  const box = $('#srcs-json');
  const text = box.value.trim();
  if (!text) return;
  let parsed;
  try { parsed = JSON.parse(text); } catch { box.value = 'JSON 解析失败'; return; }
  const incoming = Array.isArray(parsed) ? parsed : [parsed];
  const sources = await window.api.invoke('booksources:list') || [];
  for (const raw of incoming) {
    try {
      const normed = await window.api.invoke('booksources:save', sources.concat([raw]));
      sources.length = 0;
      sources.push(...normed);
    } catch (err) {
      box.value = '导入失败：' + (err && err.message ? err.message : err);
      return;
    }
  }
  box.value = '';
  await renderSourcesList();
}

// —— 构建阅读器 DOM ——
function buildReaderDom() {
  const view = readerView();
  view.innerHTML = `
    <div id="reader-toolbar">
      <button data-action="toc" title="章节目录">目录</button>
      <button data-action="bookmarks" title="书签">书签</button>
      <button data-action="search" title="全文搜索">搜索</button>
      <button data-action="source" title="书城（在线搜书）">书城</button>
      <button id="reader-auto" data-action="auto" title="自动翻页（空格）">⏵</button>
      <button data-action="settings" title="阅读设置">设置</button>
      <span class="reader-spacer"></span>
      <button data-action="back" title="切回伪装界面">返回伪装</button>
    </div>
    <div id="reader-content"></div>
    <div id="reader-status"><span id="rs-chapter"></span><span class="rs-gap"></span><span id="rs-percent"></span><span id="rs-pos"></span></div>
    <div id="reader-toc" hidden>
      <div id="reader-toc-head"><button data-action="toc-close">← 返回</button><span id="reader-toc-title"></span><button id="reader-toc-refresh" data-action="toc-refresh" hidden>刷新目录</button></div>
      <div id="reader-toc-list"></div>
    </div>
    <div id="reader-bookmarks" hidden>
      <div class="panel-head"><button data-action="bm-close">← 返回</button><span>书签</span><button data-action="bm-add">加书签</button></div>
      <div id="reader-bm-list"></div>
    </div>
    <div id="reader-search" hidden>
      <div class="panel-head"><button data-action="search-close">← 返回</button><span>全文搜索</span></div>
      <div class="search-row"><input id="reader-search-q" type="text" placeholder="搜索正文关键词"><button data-action="search-run">搜索</button></div>
      <div id="reader-search-results"></div>
    </div>
    <div id="reader-source" hidden>
      <div class="panel-head"><button data-action="src-close">← 返回</button><span>书城</span><button data-action="src-manage">管理书源</button></div>
      <div class="search-row"><input id="src-q" type="text" placeholder="按书名/作者关键字搜索"><button data-action="src-search">搜索</button></div>
      <div id="src-results"></div>
    </div>
    <div id="reader-sources" hidden>
      <div class="panel-head"><button data-action="srcs-close">← 返回</button><span>书源管理</span></div>
      <div id="srcs-list"></div>
      <div class="srcs-edit">
        <textarea id="srcs-json" rows="6" placeholder='粘贴书源 JSON（单个对象或数组），字段见规格文档'></textarea>
        <button data-action="srcs-import">导入书源</button>
      </div>
    </div>
    <div id="reader-settings" hidden>
      <div class="rs-title">排版</div>
      <div class="rs-row"><label>模式</label>
        <span class="rs-fonts">
          <label><input type="radio" name="rs-mode" id="rs-mode-page" value="page">翻页</label>
          <label><input type="radio" name="rs-mode" id="rs-mode-scroll" value="scroll">滚动</label>
        </span>
      </div>
      <div class="rs-row"><label>字号</label><input id="rs-size" type="range" min="12" max="28" step="1"><span id="rs-size-v"></span></div>
      <div class="rs-row"><label>行距</label><input id="rs-linegap" type="range" min="1.5" max="2.6" step="0.1"><span id="rs-linegap-v"></span></div>
      <div class="rs-row"><label>段距</label><input id="rs-paragap" type="range" min="0" max="1.5" step="0.1"><span id="rs-paragap-v"></span></div>
      <div class="rs-row"><label>边距</label><input id="rs-margin" type="range" min="16" max="64" step="4"><span id="rs-margin-v"></span></div>
      <div class="rs-row"><label>缩进</label><input id="rs-indent" type="checkbox" title="段首缩进两字"></div>
      <div class="rs-row"><label>字体</label>
        <span class="rs-fonts">
          <label><input type="radio" name="rs-font" value="yahei">雅黑</label>
          <label><input type="radio" name="rs-font" value="song">宋体</label>
          <label><input type="radio" name="rs-font" value="kai">楷体</label>
        </span>
      </div>
      <div class="rs-title">主题</div>
      <div class="rs-row"><label>预设</label>
        <select id="rs-theme">
          <option value="paper">纸白</option>
          <option value="sepia">羊皮</option>
          <option value="green">护眼</option>
          <option value="dark">暗色</option>
        </select>
        <input id="rs-color" type="color" title="自定义字体颜色"><button data-action="rs-color-reset" title="恢复默认字色">默认</button>
      </div>
      <div class="rs-title">翻页</div>
      <div class="rs-row"><label>保留行</label><input id="rs-overlap" type="range" min="0" max="3" step="1" title="翻页时页面底部保留的行数（连续感）"><span id="rs-overlap-v"></span></div>
      <div class="rs-row"><label>自动翻页</label><input id="rs-auto" type="range" min="1000" max="10000" step="500"><span id="rs-auto-v"></span></div>
      <div class="rs-row"><label>透明背景</label><input id="rs-transparent" type="checkbox" title="只显示小说文本（Ctrl+Shift+T 切换）"></div>
      <div class="rs-title">章节识别</div>
      <div class="rs-row"><label>规则</label>
        <select id="rs-rule">
          <option value="auto">自动识别</option>
          <option value="keyword">行首关键字</option>
          <option value="regex">自定义正则</option>
        </select>
      </div>
      <div class="rs-row"><label>关键字</label><input id="rs-rule-keyword" type="text" placeholder="如：章节"></div>
      <div class="rs-row"><label>正则</label><input id="rs-rule-regex" type="text" placeholder="如：^第\\\\d+章"></div>
      <div class="rs-row"><button data-action="rs-reparse">应用规则并重析目录</button></div>
      <button data-action="rs-close">关闭</button>
    </div>`;
  // 进度保存：scroll 不冒泡，直接监听内容区
  readerEl().addEventListener('scroll', () => { scheduleSave(); maybeAppendNext(); updateStatus(); });
  readerEl().addEventListener('wheel', onWheel, { passive: false });
  readerEl().addEventListener('click', onClickZone);
  document.addEventListener('keydown', onKeyDown);

  // 工具栏/面板统一事件委托
  view.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'toc') { closeReaderSettings(); $('#reader-bookmarks').hidden = true; $('#reader-search').hidden = true; openToc(); }
    else if (action === 'toc-close') closeToc();
    else if (action === 'toc-goto') gotoChapter(Number(btn.dataset.i));
    else if (action === 'toc-refresh') refreshToc();
    else if (action === 'bookmarks') { closeToc(); closeReaderSettings(); $('#reader-search').hidden = true; openBookmarks(); }
    else if (action === 'bm-close') $('#reader-bookmarks').hidden = true;
    else if (action === 'bm-add') addBookmark();
    else if (action === 'search') { closeToc(); closeReaderSettings(); $('#reader-bookmarks').hidden = true; openSearch(); }
    else if (action === 'search-close') $('#reader-search').hidden = true;
    else if (action === 'search-run') runSearch();
    else if (action === 'source') { openSourcePanel(); }
    else if (action === 'src-close') $('#reader-source').hidden = true;
    else if (action === 'src-search') runSourceSearch();
    else if (action === 'src-shelf') addToShelf(btn.dataset);
    else if (action === 'src-manage') openSourcesManage();
    else if (action === 'srcs-close') $('#reader-sources').hidden = true;
    else if (action === 'srcs-import') importSourcesJson();
    else if (action === 'srcs-toggle') toggleSource(btn.dataset.id, btn.checked);
    else if (action === 'srcs-del') deleteSource(btn.dataset.id);
    else if (action === 'auto') toggleAutoPage();
    else if (action === 'settings') { closeToc(); $('#reader-bookmarks').hidden = true; $('#reader-search').hidden = true; openReaderSettings(); }
    else if (action === 'rs-close') closeReaderSettings();
    else if (action === 'rs-color-reset') {
      setReaderPrefs({ color: null });
      const p = prefs();
      $('#rs-color').value = p.dark ? '#b8b8b8' : '#333333';
    }
    else if (action === 'rs-reparse') applyChapterRule();
    else if (action === 'back') setMode('ad');
  });
  // 搜索框回车
  $('#reader-search-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  $('#src-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSourceSearch(); });

  // 设置面板控件：即点即改（滑杆 input 实时、radio/change 时写盘）
  $('#rs-size').addEventListener('input', (e) => {
    const v = +e.target.value;
    $('#rs-size-v').textContent = v;
    setReaderPrefs({ fontSize: v });
  });
  $('#rs-linegap').addEventListener('input', (e) => {
    const v = +e.target.value;
    $('#rs-linegap-v').textContent = v;
    setReaderPrefs({ lineGap: v });
  });
  $('#rs-paragap').addEventListener('input', (e) => {
    const v = +e.target.value;
    $('#rs-paragap-v').textContent = v;
    setReaderPrefs({ paraGap: v });
  });
  $('#rs-margin').addEventListener('input', (e) => {
    const v = +e.target.value;
    $('#rs-margin-v').textContent = v;
    setReaderPrefs({ margin: v });
  });
  $('#rs-indent').addEventListener('change', (e) => setReaderPrefs({ indent: e.target.checked }));
  document.querySelectorAll('#reader-settings input[name="rs-font"]').forEach((r) => {
    r.addEventListener('change', () => setReaderPrefs({ fontFamily: r.value }));
  });
  document.querySelectorAll('#reader-settings input[name="rs-mode"]').forEach((r) => {
    r.addEventListener('change', () => setReaderPrefs({ mode: r.value }));
  });
  $('#rs-theme').addEventListener('change', (e) => setReaderPrefs({ theme: e.target.value }));
  $('#rs-color').addEventListener('input', (e) => setReaderPrefs({ color: e.target.value }));
  $('#rs-overlap').addEventListener('input', (e) => {
    const v = +e.target.value;
    $('#rs-overlap-v').textContent = v;
    setReaderPrefs({ pageOverlap: v });
  });
  $('#rs-auto').addEventListener('input', (e) => {
    const v = +e.target.value;
    $('#rs-auto-v').textContent = (v / 1000) + 's';
    setReaderPrefs({ autoPageMs: v });
    if (state && state.autoTimer) { stopAutoPage(); startAutoPage(); } // 间隔即时生效
  });
  $('#rs-transparent').addEventListener('change', (e) => setReaderPrefs({ transparent: e.target.checked }));

  // 点面板外关闭设置面板（其他面板有"返回"按钮，不外关——防止误触）
  document.addEventListener('click', (e) => {
    const panel = $('#reader-settings');
    if (panel.hidden) return;
    if (e.target.closest('#reader-settings') || e.target.closest('[data-action="settings"]')) return;
    closeReaderSettings();
  });

  // 透明模式任意位置拖动窗口：pointer 驱动 + pointer capture（不用 drag 区——吞滚轮）
  let windowDragging = false;
  view.addEventListener('pointerdown', (e) => {
    if (readerView().dataset.transparent !== 'true') return; // 仅透明模式
    if (e.target.closest('#reader-settings') || e.target.closest('#reader-toc')
      || e.target.closest('#reader-bookmarks') || e.target.closest('#reader-search')
      || e.target.closest('#reader-source') || e.target.closest('#reader-sources')) return; // 面板仍可点
    windowDragging = true;
    view.setPointerCapture(e.pointerId);
    window.api.send('window:drag-start', {
      offsetX: e.screenX - window.screenX,
      offsetY: e.screenY - window.screenY,
    });
  });
  const endWindowDrag = () => {
    if (!windowDragging) return;
    windowDragging = false;
    window.api.send('window:drag-end');
  };
  view.addEventListener('pointerup', endWindowDrag);
  view.addEventListener('pointercancel', endWindowDrag);
}

// 章节识别规则：保存偏好 → 主进程重析目录 → 更新元数据与目录面板
async function applyChapterRule() {
  if (!state) return;
  const mode = $('#rs-rule').value;
  const rule = {
    mode,
    keyword: $('#rs-rule-keyword').value.trim(),
    regex: $('#rs-rule-regex').value.trim(),
  };
  if (mode === 'regex' && rule.regex) {
    try { new RegExp(rule.regex); } catch { $('#rs-reparse').textContent = '正则无效'; setTimeout(() => { const b = $('#rs-reparse'); if (b) b.textContent = '应用规则并重析目录'; }, 1500); return; }
  }
  setReaderPrefs({ chapterRule: rule });
  try {
    const novel = await window.api.invoke('novels:reparse', state.novel.novelId, rule);
    if (novel && novel.chapters) {
      state.novel = novel;
      if (window.__novels) window.__novels.set(novel.novelId, novel);
      if (novel.chapterIndexOffset != null) state.chapterIndex = Math.min(state.chapterIndex, novel.chapters.length - 1);
      await loadChapter(Math.min(state.chapterIndex, Math.max(0, novel.chapters.length - 1)));
      saveNow();
    }
  } catch { /* 重析失败（如在线书）：静默，规则已保存 */ }
}

// 在线书目录刷新（阶段 6 接 IPC）
async function refreshToc() {
  if (!state || !state.novel.isOnline) return;
  try {
    const novel = await window.api.invoke('novels:refresh-toc', state.novel.novelId);
    if (novel && novel.chapters) {
      state.novel = novel;
      if (window.__novels) window.__novels.set(novel.novelId, novel);
      openToc();
    }
  } catch { /* 刷新失败静默 */ }
}

// —— 百分比跳转：点击状态栏百分比 → 原位变输入框 → 回车主进程精确定位 ——
function bindPercentJump() {
  const span = $('#rs-percent');
  if (!span) return;
  span.style.cursor = 'pointer';
  span.title = '点击跳转到指定百分比';
  span.addEventListener('click', () => {
    if (!state || span.dataset.editing) return;
    span.dataset.editing = '1';
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'rs-percent-input';
    input.style.width = '48px';
    input.placeholder = span.textContent;
    span.textContent = '';
    span.appendChild(input);
    input.focus();
    input.select();
    const done = () => { delete span.dataset.editing; updateStatus(); };
    input.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') { if (e.key === 'Escape') done(); return; }
      const v = parseFloat(input.value);
      if (isNaN(v)) { done(); return; }
      try {
        const target = await window.api.invoke('novels:percent-target', state.novel.novelId, v);
        if (target) {
          await loadChapter(target.chapterIndex);
          restoreAt(target.chapterIndex, () => scrollToOffsetValue(state.paras, target.charOffset));
          saveNow();
        }
      } catch { /* 定位失败静默 */ }
      done();
    });
    input.addEventListener('blur', done);
  });
}

// 浏览器环境才构建 DOM；Node 测试环境只导出纯函数
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  buildReaderDom();
  bindPercentJump();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    computeProgress, restoreScroll, paragraphOffsets, restoreProgress, chapterPercent, scrollToOffsetValue,
    openNovel, loadChapter, saveNow, applyReaderPrefs, openToc, closeToc, gotoChapter, pageReader, turnPage,
  };
}
