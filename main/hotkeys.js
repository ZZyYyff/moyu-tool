// main/hotkeys.js
const { globalShortcut } = require('electron');
const store = require('./store');

const VALID_KEYS = new Set([
  '0','1','2','3','4','5','6','7','8','9',
  'A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
  'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
  'Space','Tab','Escape','Enter','Backspace','Delete','Insert',
  'Up','Down','Left','Right','Home','End','PageUp','PageDown',
]);
const MODIFIERS = ['Ctrl', 'Shift', 'Alt', 'Super'];

function normalizeAccelerator(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().split('+').map(p => p.trim()).filter(Boolean);
  if (parts.length < 1) return null;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const normMods = mods.map(m => MODIFIERS.find(x => x.toLowerCase() === m.toLowerCase()));
  if (normMods.includes(undefined)) return null;
  const normKey = VALID_KEYS.has(key) ? key : (VALID_KEYS.has(key.toUpperCase()) ? key.toUpperCase() : null);
  if (!normKey) return null;
  const out = [...normMods, normKey];
  return out.join('+');
}

let registered = {};

// 全部可配置热键槽（裁定 AB 扩展：透明模式切换 + 阅读翻页）
const HOTKEY_KINDS = ['toggleWindow', 'toggleMode', 'toggleTransparent', 'pageUp', 'pageDown'];

// 回调表（Ruling B）：setCallbacks 注入一次，registerHotkeys / applyHotkeyChange
// 均从表中取回调，保证改键后重新注册的热键仍有动作。
let callbacks = {};

function setCallbacks(cbs = {}) {
  for (const k of HOTKEY_KINDS) if (typeof cbs[k] === 'function') callbacks[k] = cbs[k];
}

function registerHotkeys({ getWindow, toggleMode, notifyConflict, userDataDir }) {
  // 兜底：未调 setCallbacks 时用传参补齐核心回调（正常装配路径走 setCallbacks）
  if (!callbacks.toggleWindow && typeof getWindow === 'function') {
    callbacks.toggleWindow = () => {
      const w = getWindow();
      if (w.isVisible()) w.hide(); else w.show();
    };
  }
  if (!callbacks.toggleMode && typeof toggleMode === 'function') {
    callbacks.toggleMode = toggleMode;
  }

  const settings = store.loadSettings(userDataDir);
  const failed = [];
  for (const kind of HOTKEY_KINDS) {
    const acc = normalizeAccelerator(settings.hotkeys[kind]);
    if (!acc) continue; // 未配置（null/空）→ 跳过
    const handler = () => { const cb = callbacks[kind]; if (cb) cb(); };
    if (globalShortcut.register(acc, handler)) {
      registered[kind] = acc;
    } else {
      failed.push(acc);
    }
  }

  failed.forEach(f => notifyConflict && notifyConflict(f));
  return { ok: failed.length === 0, failed };
}

function unregisterHotkeys() {
  Object.values(registered).forEach(a => globalShortcut.unregister(a));
  registered = {};
}

function applyHotkeyChange(kind, rawAcc, userDataDir) {
  const acc = normalizeAccelerator(rawAcc);
  if (!acc) return { ok: false, reason: '无效的快捷键' };
  if (!HOTKEY_KINDS.includes(kind)) {
    return { ok: false, reason: '无效的快捷键类型' };
  }
  const s = store.loadSettings(userDataDir);
  const oldAcc = normalizeAccelerator(s.hotkeys[kind]);
  if (oldAcc === acc) return { ok: true }; // 值未变，无需重注册

  const handler = () => { const cb = callbacks[kind]; if (cb) cb(); };
  if (!globalShortcut.register(acc, handler)) {
    return { ok: false, reason: '快捷键被其他程序占用' };
  }
  // 新键注册成功后再注销旧键；unregister 失败不阻塞，继续写回（保险起见）
  if (oldAcc) globalShortcut.unregister(oldAcc);
  s.hotkeys[kind] = acc;
  store.saveSettings(s, userDataDir);
  registered[kind] = acc;
  return { ok: true };
}

module.exports = { normalizeAccelerator, registerHotkeys, unregisterHotkeys, applyHotkeyChange, setCallbacks };
