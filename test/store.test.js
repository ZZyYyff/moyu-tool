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
    assert.equal(s.adBounds, null); // Ruling Z：双尺寸记忆默认均为 null
    assert.equal(s.contentBounds, null);
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

test('Ruling Z 迁移：旧格式 windowBounds → adBounds，contentBounds 为 null', () => {
  withTempDir(dir => {
    const legacy = { windowBounds: { x: 10, y: 20, width: 340, height: 280 }, adStyle: 'game' };
    store.saveSettings(legacy, dir);
    const s = store.loadSettings(dir);
    assert.deepEqual(s.adBounds, legacy.windowBounds);
    assert.equal(s.contentBounds, null);
    assert.equal(s.adStyle, 'game'); // 其余字段照常合并
  });
});

test('Ruling Z 迁移：已有 adBounds 时 windowBounds 不覆盖', () => {
  withTempDir(dir => {
    store.saveSettings(
      { windowBounds: { x: 10, y: 20, width: 340, height: 280 }, adBounds: { x: 1, y: 2, width: 300, height: 250 } },
      dir
    );
    assert.deepEqual(store.loadSettings(dir).adBounds, { x: 1, y: 2, width: 300, height: 250 });
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

test('settings.json 损坏且 .bak 被目录占用时仍返回默认不抛错', () => {
  withTempDir(dir => {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'settings.json.bak')); // 备份目标是目录 → renameSync 失败
    fs.writeFileSync(path.join(dir, 'settings.json'), '{broken json');
    const s = store.loadSettings(dir); // 不得抛异常（否则启动崩溃，违反"损坏→默认"契约）
    assert.equal(s.adStyle, 'news');
    assert.ok(fs.existsSync(path.join(dir, 'settings.json'))); // 原文件保留（放弃备份）
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
