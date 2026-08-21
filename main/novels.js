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

const CHAPTER_RE = /^\s*(第[0-9零一二三四五六七八九十百千两]+[章回节卷部篇])/;

function parseChapters(text) {
  const lines = text.split('\n');
  const chapters = [];
  lines.forEach((line, i) => {
    const m = line.match(CHAPTER_RE);
    if (m) chapters.push({ title: line.trim().slice(0, 40), startLine: i });
  });
  return chapters;
}

function novelIdFor(srcPath, size) {
  return crypto.createHash('sha1').update(srcPath + ':' + size).digest('hex').slice(0, 16);
}

async function importNovel(srcPath, novelsDir) {
  fs.mkdirSync(novelsDir, { recursive: true });
  if (path.extname(srcPath).toLowerCase() === '.epub') {
    // Ruling P：epub 走独立管线（readEpub 解析，见 importEpub）
    return importEpub(srcPath, novelsDir, novelIdFor(srcPath, fs.statSync(srcPath).size));
  }
  const raw = fs.readFileSync(srcPath);
  const encoding = detectEncoding(raw);
  const text = encoding === 'utf8' ? raw.toString('utf8') : iconv.decode(raw, 'gbk');
  const chapters = parseChapters(text);
  const novelId = novelIdFor(srcPath, raw.length);
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

// Ruling P：epub 导入 —— 章节文本块拼成单个 UTF-8 存储文件（块间 '\n\n'），
// chapters 用增量行号：第 i 块 startLine = 前序块行数之和 + i
// （块间 '\n\n' 经 split('\n') 产生 1 个空行，故每块推进 块行数 + 1 —— 评审注记的
// "+2×(i)" 会使末章 startLine 越过 totalLines 切片为空，与"切片语义一致"目标冲突，
// 以切片不变式为准：startLine 指向该章第一行，分隔符在上一章切片末尾、本章 startLine 之前）。
async function importEpub(srcPath, novelsDir, novelId) {
  const book = await readEpub(srcPath);
  const storedPath = path.join(novelsDir, novelId + '.txt');
  const text = book.chapters.map(c => c.text).join('\n\n');
  fs.writeFileSync(storedPath, text, 'utf8');
  const chapters = [];
  let startLine = 0;
  for (const c of book.chapters) {
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
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    chapters.push({ title: h1.trim(), text });
  }
  return { title, chapters };
}

function getChapterText(storedPath, totalLines, chapter, nextStart) {
  const end = nextStart !== undefined ? nextStart : totalLines;
  const lines = fs.readFileSync(storedPath, 'utf8').split('\n').slice(chapter.startLine, end);
  return lines.join('\n');
}

module.exports = { detectEncoding, parseChapters, novelIdFor, importNovel, readEpub, getChapterText };
