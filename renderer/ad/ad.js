// renderer/ad/ad.js
const THEMES_URL = 'ad/ad-themes.json';

let themes = {};
let menuOpen = false;

async function initAd() {
  const res = await fetch(THEMES_URL);
  themes = await res.json();
  const settings = await window.api.invoke('settings:get');
  renderAd(settings.adStyle || 'news');
}

function renderAd(style) {
  const view = document.getElementById('ad-view');
  const t = themes[style] || themes.news;
  view.innerHTML = t.html;
  view.className = 'ad ' + style;
  view.dataset.theme = style;
}

// 事件委托：假关闭、隐蔽入口
document.getElementById('ad-view').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'close') window.api.send('window:hide');     // 假关闭 → 托盘
  if (action === 'menu') toggleMenu(btn);
});

// 双击广告 → 内容模式
document.getElementById('ad-view').addEventListener('dblclick', () => {
  setMode('content');
});

function toggleMenu(anchor) {
  const menu = document.getElementById('menu');
  menuOpen = !menuOpen;
  menu.hidden = !menuOpen;
  if (menuOpen) buildMenu(anchor.getBoundingClientRect());
  else menu.innerHTML = '';
}

function buildMenu(rect) {
  const menu = document.getElementById('menu');
  menu.innerHTML = '';
  const items = [
    ['切回内容模式', () => setMode('content')],
    ['输入网址…', () => showAddressBar()],
    ['伪装样式', null, Object.keys(themes).map(k => [themes[k].name, () => setStyle(k)])],
    ['设置', () => openSettings()],
  ];
  items.forEach(([label, fn, sub]) => {
    const el = document.createElement('button');
    el.textContent = label;
    if (sub) { el.onclick = (e) => { e.stopPropagation(); el.replaceChildren(); sub.forEach(([sl, sf]) => { const b = document.createElement('button'); b.textContent = sl; b.onclick = sf; el.appendChild(b); }); }; }
    else el.onclick = fn;
    menu.appendChild(el);
  });
  menu.style.left = Math.max(4, rect.right - menu.offsetWidth) + 'px';
  menu.style.bottom = '36px';
}

async function setStyle(k) {
  const s = await window.api.invoke('settings:get');
  s.adStyle = k;
  await window.api.invoke('settings:save', s);
  renderAd(k);
}

// 点击空白处关菜单
document.addEventListener('click', (e) => {
  if (menuOpen && !e.target.closest('#menu') && !e.target.closest('[data-action=menu]')) {
    menuOpen = false;
    document.getElementById('menu').hidden = true;
  }
});
