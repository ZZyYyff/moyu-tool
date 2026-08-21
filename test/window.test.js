// test/window.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeDefaultBounds } = require('../main/window');

test('默认定位：右下角，16px 偏移', () => {
  const b = computeDefaultBounds({ width: 1920, height: 1080 }, 340, 280);
  assert.deepEqual(b, { x: 1920 - 340 - 16, y: 1080 - 280 - 16, width: 340, height: 280 });
});

test('工作区小于窗口时按 0,0 兜底', () => {
  const b = computeDefaultBounds({ width: 200, height: 200 }, 340, 280);
  assert.deepEqual(b, { x: 0, y: 0, width: 340, height: 280 });
});
