// test/window.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeDefaultBounds,
  computeModeBounds,
  anchorBottomRight,
  clampToWorkArea,
} = require('../main/window');

test('默认定位：右下角，16px 偏移', () => {
  const b = computeDefaultBounds({ width: 1920, height: 1080 }, 340, 280);
  assert.deepEqual(b, { x: 1920 - 340 - 16, y: 1080 - 280 - 16, width: 340, height: 280 });
});

test('工作区小于窗口时按 0,0 兜底', () => {
  const b = computeDefaultBounds({ width: 200, height: 200 }, 340, 280);
  assert.deepEqual(b, { x: 0, y: 0, width: 340, height: 280 });
});

// Ruling Z：按模式双尺寸记忆
test('computeModeBounds ad：有记忆时原样返回', () => {
  const adBounds = { x: 1, y: 2, width: 300, height: 250 };
  assert.deepEqual(
    computeModeBounds('ad', { width: 1920, height: 1080 }, { adBounds, contentBounds: null }),
    adBounds
  );
});

test('computeModeBounds content：无记忆时右下角默认 1150×750', () => {
  const workArea = { width: 1920, height: 1080 };
  assert.deepEqual(
    computeModeBounds('content', workArea, { adBounds: null, contentBounds: null }),
    { x: workArea.width - 1150 - 16, y: workArea.height - 750 - 16, width: 1150, height: 750 }
  );
});

test('computeModeBounds content：有记忆时原样返回', () => {
  const contentBounds = { x: 5, y: 6, width: 900, height: 600 };
  assert.deepEqual(
    computeModeBounds('content', { width: 1920, height: 1080 }, { contentBounds }),
    contentBounds
  );
});

test('computeModeBounds 未知模式回落 ad 逻辑', () => {
  const adBounds = { x: 7, y: 8, width: 320, height: 260 };
  assert.deepEqual(
    computeModeBounds('bogus', { width: 1920, height: 1080 }, { adBounds, contentBounds: null }),
    adBounds
  );
});

// 模式切换位置连续性（修复悬停揭示在双槽位置分叉时的振荡）
test('anchorBottomRight：目标右下角对齐当前窗口（槽位里的旧位置被忽略）', () => {
  const current = { x: 100, y: 100, width: 1150, height: 750 }; // 用户拖动后的内容窗
  const slotTarget = { x: 1564, y: 744, width: 340, height: 280 }; // 伪装槽默认位置，应被锚点覆盖
  assert.deepEqual(anchorBottomRight(current, slotTarget), {
    x: 100 + 1150 - 340,
    y: 100 + 750 - 280,
    width: 340,
    height: 280,
  });
});

test('anchorBottomRight：默认双尺寸切换右下角重合（与旧行为一致）', () => {
  const ad = { x: 1920 - 340 - 16, y: 1040 - 280 - 16, width: 340, height: 280 };
  const contentSize = { x: 0, y: 0, width: 1150, height: 750 };
  const anchored = anchorBottomRight(ad, contentSize);
  assert.equal(anchored.x + anchored.width, ad.x + ad.width);
  assert.equal(anchored.y + anchored.height, ad.y + ad.height);
});

test('clampToWorkArea：工作区内不动', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const b = { x: 100, y: 100, width: 340, height: 280 };
  assert.deepEqual(clampToWorkArea(b, wa), b);
});

test('clampToWorkArea：右下越界收进工作区（悬停放大后光标仍在窗口内）', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const b = clampToWorkArea({ x: 1700, y: 900, width: 1150, height: 750 }, wa);
  assert.equal(b.x, 1920 - 1150);
  assert.equal(b.y, 1040 - 750);
});

test('clampToWorkArea：负坐标/副屏工作区偏移按 workArea 原点收敛', () => {
  const wa = { x: 1920, y: 0, width: 1920, height: 1040 }; // 副屏
  const b = clampToWorkArea({ x: 1000, y: 500, width: 340, height: 280 }, wa);
  assert.equal(b.x, 1920); // 越左界 → 拉回副屏左缘
  assert.equal(b.y, 500); // y 在界内不动
});

test('clampToWorkArea：窗口大于工作区时该维对齐工作区原点', () => {
  const wa = { x: 0, y: 0, width: 1024, height: 768 };
  const b = clampToWorkArea({ x: 500, y: 500, width: 1150, height: 750 }, wa);
  assert.equal(b.x, 0); // 宽超出 → 左对齐
  assert.equal(b.y, 768 - 750); // 高未超出 → 正常收敛
});
