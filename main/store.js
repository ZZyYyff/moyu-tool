// main/store.js
const fs = require('fs');
const path = require('path');

function defaultSettings() {
  return {
    adBounds: null, // Ruling Z：伪装模式窗口尺寸记忆（默认 340×280）
    contentBounds: null, // Ruling Z：内容模式窗口尺寸记忆（默认 1150×750）
    adStyle: 'news',
    hotkeys: { toggleWindow: 'Ctrl+Shift+Z', toggleMode: 'Ctrl+Shift+X' },
    reader: { fontSize: 16, fontFamily: 'yahei', dark: false },
    lastTabs: [],
    lastNovels: {}, // Task 12：novelId → Novel 元数据（会话恢复时重建 novelsMeta）
    hoverReveal: true, // 悬停揭示（brainstorming 2026-08-21）：鼠标悬停显示内容、移开立即伪装
  };
}

// dir 参数便于测试注入；运行时由 ipc.js 传 app.getPath('userData')
function readJson(dir, name) {
  const file = path.join(dir, name);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // 终审修复：备份 rename 独立 try/catch —— renameSync 失败（.bak 为目录/权限/AV 锁）
    // 不得从 catch 块逃逸（否则 loadSettings 在启动路径抛异常 → 启动崩溃，
    // 违反"损坏→默认"契约，spec §9）。失败则放弃备份，继续返回 null。
    try {
      if (fs.existsSync(file)) fs.renameSync(file, file + '.bak'); // 损坏则备份
    } catch { /* 备份失败：放弃备份，仍返回默认值 */ }
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
  const s = {
    ...d,
    ...raw,
    hotkeys: { ...d.hotkeys, ...(raw.hotkeys || {}) },
    reader: { ...d.reader, ...(raw.reader || {}) },
    lastTabs: Array.isArray(raw.lastTabs) ? raw.lastTabs : [],
    lastNovels: raw.lastNovels && typeof raw.lastNovels === 'object' && !Array.isArray(raw.lastNovels) ? raw.lastNovels : {},
  };
  // Ruling Z 迁移：旧版单一 windowBounds → 伪装模式 adBounds。
  // 仅当旧字段存在且新槽位空缺时迁移（undefined 显式写入时 !s.adBounds 同样兜住），
  // 不覆盖已有 adBounds。
  if (raw.windowBounds && !s.adBounds) s.adBounds = raw.windowBounds;
  return s;
}

function saveSettings(settings, dir) { writeJson(dir, 'settings.json', settings); }
function loadProgress(dir) { return readJson(dir, 'progress.json') || {}; }
function saveProgress(map, dir) { writeJson(dir, 'progress.json', map); }

module.exports = { defaultSettings, loadSettings, saveSettings, loadProgress, saveProgress };
