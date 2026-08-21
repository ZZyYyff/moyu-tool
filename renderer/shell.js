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
