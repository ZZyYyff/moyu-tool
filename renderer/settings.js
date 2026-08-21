// renderer/settings.js — 设置面板（Task 13）：热键改键 / 伪装默认样式
// 复用 shell.js 顶层的 $（本文件不重复声明 const $，避免 SyntaxError）；
// 依赖 ad.js 的 renderAd（运行时调用，脚本已全部加载）。
// brainstroming 改版（2026-08-21）：阅读偏好（字号/字体/暗色）移出主面板，
// 唯一入口为阅读器工具栏"设置"小面板（reader.js 的 #reader-settings）。
function openSettings() {
  const modal = $('#settings-modal');
  modal.hidden = false;
  buildSettingsForm();
}

async function buildSettingsForm() {
  const s = await window.api.invoke('settings:get');
  const modal = $('#settings-modal');
  modal.innerHTML = `
    <h3>设置</h3>
    <div class="row"><label>隐藏/恢复热键</label><input id="hk-window" value="${s.hotkeys.toggleWindow}"></div>
    <div class="row"><label>切换模式热键</label><input id="hk-mode" value="${s.hotkeys.toggleMode}"></div>
    <div class="row"><label>默认伪装样式</label><select id="ad-style">
      ${['news','game','prize','sys'].map(k => `<option value="${k}" ${s.adStyle === k ? 'selected' : ''}>${k}</option>`).join('')}
    </select></div>
    <p id="hk-msg" style="color:#c00"></p>
    <div class="row"><button id="set-save">保存</button><button id="set-close">关闭</button></div>`;
  // 热键捕获：点击输入框后按键组合写入
  const capture = (inputId, kind) => {
    const input = document.getElementById(inputId);
    input.addEventListener('keydown', async (e) => {
      e.preventDefault();
      const mods = [];
      if (e.ctrlKey) mods.push('Ctrl');
      if (e.shiftKey) mods.push('Shift');
      if (e.altKey) mods.push('Alt');
      const keyMap = { ' ': 'Space', 'Escape': 'Esc' };
      const key = keyMap[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
      input.value = [...mods, key].join('+');
      const r = await window.api.invoke('settings:apply-hotkey', kind, input.value);
      if (!r.ok) { input.value = r.oldValue; document.getElementById('hk-msg').textContent = r.reason; }
    });
  };
  capture('hk-window', 'toggleWindow');
  capture('hk-mode', 'toggleMode');

  document.getElementById('set-save').onclick = async () => {
    const s2 = await window.api.invoke('settings:get');
    s2.adStyle = document.getElementById('ad-style').value;
    await window.api.invoke('settings:save', s2);
    renderAd(s2.adStyle);
    modal.hidden = true;
  };
  document.getElementById('set-close').onclick = () => { modal.hidden = true; };
}
