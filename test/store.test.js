// test/store.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../main/store');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-store-'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('loadSettings 文件缺失时返回默认值', () => {
  withTempDir(dir => {
    const s = store.loadSettings(dir);
    assert.equal(s.adStyle, 'news');
    assert.equal(s.hotkeys.toggleWindow, 'Ctrl+Shift+Z');
    assert.equal(s.hotkeys.toggleMode, 'Ctrl+Shift+X');
    assert.equal(s.reader.fontSize, 16);
    assert.deepEqual(s.lastTabs, []);
    assert.deepEqual(s.lastNovels, {});
  });
});

test('saveSettings 后 loadSettings 取回同一对象', () => {
  withTempDir(dir => {
    const s = store.loadSettings(dir);
    s.adStyle = 'game';
    s.hotkeys.toggleMode = 'Alt+Q';
    s.lastTabs = [{ type: 'web', url: 'https://a.com' }, { type: 'novel', novelId: 'abc123' }];
    s.lastNovels = { abc123: { novelId: 'abc123', title: '书', chapters: [{ title: '第1章', startLine: 0 }] } };
    store.saveSettings(s, dir);
    const got = store.loadSettings(dir);
    assert.equal(got.adStyle, 'game');
    assert.equal(got.hotkeys.toggleMode, 'Alt+Q');
    assert.deepEqual(got.lastTabs, s.lastTabs);
    assert.deepEqual(got.lastNovels, s.lastNovels);
  });
});

test('lastNovels 非法形状（数组/非对象）回落默认 {}', () => {
  withTempDir(dir => {
    store.saveSettings({ lastNovels: [1, 2] }, dir);
    assert.deepEqual(store.loadSettings(dir).lastNovels, {});
    store.saveSettings({ lastNovels: 'nope' }, dir);
    assert.deepEqual(store.loadSettings(dir).lastNovels, {});
  });
});

test('settings.json 损坏时返回默认并备份损坏文件', () => {
  withTempDir(dir => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), '{broken json');
    const s = store.loadSettings(dir);
    assert.equal(s.adStyle, 'news');
    assert.ok(fs.existsSync(path.join(dir, 'settings.json.bak')));
  });
});

test('progress 读写与损坏恢复', () => {
  withTempDir(dir => {
    store.saveProgress({ n1: { chapterIndex: 2, scrollRatio: 0.5, updatedAt: 1 } }, dir);
    assert.equal(store.loadProgress(dir).n1.chapterIndex, 2);
    fs.writeFileSync(path.join(dir, 'progress.json'), 'garbage');
    assert.deepEqual(store.loadProgress(dir), {});
    assert.ok(fs.existsSync(path.join(dir, 'progress.json.bak')));
  });
});
