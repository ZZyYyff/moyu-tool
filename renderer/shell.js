// renderer/shell.js
const $ = (sel) => document.querySelector(sel);

function setMode(mode) {
  document.body.dataset.mode = mode;
  $('#ad-view').hidden = mode !== 'ad';
  $('#content-view').hidden = mode !== 'content';
  window.api.send('mode:set', mode);
}

// 初始状态：主进程回传 settings + 当前模式
window.api.on('mode:set', (mode) => {
  document.body.dataset.mode = mode;
  $('#ad-view').hidden = mode !== 'ad';
  $('#content-view').hidden = mode !== 'content';
});

window.api.invoke('shell:ready').then(({ settings, mode }) => {
  window.__settings = settings;
  setMode(mode);
  initAd(); // 广告伪装视图渲染（Task 5；shell:ready 后调用保证 settings 可用）
});

// 托盘"伪装样式"切换（Task 6）：settings 已持久化，这里重渲染广告视图
window.api.on('settings:changed', (settings) => {
  window.__settings = settings;
  renderAd(settings.adStyle);
});

// 托盘/广告菜单"设置"入口占位（Task 13 实现真正的设置面板）
window.api.on('open-settings', () => {
  console.log('open-settings: 设置面板待 Task 13 实现');
});
