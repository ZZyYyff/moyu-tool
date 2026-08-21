const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const iconv = require('iconv-lite');
const novels = require('../main/novels');

const SAMPLE = `第一章 风起
天元大陆，风雪漫天。
第二章 试炼
少年握紧剑柄。
第三章 决战
一剑光寒十九洲。
风停，雪止。
天地复归寂静。`;

test('detectEncoding: UTF-8 与 GBK 区分', () => {
  assert.equal(novels.detectEncoding(Buffer.from(SAMPLE, 'utf8')), 'utf8');
  const gbk = iconv.encode(SAMPLE, 'gbk');
  assert.equal(novels.detectEncoding(gbk), 'gbk');
});

test('parseChapters 识别章、回、节、卷、部、篇', () => {
  const text = '第1章 一\n正文\n第二回 二\n正文\n第3节 三\n正文\n第百卷 四\n正文\n';
  const ch = novels.parseChapters(text);
  assert.deepEqual(ch.map(c => c.title), ['第1章 一', '第二回 二', '第3节 三', '第百卷 四']);
  assert.equal(ch[0].startLine, 0);
  assert.equal(ch[1].startLine, 2);
});

test('parseChapters 无章节标题返回空数组', () => {
  assert.deepEqual(novels.parseChapters('一段普通文字\n没有章节'), []);
});

test('importNovel: GBK 文件导入为 UTF-8 副本并解析章节', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-novel-'));
  try {
    const src = path.join(dir, 'book.txt');
    fs.writeFileSync(src, iconv.encode(SAMPLE, 'gbk'));
    const novel = await novels.importNovel(src, dir);
    assert.equal(novel.encoding, 'gbk');
    assert.equal(novel.chapterCount, 3);
    assert.equal(novel.totalLines, 8);
    assert.equal(novel.title, 'book');
    assert.ok(fs.existsSync(path.join(dir, novel.novelId + '.txt')));
    // 副本应为 UTF-8
    const stored = fs.readFileSync(path.join(dir, novel.novelId + '.txt'), 'utf8');
    assert.ok(stored.includes('天元大陆'));
    const text = novels.getChapterText(path.join(dir, novel.novelId + '.txt'), novel.totalLines, novel.chapters[1], novel.chapters[2].startLine);
    assert.ok(text.includes('少年握紧剑柄'));
    assert.ok(!text.includes('一剑光寒'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readEpub 解析最小 epub（zip 结构）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-epub-'));
  try {
    const JSZip = require('jszip');
    const zip = new JSZip();
    zip.file('META-INF/container.xml', '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file('OEBPS/content.opf', '<?xml version="1.0"?><package><metadata><dc:title>测试书</dc:title></metadata><manifest><item id="c1" href="c1.xhtml"/><item id="c2" href="c2.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
    zip.file('OEBPS/c1.xhtml', '<html><body><h1>第一章</h1><p>这是第一章内容。</p></body></html>');
    zip.file('OEBPS/c2.xhtml', '<html><body><h1>第二章</h1><p>第二章内容。</p></body></html>');
    const epubPath = path.join(dir, 'book.epub');
    fs.writeFileSync(epubPath, await zip.generateAsync({ type: 'nodebuffer' }));
    const book = await novels.readEpub(epubPath);
    assert.equal(book.title, '测试书');
    assert.equal(book.chapters.length, 2);
    assert.ok(book.chapters[0].text.includes('这是第一章内容'));
    assert.ok(!book.chapters[0].text.includes('<p>'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
