const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const iconv = require('iconv-lite');
const JSZip = require('jszip');

function detectEncoding(buf) {
  // 严格 UTF-8 解码（fatal）——能过就是 utf8
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return 'utf8';
  } catch { return 'gbk'; }
}

// 文本规范化（移植 Reader 的 Book::FormatText）：BOM/CRLF 统一、行尾空白去除、
// 3+ 连续换行压成 1 个空行、去首部空行。导入时先 normalize 再切章，保证 startLine
// 与盘上内容一致。
function normalizeText(text) {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n').map((l) => l.replace(/[ \t\u00a0\u3000]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '');
}

// 章节标题字符合法性表（移植 Reader TextBook 的 m_ValidChapter）：
// "第"与单位字之间只允许数字/中文数字/空白——防止"第一次""第二天"这类行首误判。
const CHAPTER_VALID = new Set(' \t\u00a0\u30000123456789零一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟萬億廿卄卅');
const CHAPTER_UNITS = '章回节卷部篇';
// 无编号特殊章节（Reader 识别 楔子/序章；补充中文网文常见的几个）
const CHAPTER_SPECIALS = ['楔子', '序章', '引子', '前言', '后记', '尾声'];

function isChapterLine(line) {
  const s = line.trim();
  if (!s) return false;
  if (s[0] === '第') {
    let i = 1;
    while (i < s.length && CHAPTER_VALID.has(s[i])) i++;
    // "第"后必须至少一个合法字符，且紧随章位单位（标题有无空格/冒号均可——比
    // Reader 更宽松：网文常见"第12章XXX"无空格形式）
    return i > 1 && i < s.length && CHAPTER_UNITS.includes(s[i]);
  }
  return CHAPTER_SPECIALS.some((w) => s.startsWith(w));
}

// 章节切分 v2：默认 auto = 上面的状态机；rule 可选
// { mode: 'keyword', keyword } 行首关键字 | { mode: 'regex', regex } 自定义正则
// （非法正则回落 auto，调用方 UI 侧负责校验；此处不 throw 保证导入永不失败）
function parseChapters(text, rule) {
  const lines = text.split('\n');
  const chapters = [];
  if (rule && rule.mode === 'keyword' && rule.keyword) {
    lines.forEach((line, i) => {
      if (line.trim().startsWith(rule.keyword)) chapters.push({ title: line.trim().slice(0, 40), startLine: i });
    });
    return chapters;
  }
  let re = null;
  if (rule && rule.mode === 'regex' && rule.regex) {
    try { re = new RegExp(rule.regex); } catch { re = null; }
  }
  if (re) {
    lines.forEach((line, i) => {
      if (re.test(line)) chapters.push({ title: line.trim().slice(0, 40), startLine: i });
    });
    return chapters;
  }
  lines.forEach((line, i) => {
    if (isChapterLine(line)) chapters.push({ title: line.trim().slice(0, 40), startLine: i });
  });
  return chapters;
}

function novelIdFor(srcPath, size) {
  return crypto.createHash('sha1').update(srcPath + ':' + size).digest('hex').slice(0, 16);
}

async function importNovel(srcPath, novelsDir, rule) {
  fs.mkdirSync(novelsDir, { recursive: true });
  const ext = path.extname(srcPath).toLowerCase();
  const novelId = novelIdFor(srcPath, fs.statSync(srcPath).size);
  if (ext === '.epub') {
    // Ruling P：epub 走独立管线（readEpub 解析，见 importEpub）
    return importEpub(srcPath, novelsDir, novelId);
  }
  if (ext === '.mobi') {
    return importMobi(srcPath, novelsDir, novelId);
  }
  const raw = fs.readFileSync(srcPath);
  const encoding = detectEncoding(raw);
  const text = normalizeText(encoding === 'utf8' ? raw.toString('utf8') : iconv.decode(raw, 'gbk'));
  const chapters = parseChapters(text, rule);
  fs.writeFileSync(path.join(novelsDir, novelId + '.txt'), text, 'utf8');
  return {
    novelId,
    title: path.basename(srcPath, path.extname(srcPath)),
    encoding,
    totalLines: text.split('\n').length,
    chapterCount: chapters.length,
    chapters,
  };
}

