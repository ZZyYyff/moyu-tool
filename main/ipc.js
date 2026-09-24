// main/ipc.js
const path = require('path');
const fs = require('fs');
const { ipcMain } = require('electron');
const store = require('./store');
const novels = require('./novels');
const hotkeys = require('./hotkeys');
const booksource = require('./booksource');

// Ruling C：novels:import 成功后登记的内存缓存（模块级 Map）
// { novelId: { novel, storedPath } }，novels:chapter 从这里取 storedPath
const novelsMeta = new Map();

// 存储文件路径约定（import 与 T12 会话恢复重建 novelsMeta 共用，防止两处漂移）
function novelStoredPath(novelId, userDataDir) {
  return path.join(userDataDir, 'novels', novelId + '.txt');
}

// 注册底座 IPC 通道。参数由 main.js 装配时注入：
// { userDataDir, shellWin, getMode, setMode, getTabsSnapshot, tabs }
function register({ userDataDir, shellWin, getMode, setMode, getTabsSnapshot, tabs }) {
  ipcMain.handle('shell:ready', () => ({
    settings: store.loadSettings(userDataDir),
    mode: getMode(),
    tabs: getTabsSnapshot(),
  }));
  ipcMain.on('mode:set', (_e, mode) => setMode(mode));
  ipcMain.handle('settings:get', () => store.loadSettings(userDataDir));

  // —— 多标签（Task 10）——
  ipcMain.handle('tabs:create', (_e, url) => tabs.createWebTab(url));
  ipcMain.handle('tabs:create-novel', (_e, novel) => tabs.createNovelTab(novel));
  ipcMain.on('tabs:close', (_e, id) => tabs.closeTab(id));
  ipcMain.on('tabs:activate', (_e, id) => tabs.activateTab(id));
  ipcMain.on('tabs:navigate', (_e, d) => tabs.navigate(d));
  ipcMain.on('tabs:reload-active', () => {
    const t = tabs.getTab(tabs.getActiveTabId());
    if (t && t.view) {
      t.failed = false; // 重试意图：成功则 did-finish-load 恢复挂载；再失败则 did-fail-load 重新置位
      t.view.webContents.reload();
    }
  });
  // 地址栏显隐同步主进程（brief 缺口补接）：显示时视图下移 ADDRBAR_H，避免网页盖住地址栏
  ipcMain.on('tabs:address-bar', (_e, visible) => tabs.setAddressBarVisible(visible));
  ipcMain.handle('settings:save', (_e, partial) => {
    const s = { ...store.loadSettings(userDataDir), ...partial };
    store.saveSettings(s, userDataDir);
    shellWin.webContents.send('settings:changed', s);
    return s;
  });

  // —— 设置面板（Task 13）——
  // 改键：applyHotkeyChange 内部 —— 冲突/非法 → 不写盘返回 {ok:false, reason}；
  // 成功 → 全局注册新组合、注销旧组合并持久化。渲染器失败时用 oldValue 回显输入框。
  ipcMain.handle('settings:apply-hotkey', (_e, kind, acc) => {
    const s = store.loadSettings(userDataDir);
    const old = s.hotkeys[kind];
    const r = hotkeys.applyHotkeyChange(kind, acc, userDataDir);
    if (!r.ok) return { ok: false, reason: r.reason, oldValue: old };
    return { ok: true, oldValue: old };
  });

  // —— 小说（Task 9）——
  // 在线书正文按需抓取并缓存进存储 txt（appendChapter 维护 startLine/totalLines），
  // 抓完持久化 meta；重复调用幂等（startLine 非空直接返回）
  async function fetchOnlineChapter(meta, i, dir) {
    const ch = meta.novel.chapters[i];
    if (!ch || ch.startLine != null) return;
    const src = booksource.loadSources(dir).find((s) => s.id === meta.novel.source.id);
    if (!src) throw new Error('书源已删除，无法抓取正文');
    const content = await booksource.fetchContent(src, ch.url);
    if (!content) throw new Error('正文抓取为空');
    const { startLine, addedLines } = novels.appendChapter(meta.storedPath, content);
    ch.startLine = startLine;
    meta.novel.totalLines += addedLines;
    const s = store.loadSettings(dir);
    s.lastNovels = { ...(s.lastNovels || {}), [meta.novel.novelId]: meta.novel };
    store.saveSettings(s, dir);
  }
  ipcMain.handle('novels:import', async (_e, filePath) => {
    // 规格 §8：仅接受绝对路径（拖放经 webUtils.getPathForFile 一定为绝对路径）
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('非法文件路径');
    const novel = await novels.importNovel(filePath, path.join(userDataDir, 'novels'));
    // Ruling C：import 成功后登记到内存缓存（T11 拖放 / T12 会话恢复依赖）
    novelsMeta.set(novel.novelId, { novel, storedPath: novelStoredPath(novel.novelId, userDataDir) });
    // Task 12：元数据持久化进 settings.lastNovels —— 会话恢复时 novelsMeta 从这里重建（同会话重导则覆盖）
    const s = store.loadSettings(userDataDir);
    s.lastNovels = { ...(s.lastNovels || {}), [novel.novelId]: novel };
    store.saveSettings(s, userDataDir);
    return novel;
  });
  ipcMain.handle('novels:chapter', async (_e, novelId, chapterIndex) => {
    const meta = novelsMeta.get(novelId);
    const chapter = meta && meta.novel.chapters[chapterIndex];
    if (!meta || !chapter) return { title: '', text: '' };
    // 在线书：正文按需抓取并缓存进存储 txt（Reader 的按需驻留 + 本地缓存思路）
    if (chapter.startLine == null && meta.novel.isOnline) {
      await fetchOnlineChapter(meta, chapterIndex, userDataDir);
      // 预取下一章（后台，不阻塞本返回；失败静默——阅读时再试）
      const next = meta.novel.chapters[chapterIndex + 1];
      if (next && next.startLine == null) fetchOnlineChapter(meta, chapterIndex + 1, userDataDir).catch(() => {});
    }
    const next = meta.novel.chapters[chapterIndex + 1];
    const nextStart = next && next.startLine != null ? next.startLine : undefined;
    const text = novels.getChapterText(meta.storedPath, meta.novel.totalLines, chapter, nextStart);
    return { title: chapter.title, text };
  });
  ipcMain.handle('novels:get-progress', (_e, novelId) => store.loadProgress(userDataDir)[novelId] || null);
  ipcMain.handle('novels:progress', (_e, novelId, progress) => {
    const map = store.loadProgress(userDataDir);
    map[novelId] = progress;
    store.saveProgress(map, userDataDir);
  });

  // —— 阅读器 v2：书签 / 全文搜索 / 百分比定位 / 章节规则重析 ——
  ipcMain.handle('novels:bookmarks', (_e, novelId) => store.loadBookmarks(userDataDir)[novelId] || []);
  ipcMain.handle('novels:bookmarks-save', (_e, novelId, marks) => {
    if (!Array.isArray(marks)) throw new Error('书签格式非法');
    const map = store.loadBookmarks(userDataDir);
    map[novelId] = marks;
    store.saveBookmarks(map, userDataDir);
  });
  ipcMain.handle('novels:search-text', (_e, novelId, query) => {
    const meta = novelsMeta.get(novelId);
    if (!meta || typeof query !== 'string' || !query.trim()) return [];
    return novels.searchText(meta.storedPath, meta.novel, query.trim());
  });
  ipcMain.handle('novels:percent-target', (_e, novelId, pct) => {
    const meta = novelsMeta.get(novelId);
    if (!meta) return null;
    return novels.percentTarget(meta.storedPath, meta.novel, pct);
  });
  ipcMain.handle('novels:reparse', (_e, novelId, rule) => {
    const meta = novelsMeta.get(novelId);
    if (!meta || meta.novel.isOnline) return null; // 在线书目录来自书源，不重析
    const text = fs.readFileSync(meta.storedPath, 'utf8');
    const chapters = novels.parseChapters(text, rule);
    meta.novel.chapters = chapters;
    meta.novel.chapterCount = chapters.length;
    const s = store.loadSettings(userDataDir);
    s.lastNovels = { ...(s.lastNovels || {}), [novelId]: meta.novel };
    store.saveSettings(s, userDataDir);
    return meta.novel;
  });

  // —— 在线书源（参照 Reader 书源机制，CSS 选择器规则）——
  ipcMain.handle('booksources:list', () => booksource.loadSources(userDataDir));
  ipcMain.handle('booksources:save', (_e, list) => {
    if (!Array.isArray(list)) throw new Error('书源列表非法');
    const normed = list.map((s) => booksource.validateSource(s));
    booksource.saveSources(normed, userDataDir);
    return normed;
  });
  ipcMain.handle('booksources:search', (_e, keyword) => {
    if (typeof keyword !== 'string' || !keyword.trim()) return [];
    return booksource.searchAllSources(booksource.loadSources(userDataDir), keyword.trim());
  });
  // 加入书架：抓目录 → 建在线书元数据（正文按需抓，见 novels:chapter）
  ipcMain.handle('novels:import-online', async (_e, payload) => {
    if (!payload || typeof payload !== 'object') throw new Error('参数非法');
    const src = booksource.loadSources(userDataDir).find((s) => s.id === payload.sourceId);
    if (!src) throw new Error('书源不存在或已删除');
    if (typeof payload.bookUrl !== 'string' || !/^https?:\/\//i.test(payload.bookUrl)) throw new Error('书籍地址非法');
    const toc = await booksource.fetchToc(src, payload.bookUrl);
    if (!toc.length) throw new Error('未解析到章节目录（检查书源规则或站点结构）');
    const novelId = booksource.onlineNovelIdFor(src.id, payload.bookUrl);
    const novel = {
      novelId,
      title: String(payload.title || '未命名').slice(0, 60),
      author: String(payload.author || '').slice(0, 40),
      encoding: 'utf8',
      isOnline: true,
      source: { id: src.id, bookUrl: payload.bookUrl, name: src.name },
      totalLines: 0,
      chapterCount: toc.length,
      chapters: toc.map((t) => ({ title: t.title, url: t.url, startLine: null })),
    };
    const storedPath = novelStoredPath(novelId, userDataDir);
    fs.writeFileSync(storedPath, '', 'utf8');
    novelsMeta.set(novelId, { novel, storedPath });
    const s = store.loadSettings(userDataDir);
    s.lastNovels = { ...(s.lastNovels || {}), [novelId]: novel };
    store.saveSettings(s, userDataDir);
    return novel;
  });
  // 目录刷新：重抓站点目录，尾部增量合并（已读章节 startLine 原样保留）
  ipcMain.handle('novels:refresh-toc', async (_e, novelId) => {
    const meta = novelsMeta.get(novelId);
    if (!meta || !meta.novel.isOnline) return null;
    const src = booksource.loadSources(userDataDir).find((s) => s.id === meta.novel.source.id);
    if (!src) throw new Error('书源已删除，无法刷新');
    const toc = await booksource.fetchToc(src, meta.novel.source.bookUrl);
    meta.novel.chapters = booksource.mergeToc(meta.novel.chapters, toc.map((t) => ({ title: t.title, url: t.url })));
    meta.novel.chapterCount = meta.novel.chapters.length;
    const s = store.loadSettings(userDataDir);
    s.lastNovels = { ...(s.lastNovels || {}), [novelId]: meta.novel };
    store.saveSettings(s, userDataDir);
    return meta.novel;
  });
}

module.exports = { register, novelsMeta, novelStoredPath };
