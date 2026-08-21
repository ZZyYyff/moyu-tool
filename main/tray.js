// main/tray.js
const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');

const STYLES = [
  ['news', '新闻资讯流'],
  ['game', '游戏广告'],
  ['prize', '恭喜中奖'],
  ['sys', '系统通知'],
];

module.exports = function createTray({ getWindow, getMode, setMode, switchStyle, openSettings, getStyle }) {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  const tray = new Tray(icon);
  tray.setToolTip('摸鱼工具');

  const menu = () => Menu.buildFromTemplate([
    { label: '显示窗口', click: () => getWindow().show() },
    { type: 'separator' },
    { label: '切回内容模式', click: () => setMode('content') },
    {
      label: '伪装样式',
      // Task 13（Task 6 deferred minor）：radio 按当前 settings.adStyle 勾选；
      // 菜单每次右键重建，checked 取注入的 getStyle() 最新值（点击切换后重开菜单即刷新）
      submenu: STYLES.map(([key, name]) => ({ label: name, type: 'radio', checked: getStyle ? getStyle() === key : false, click: () => switchStyle(key) })),
    },
    { type: 'separator' },
    { label: '设置', click: () => openSettings() },
    { type: 'separator' },
    { label: '退出', click: () => getWindow().close() },
  ]);

  tray.on('click', () => {
    const win = getWindow();
    if (win.isVisible()) win.hide(); else win.show();
  });
  tray.on('right-click', () => tray.setContextMenu(menu()));
  return tray;
};