// Ruling P：epub 导入 —— 章节结构来自 spine 文件本身（每文件一章，h1/h2 标题，
// 缺省"第N章"），不跑 txt 的行首状态机（会丢非"第X章"命名的章节）。
// 逐章先 normalize 再拼接（块间 '\n\n'），startLine 增量推进：第 i 块 = 前序块行数
// 之和 + i（块间 '\n\n' 经 split('\n') 产生 1 个空行）。
async function importEpub(srcPath, novelsDir, novelId) {
  const book = await readEpub(srcPath);
  const storedPath = path.join(novelsDir, novelId + '.txt');
  const normed = book.chapters.map((c) => ({ title: c.title, text: normalizeText(c.text) }));
  const text = normed.map(c => c.text).join('\n\n');
  fs.writeFileSync(storedPath, text, 'utf8');
  const chapters = [];
  let startLine = 0;
  for (const c of normed) {
    chapters.push({ title: c.title, startLine });
    startLine += c.text.split('\n').length + 1;
  }
  return {
    novelId,
    title: book.title,
    encoding: 'utf8',
    totalLines: text.split('\n').length,
    chapterCount: chapters.length,
    chapters,
  };
}

// HTML → 纯文本（epub 与 mobi 共用）：剥 script/style/标签、反解常见实体、压空行
function htmlToText(raw) {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readEpub(srcPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(srcPath));
  const container = await zip.file('META-INF/container.xml').async('string');
  const opfPath = container.match(/full-path="([^"]+)"/)[1];
  const opf = await zip.file(opfPath).async('string');
  const title = (opf.match(/<dc:title>([^<]+)<\/dc:title>/) || [])[1] || path.basename(srcPath, '.epub');
  const spineRefs = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map(m => m[1]);
  const items = [...opf.matchAll(/<item[^>]+id="([^"]+)"[^>]+href="([^"]+)"/g)];
  const byId = new Map(items.map(([_, id, href]) => [id, href]));
  const base = path.posix.dirname(opfPath);
  const chapters = [];
  for (const ref of spineRefs) {
    const href = byId.get(ref);
    if (!href || !/\.(x?html|htm|txt)$/i.test(href)) continue;
    const raw = await zip.file(path.posix.join(base, href)).async('string');
    const h1 = (raw.match(/<h[12][^>]*>([^<]+)<\/h[12]>/) || [])[1] || `第${chapters.length + 1}章`;
    chapters.push({ title: h1.trim(), text: htmlToText(raw) });
  }
  return { title, chapters };
}

