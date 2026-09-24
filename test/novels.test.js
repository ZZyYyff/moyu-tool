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

test('importNovel: epub 导入为 UTF-8 存储 + 增量行号章节（Ruling P）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-epub-imp-'));
  try {
    const JSZip = require('jszip');
    const zip = new JSZip();
    zip.file('META-INF/container.xml', '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file('OEBPS/content.opf', '<?xml version="1.0"?><package><metadata><dc:title>测试书</dc:title></metadata><manifest><item id="c1" href="c1.xhtml"/><item id="c2" href="c2.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
    zip.file('OEBPS/c1.xhtml', '<html><body><h1>第一章</h1><p>这是第一章内容。</p></body></html>');
    zip.file('OEBPS/c2.xhtml', '<html><body><h1>第二章</h1><p>第二章内容。</p></body></html>');
    const epubPath = path.join(dir, 'book.epub');
    fs.writeFileSync(epubPath, await zip.generateAsync({ type: 'nodebuffer' }));
    const novel = await novels.importNovel(epubPath, dir);
    assert.equal(novel.title, '测试书');
    assert.equal(novel.encoding, 'utf8');
    assert.equal(novel.chapterCount, 2);
    assert.equal(novel.totalLines, 3); // "A\n\nB" → ['A','','B']：块间 '\n\n' 产生 1 个空行
    assert.equal(novel.chapters[0].startLine, 0);
    assert.equal(novel.chapters[1].startLine, 2); // 前序块行数 1 + 分隔 1 行
    const stored = path.join(dir, novel.novelId + '.txt');
    assert.ok(fs.existsSync(stored));
    // 存储副本为 UTF-8
    assert.ok(fs.readFileSync(stored, 'utf8').includes('这是第一章内容'));
    // [startLine, nextStart) 切片：第一章文本含自身、不含第二章
    const ch0 = novels.getChapterText(stored, novel.totalLines, novel.chapters[0], novel.chapters[1].startLine);
    assert.ok(ch0.includes('这是第一章内容'));
    assert.ok(!ch0.includes('第二章内容'));
    // 末章（nextStart 缺省 → 切到 totalLines）
    const ch1 = novels.getChapterText(stored, novel.totalLines, novel.chapters[1]);
    assert.ok(ch1.includes('第二章内容'));
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

// —— 解析核心 v2（参照 Reader 的状态机与文本规范化）——

test('parseChapters v2：中文数字变体与无空格标题', () => {
  const text = '第卅章 三十\n正文\n第百廿三回 古典\n正文\n第12章网文风格\n正文\n第2,000章 逗号也算正文词？\n';
  const ch = novels.parseChapters(text);
  assert.deepEqual(ch.map(c => c.title), ['第卅章 三十', '第百廿三回 古典', '第12章网文风格']);
});

test('parseChapters v2：楔子/序章/引子等特殊章', () => {
  const ch = novels.parseChapters('楔子\n正文\n序章：风起\n正文\n引子\n正文\n第一章 正式\n');
  assert.equal(ch.length, 4);
  assert.equal(ch[0].title, '楔子');
});

test('parseChapters v2：行首"第"但非章节号不误判', () => {
  const ch = novels.parseChapters('第二天，他没来。\n第一次见到她。\n他说第一章很好看。\n');
  assert.deepEqual(ch, []);
});

test('parseChapters v2：keyword 规则与 regex 规则', () => {
  const text = '卷一 开篇\n正文\n卷二 转折\n正文\n';
  const kw = novels.parseChapters(text, { mode: 'keyword', keyword: '卷' });
  assert.deepEqual(kw.map(c => c.title), ['卷一 开篇', '卷二 转折']);
  const re = novels.parseChapters(text, { mode: 'regex', regex: '^卷[一二三]' });
  assert.equal(re.length, 2);
  // 非法正则回落 auto（不 throw）
  const bad = novels.parseChapters('第一章 一\n', { mode: 'regex', regex: '[' });
  assert.equal(bad.length, 1);
});

test('normalizeText：BOM/CRLF/行尾空白/空行压缩/首部空行', () => {
  const raw = '\uFEFF\r\n\r\n第一章  开始  \r\n\r\n\r\n\r\n正文一行\r\n\r\n\r\n尾章\r\n';
  const out = novels.normalizeText(raw);
  assert.ok(!out.startsWith('\uFEFF'));
  assert.ok(!out.includes('\r'));
  assert.ok(!out.startsWith('\n'));
  // 行尾空格去除、4 连换行压成 1 个空行、首部空行去除
  assert.equal(out, '第一章  开始\n\n正文一行\n\n尾章\n');
});

test('searchText：命中行、章定位与字符偏移', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-search-'));
  try {
    const text = '第一章 风起\n少年握剑。\n剑光一闪。\n\n第二章 试炼\n剑意渐成。\n';
    const stored = path.join(dir, 'a.txt');
    fs.writeFileSync(stored, text, 'utf8');
    const novel = { chapters: [{ title: '第一章 风起', startLine: 0 }, { title: '第二章 试炼', startLine: 4 }], totalLines: 6 };
    const hits = novels.searchText(stored, novel, '剑');
    // 第一章 2 处 + 第二章 1 处；charOffset = 章内文本中"命中位置"（含命中列）
    assert.deepEqual(hits.map(h => h.chapterIndex), [0, 0, 1]);
    assert.equal(hits[0].charOffset, 10); // '第一章 风起\n'(7) + 行内 3（少年握"剑"）
    assert.equal(hits[1].charOffset, 13); // 7 + '少年握剑。\n'(6)
    assert.equal(hits[2].excerpt, '剑意渐成。');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('percentTarget：按全书字符量精确定位', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-pct-'));
  try {
    const c1 = '甲'.repeat(100); // 第一章 100 字
    const c2 = '乙'.repeat(300); // 第二章 300 字
    const stored = path.join(dir, 'a.txt');
    fs.writeFileSync(stored, [c1, c2].join('\n\n'), 'utf8');
    const novel = { chapters: [{ title: '一', startLine: 0 }, { title: '二', startLine: 2 }], totalLines: 3 };
    assert.deepEqual(novels.percentTarget(stored, novel, 0), { chapterIndex: 0, charOffset: 0 });
    // 50% = 200 字 → 第一章 100 字用尽，落在第二章第 100 字
    assert.deepEqual(novels.percentTarget(stored, novel, 50), { chapterIndex: 1, charOffset: 100 });
    assert.deepEqual(novels.percentTarget(stored, novel, 100), { chapterIndex: 1, charOffset: 300 });
    assert.deepEqual(novels.percentTarget(stored, novel, 999), { chapterIndex: 1, charOffset: 300 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('appendChapter：追加到存储尾部并返回正确 startLine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-append-'));
  try {
    const stored = path.join(dir, 'a.txt');
    fs.writeFileSync(stored, '第一章\n正文甲', 'utf8');
    let r = novels.appendChapter(stored, '正文乙');
    assert.equal(r.startLine, 3); // '第一章\n正文甲\n\n正文乙'：2 行 + 1 分隔空行
    assert.equal(r.addedLines, 2); // '正文乙' 1 行 + 分隔空行
    r = novels.appendChapter(stored, '正文丙\n正文丁');
    assert.equal(r.startLine, 5); // 此时盘上 4 行 + 1 分隔空行
    const all = fs.readFileSync(stored, 'utf8');
    assert.ok(all.includes('正文乙'));
    assert.ok(all.includes('正文丙\n正文丁'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
