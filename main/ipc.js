// main/ipc.js
const path = require('path');
const { ipcMain } = require('electron');
const store = require('./store');
const novels = require('./novels');

// Ruling C：novels:import 成功后登记的内存缓存（模块级 Map）
// { novelId: { novel, storedPath } }，novels:chapter 从这里取 storedPath
const novelsMeta = new Map();

// 注册底座 IPC 通道。参数由 main.js 装配时注入：
// { userDataDir, shellWin, getMode, setMode, getTabsSnapshot }
function register({ userDataDir, shellWin, getMode, setMode, getTabsSnapshot }) {
  ipcMain.handle('shell:ready', () => ({
    settings: store.loadSettings(userDataDir),
    mode: getMode(),
    tabs: getTabsSnapshot(),
  }));
  ipcMain.on('mode:set', (_e, mode) => setMode(mode));
  ipcMain.handle('settings:get', () => store.loadSettings(userDataDir));
  ipcMain.handle('settings:save', (_e, partial) => {
    const s = { ...store.loadSettings(userDataDir), ...partial };
    store.saveSettings(s, userDataDir);
    shellWin.webContents.send('settings:changed', s);
    return s;
  });

  // —— 小说（Task 9）——
  ipcMain.handle('novels:import', async (_e, filePath) => {
    const novel = await novels.importNovel(filePath, path.join(userDataDir, 'novels'));
    // Ruling C：import 成功后登记到内存缓存（T11 拖放 / T12 会话恢复依赖）
    novelsMeta.set(novel.novelId, { novel, storedPath: path.join(userDataDir, 'novels', novel.novelId + '.txt') });
    return novel;
  });
  ipcMain.handle('novels:chapter', (_e, novelId, chapterIndex) => {
    const meta = novelsMeta.get(novelId);
    const chapter = meta && meta.novel.chapters[chapterIndex];
    if (!meta || !chapter) return { title: '', text: '' };
    const next = meta.novel.chapters[chapterIndex + 1]; // nextStart = 下一章 startLine
    const text = novels.getChapterText(meta.storedPath, meta.novel.totalLines, chapter, next ? next.startLine : undefined);
    return { title: chapter.title, text };
  });
  ipcMain.handle('novels:get-progress', (_e, novelId) => store.loadProgress(userDataDir)[novelId] || null);
  ipcMain.handle('novels:progress', (_e, novelId, progress) => {
    const map = store.loadProgress(userDataDir);
    map[novelId] = progress;
    store.saveProgress(map, userDataDir);
  });
}

module.exports = { register };