function getChapterText(storedPath, totalLines, chapter, nextStart) {
  const end = nextStart !== undefined ? nextStart : totalLines;
  const lines = fs.readFileSync(storedPath, 'utf8').split('\n').slice(chapter.startLine, end);
  // 去掉章尾分隔空行（在线书缓存追加后 nextStart 切片会带上下章前的空行；
  // epub 增量行号同理）。章内空行不受影响，段落坐标系与搜索偏移一致。
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

// MOBI 导入：mobi.js 负责字节级解析（PalmDoc 解压等），这里落成与 epub 同构的
// 单 txt + 章节目录。htmlToText 从 novels 传入，避免模块循环依赖。
async function importMobi(srcPath, novelsDir, novelId) {
  const mobi = require('./mobi');
  const book = await mobi.readMobi(srcPath, htmlToText);
  const storedPath = path.join(novelsDir, novelId + '.txt');
  const normed = book.chapters.map((c) => ({ title: c.title, text: normalizeText(c.text) }));
  const text = normed.map(c => c.text).join('\n\n');
  fs.writeFileSync(storedPath, text, 'utf8');
  const chapters = [];
  let startLine = 0;
  for (const c of normed) {
    chapters.push({ title: c.title, startLine });
    startLine += c.text.split('\n').length + 1;
  }
  return {
    novelId,
    title: book.title,
    encoding: 'utf8',
    totalLines: text.split('\n').length,
    chapterCount: chapters.length,
    chapters,
  };
}

// 全文搜索（主进程一次读盘）：返回命中 [{chapterIndex, title, excerpt, charOffset}]，
// charOffset = 命中行首在该章文本中的字符偏移（渲染层据此跳转到包含该偏移的段落）。
// limit 防止全书高频词结果爆面板。
function searchText(storedPath, novel, query, limit = 200) {
  const q = String(query).toLowerCase();
  if (!q) return [];
  const lines = fs.readFileSync(storedPath, 'utf8').split('\n');
  const results = [];
  for (let ci = 0; ci < novel.chapters.length && results.length < limit; ci++) {
    const start = novel.chapters[ci].startLine;
    const end = ci + 1 < novel.chapters.length ? novel.chapters[ci + 1].startLine : Math.min(novel.totalLines, lines.length);
    let off = 0;
    for (let li = start; li < end; li++) {
      const line = li < lines.length ? lines[li] : '';
      const at = line.toLowerCase().indexOf(q);
      if (at !== -1) {
        results.push({
          chapterIndex: ci,
          title: novel.chapters[ci].title,
          excerpt: line.trim().slice(0, 60),
          charOffset: off + at,
        });
        if (results.length >= limit) break;
      }
      off += line.length + 1; // +1 = join('\n') 的换行
    }
  }
  return results;
}

// 章节字符长度表（惰性计算，percentTarget 用）：chapterChars[i] = 第 i 章文本字符数
function chapterCharCounts(storedPath, novel) {
  const lines = fs.readFileSync(storedPath, 'utf8').split('\n');
  return novel.chapters.map((c, ci) => {
    const start = c.startLine;
    const end = ci + 1 < novel.chapters.length ? novel.chapters[ci + 1].startLine : Math.min(novel.totalLines, lines.length);
    let n = 0;
    for (let li = start; li < end; li++) n += (li < lines.length ? lines[li].length : 0) + 1;
    return Math.max(0, n - 1); // 去掉末尾 join 的换行
  });
}

// 百分比跳转（Reader Ctrl+G）：按全书实际字符量精确定位到 {chapterIndex, charOffset}
function percentTarget(storedPath, novel, pct) {
  const chars = chapterCharCounts(storedPath, novel);
  const total = chars.reduce((a, b) => a + b, 0);
  if (total <= 0) return { chapterIndex: 0, charOffset: 0 };
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  let target = Math.round((total * p) / 100);
  for (let ci = 0; ci < chars.length; ci++) {
    if (target <= chars[ci] || ci === chars.length - 1) return { chapterIndex: ci, charOffset: Math.max(0, target) };
    target -= chars[ci];
  }
  return { chapterIndex: 0, charOffset: 0 };
}

// 在线书章节追加：把抓到的正文写进存储 txt 尾部并返回 startLine。
// 约定章节间分隔 '\n\n'、正文不含标题行（与 importEpub/importMobi 一致，标题在
// meta 里、渲染层自绘 h2）；调用方随后更新 meta 的 totalLines/chapters 并持久化。
function appendChapter(storedPath, text) {
  const normed = normalizeText(text);
  const existing = fs.existsSync(storedPath) ? fs.readFileSync(storedPath, 'utf8') : '';
  const sep = existing ? '\n\n' : '';
  const startLine = existing ? existing.split('\n').length + 1 : 0;
  fs.appendFileSync(storedPath, sep + normed, 'utf8');
  return { startLine, addedLines: normed.split('\n').length + 1 }; // +1 = 块间分隔空行
}

module.exports = {
  detectEncoding, normalizeText, parseChapters, isChapterLine, novelIdFor, htmlToText,
  importNovel, readEpub, getChapterText, searchText, chapterCharCounts, percentTarget, appendChapter,
};
