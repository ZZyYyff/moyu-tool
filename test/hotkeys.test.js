// test/hotkeys.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAccelerator } = require('../main/hotkeys');

test('normalizeAccelerator 规范化大小写与顺序', () => {
  assert.equal(normalizeAccelerator('ctrl+shift+z'), 'Ctrl+Shift+Z');
  assert.equal(normalizeAccelerator(' Alt + Q '), 'Alt+Q');
  assert.equal(normalizeAccelerator('f12'), 'F12');
});

test('非法输入返回 null', () => {
  assert.equal(normalizeAccelerator(''), null);
  assert.equal(normalizeAccelerator('   '), null);
  assert.equal(normalizeAccelerator('ctrl+'), null);
});
