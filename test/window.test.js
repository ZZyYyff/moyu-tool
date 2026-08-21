// test/window.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeDefaultBounds, computeModeBounds } = require('../main/window');

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
