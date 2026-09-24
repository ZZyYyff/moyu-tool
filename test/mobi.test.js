const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readMobi, palmdocDecompress } = require('../main/mobi');
const { htmlToText } = require('../main/novels');

function be16buf(n) { return Buffer.from([(n >> 8) & 0xff, n & 0xff]); }
function be32buf(n) { return Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]); }

// 测试用最小 PalmDoc 压缩器：特殊字节（0x00-0x08、≥0x80）打包成"数量+字面量"run，
// 其余字节直发——与解压器的四种 token 一一对应
function pdCompress(bytes) {
  const out = [];
  let run = [];
  const flush = () => {
    while (run.length) {
      const n = Math.min(8, run.length);
      out.push(n, ...run.splice(0, n));
    }
  };
  for (const b of bytes) {
    if (b === 0 || b < 9 || b >= 0x80) {
      run.push(b);
      if (run.length === 8) flush();
    } else out.push(b);
  }
  flush();
  return Buffer.from(out);
}

// 合成最小合法 MOBI：PalmDB 头 + 记录表 + record0(PalmDOC+MOBI头+书名) + 文本记录
function buildMobi({ title = '测试书', encoding = 65001, compression = 17480, encryption = 0, extraFlags = 0, records }) {
  const fullName = Buffer.from(title, 'utf8');
  const mobiLen = 232;
  const nameOff = 16 + mobiLen;
  const rawTotal = records.reduce((a, r) => a + r.length, 0);
  const mobi = Buffer.alloc(mobiLen);
  mobi.write('MOBI', 0, 'latin1');
  be32buf(mobiLen).copy(mobi, 4);        // 头长（≥0xE4 才有 extraFlags @0xF1）
  be32buf(2).copy(mobi, 8);              // mobi type = BOOK
  be32buf(encoding).copy(mobi, 12);      // textEncoding @28
  be32buf(nameOff).copy(mobi, 68);       // fullName offset @84（相对记录 0）
  be32buf(fullName.length).copy(mobi, 72); // fullName length @88
  if (extraFlags) be16buf(extraFlags).copy(mobi, 225); // 0xF1-16 = 225
  const rec0 = Buffer.concat([
    be16buf(compression), be16buf(0), be32buf(rawTotal), be16buf(records.length), be16buf(4096), be16buf(encryption), be16buf(0),
    mobi, fullName,
  ]);
  const all = [rec0, ...records];
  let off = 78 + all.length * 8 + 2;
  const list = all.map((r) => {
    const e = Buffer.concat([be32buf(off), Buffer.from([0, 0, 0, 0])]);
    off += r.length;
    return e;
  });
  const palmdb = Buffer.concat([
    Buffer.alloc(32), be16buf(0), be16buf(0),
    be32buf(0), be32buf(0), be32buf(0), be32buf(0), be32buf(0), be32buf(0),
    Buffer.from('BOOK', 'latin1'), Buffer.from('MOBI', 'latin1'),
    be32buf(0), be32buf(0), be16buf(all.length),
  ]);
  return Buffer.concat([palmdb, ...list, Buffer.alloc(2), ...all]);
}

const strip = (h) => htmlToText(h); // 与生产一致：mobi 解析后的 HTML 剥壳

test('palmdocDecompress：字面量与距离/长度回引', () => {
  assert.equal(palmdocDecompress(Buffer.from([0x61, 0x62, 0x63, 0x80, 0x1b])).toString('latin1'), 'abcabcabc');
  assert.equal(palmdocDecompress(Buffer.from([0x05, 0x41, 0x42, 0x43, 0x44, 0x45])).toString('latin1'), 'ABCDE');
  assert.equal(palmdocDecompress(Buffer.from([0xe1])).toString('latin1'), ' a'); // 空格 + 大写化
  assert.equal(palmdocDecompress(Buffer.from([0x00])).toString('latin1'), '\x00');
});

test('readMobi：无压缩 UTF-8，pagebreak 切章 + h1/h2 标题', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-mobi-'));
  try {
    const p = path.join(dir, 'book.mobi');
    fs.writeFileSync(p, buildMobi({
      records: [Buffer.from('<html><body><h1>第一章 起点</h1><p>内容甲</p><mbp:pagebreak/><h2>第二章 转折</h2><p>内容乙</p></body></html>', 'utf8')],
    }));
    const book = await readMobi(p, strip);
    assert.equal(book.title, '测试书');
    assert.deepEqual(book.chapters.map(c => c.title), ['第一章 起点', '第二章 转折']);
    assert.equal(book.chapters[0].text, '内容甲');
    assert.equal(book.chapters[1].text, '内容乙');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readMobi：PalmDoc 压缩 + 中文多字节横跨记录边界', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-mobi-pd-'));
  try {
    // 记录边界切在"中"字（E4 B8 AD）第一个字节后：E4 低 2 位为 0 → 重叠 1 字节。
    // 末尾 0x00 = 重叠标记字节（低 2 位 = 重叠数-1），属于解压后文本流的一部分
    const head = Buffer.from('<p>', 'utf8');
    const zhong = Buffer.from('中', 'utf8'); // E4 B8 AD
    const rest = Buffer.from('文测试</p>', 'utf8');
    const r1 = pdCompress(Buffer.concat([head, zhong.slice(0, 1), Buffer.from([0x00])]));
    const r2 = pdCompress(Buffer.concat([zhong.slice(1), rest, Buffer.from([0x00])]));
    const p = path.join(dir, 'book.mobi');
    fs.writeFileSync(p, buildMobi({ compression: 1, extraFlags: 1, records: [r1, r2] }));
    const book = await readMobi(p, strip);
    assert.deepEqual(book.chapters.map(c => c.title), ['第1章']); // 无 h 标题 → 缺省
    assert.equal(book.chapters[0].text, '中文测试');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readMobi：extraFlags 尾部条目剥离', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-mobi-trail-'));
  try {
    const content = Buffer.from('<p>正文完好</p>', 'utf8');
    const p = path.join(dir, 'book.mobi');
    // extraFlags=2（位 1）：每记录尾 1 个变长条目；0x81 反向变长编码 = 长度 1 的噪声
    fs.writeFileSync(p, buildMobi({ extraFlags: 2, records: [Buffer.concat([content, Buffer.from([0x81])])] }));
    const book = await readMobi(p, strip);
    assert.equal(book.chapters[0].text, '正文完好');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readMobi：DRM 加密与 HUFF/CDIC 压缩明确报错', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-mobi-err-'));
  try {
    const drm = path.join(dir, 'drm.mobi');
    fs.writeFileSync(drm, buildMobi({ encryption: 1, records: [Buffer.from('x')] }));
    await assert.rejects(() => readMobi(drm, strip), /DRM/);
    const huff = path.join(dir, 'huff.mobi');
    fs.writeFileSync(huff, buildMobi({ compression: 2, records: [Buffer.from('x')] }));
    await assert.rejects(() => readMobi(huff, strip), /HUFF/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
