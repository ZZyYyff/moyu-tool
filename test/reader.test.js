// test/reader.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeProgress, restoreScroll } = require('../renderer/reader/reader');

test('computeProgress 常规滚动比例', () => {
  const p = computeProgress(2, 300, 600, 1500);
  assert.equal(p.chapterIndex, 2);
  assert.ok(Math.abs(p.scrollRatio - 300 / 900) < 1e-9);
});

test('computeProgress 内容不足一屏时比例为 0', () => {
  const p = computeProgress(0, 50, 600, 400);
  assert.equal(p.scrollRatio, 0);
});

test('restoreScroll 返回章节与 0.35 定位比例', () => {
  const r = restoreScroll({ chapterIndex: 5, scrollRatio: 0.8 });
  assert.equal(r.chapterIndex, 5);
  assert.equal(r.ratio, 0.35);
});
