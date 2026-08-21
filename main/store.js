// main/store.js
const fs = require('fs');
const path = require('path');

function defaultSettings() {
  return {
    windowBounds: null,
    adStyle: 'news',
    hotkeys: { toggleWindow: 'Ctrl+Shift+Z', toggleMode: 'Ctrl+Shift+X' },
    reader: { fontSize: 16, fontFamily: 'yahei', dark: false },
    lastTabs: [],
    lastNovels: {}, // Task 12：novelId → Novel 元数据（会话恢复时重建 novelsMeta）
  };
}

// dir 参数便于测试注入；运行时由 ipc.js 传 app.getPath('userData')
function readJson(dir, name) {
  const file = path.join(dir, name);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    if (fs.existsSync(file)) fs.renameSync(file, file + '.bak'); // 损坏则备份
    return null;
  }
}

function writeJson(dir, name, data) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file); // 原子写，防半截文件
}

function loadSettings(dir) {
  const raw = readJson(dir, 'settings.json');
  const d = defaultSettings();
  if (!raw) return d;
  return {
    ...d,
    ...raw,
    hotkeys: { ...d.hotkeys, ...(raw.hotkeys || {}) },
    reader: { ...d.reader, ...(raw.reader || {}) },
    lastTabs: Array.isArray(raw.lastTabs) ? raw.lastTabs : [],
    lastNovels: raw.lastNovels && typeof raw.lastNovels === 'object' && !Array.isArray(raw.lastNovels) ? raw.lastNovels : {},
  };
}

function saveSettings(settings, dir) { writeJson(dir, 'settings.json', settings); }
function loadProgress(dir) { return readJson(dir, 'progress.json') || {}; }
function saveProgress(map, dir) { writeJson(dir, 'progress.json', map); }

module.exports = { defaultSettings, loadSettings, saveSettings, loadProgress, saveProgress };
