// main/mobi.js — MOBI（非 DRM）→ 纯文本章节，产出与 epub 管线同构的 { title, chapters }。
// 支持范围：PalmDoc 压缩(1)与无压缩(17480)、UTF-8/windows-1252 编码、多字节跨界重叠；
// HUFF/CDIC 压缩(2)与 DRM 加密明确抛错（导入 UI 显示），AZW3/KF8 不在范围。
// 参考：MOBI 格式（MobileRead Wiki）+ KindleUnpack 的 trailing entry 剥离算法。
const fs = require('fs');
const iconv = require('iconv-lite');

const COMPRESSION_PALMDOC = 1;
const COMPRESSION_HUFF = 2;
const COMPRESSION_NONE = 17480; // 'DH'

function be16(b, o) { return (b[o] << 8) | b[o + 1]; }
function be32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

// PalmDoc LZ77 解压：0x00=单字 0、0x01-0x08=后随 N 个字面量、0x09-0x7F=ASCII 字面量、
// 0x80-0xBF=距离/长度回引（11 位距离 + 3 位长度-3）、0xC0-0xFF=空格 + 大写化 ASCII
function palmdocDecompress(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const b = buf[i++];
    if (b === 0) out.push(0);
    else if (b <= 8) { for (let j = 0; j < b && i < buf.length; j++) out.push(buf[i++]); }
    else if (b <= 0x7f) out.push(b);
    else if (b <= 0xbf) {
      if (i >= buf.length) break;
      const b2 = buf[i++];
      const dist = (((b << 8) | b2) >> 3) & 0x7ff;
      const len = (b2 & 0x7) + 3;
      for (let j = 0; j < len; j++) out.push(out[out.length - dist]);
    } else {
      out.push(0x20);
      out.push(b & 0x7f);
    }
  }
  return Buffer.from(out);
}

// 尾部变长条目从记录末尾反向读 7bit 组（高位=继续标志），KindleUnpack 算法
function trailingEntrySize(buf, end) {
  let bitpos = 0, result = 0, size = end;
  if (size <= 0) return 0;
  for (;;) {
    const v = buf[size - 1];
    result |= (v & 0x7f) << bitpos;
    bitpos += 7;
    size -= 1;
    if ((v & 0x80) !== 0 || bitpos >= 28 || size === 0) return result;
  }
}

function decodeBytes(buf, encoding) {
  if (encoding === 65001) return buf.toString('utf8');
  return iconv.decode(buf, 'windows1252');
}

async function readMobi(srcPath, htmlToText) {
  const buf = fs.readFileSync(srcPath);
  if (buf.length < 86) throw new Error('不是有效的 MOBI 文件');

  // PalmDB 记录表：记录数 @76，其后每记录 8 字节（偏移 4B + 属性 1B + uid 3B）
  const numRecords = be16(buf, 76);
  if (numRecords < 1 || 78 + numRecords * 8 > buf.length) throw new Error('不是有效的 MOBI 文件');
  const offsets = [];
  for (let i = 0; i < numRecords; i++) offsets.push(be32(buf, 78 + i * 8));
  offsets.push(buf.length); // 末记录结束哨兵

  const rec0 = buf.slice(offsets[0], offsets[1]);
  const compression = be16(rec0, 0);
  const textLength = be32(rec0, 4);
  const recordCount = be16(rec0, 8);
  const encryption = be16(rec0, 12);
  if (encryption !== 0) throw new Error('该 MOBI 带 DRM 加密，无法导入');
  if (compression === COMPRESSION_HUFF) throw new Error('暂不支持 HUFF/CDIC 压缩的 MOBI（多为 Amazon 转换书）');
  if (compression !== COMPRESSION_PALMDOC && compression !== COMPRESSION_NONE) {
    throw new Error(`不支持的 MOBI 压缩类型: ${compression}`);
  }

  // MOBI 扩展头（可选）：编码 @28、书名偏移/长度 @84/88（相对记录 0）、
  // 尾部条目旗标 @0xF1（头长 ≥ 0xE4 时才存在）
  let encoding = 65001;
  let title = '';
  let extraFlags = 0;
  if (rec0.slice(16, 20).toString('latin1') === 'MOBI') {
    const mobiLen = be32(rec0, 20);
    encoding = be32(rec0, 28) || 65001;
    const nameOff = be32(rec0, 84);
    const nameLen = be32(rec0, 88);
    if (nameOff > 0 && nameLen > 0 && nameOff + nameLen <= rec0.length) {
      title = decodeBytes(rec0.slice(nameOff, nameOff + nameLen), encoding).trim();
    }
    if (mobiLen >= 0xe4 && rec0.length >= 0xf3) extraFlags = be16(rec0, 0xf1);
  }
  if (!title) {
    // 回落：PalmDB name 字段（32 字节 NUL 结尾）
    title = buf.slice(0, 32).toString('latin1').replace(/\0.*$/, '').trim() || '未命名';
  }

  // 文本记录 1..recordCount 逐条解压（回引不跨记录）。尾部条目与多字节重叠都在
  // 解压后的文本流上剥离（与 KindleUnpack 一致）；重叠字节由 pending 带到下一记录，
  // 全部拼完再按整书解码，避免记录边界断字。
  const chunks = [];
  let pending = Buffer.alloc(0);
  for (let i = 1; i <= Math.min(recordCount, numRecords - 1); i++) {
    const raw = buf.slice(offsets[i], offsets[i + 1]);
    let text = compression === COMPRESSION_PALMDOC ? palmdocDecompress(raw) : Buffer.from(raw);
    text = Buffer.concat([pending, text]);
    const isLast = i === recordCount;
    if (extraFlags) {
      let end = text.length;
      let bits = extraFlags & 0x7ffe;
      while (bits) { end -= trailingEntrySize(text, end); bits &= bits - 1; }
      if (extraFlags & 1 && end > 0) {
        // 末字节是标记（低 2 位 = 重叠字节数-1）；重叠字节摘给下一记录。
        // 末记录无"下一记录"，只剥标记字节本身
        const n = isLast ? 0 : (text[end - 1] & 0x3) + 1;
        pending = text.slice(Math.max(0, end - 1 - n), end - 1);
        end = end - 1 - n;
      }
      text = text.slice(0, Math.max(0, end));
    }
    chunks.push(text);
  }
  let html = decodeBytes(Buffer.concat(chunks), encoding);
  if (extraFlags & 1 && pending.length) html += decodeBytes(pending, encoding); // 末记录重叠（残字，通常为空）
  if (textLength > 0) html = html.slice(0, textLength); // 去尾部对齐/索引噪声

  // 按 mobi 分页标记切章；标题取章内 h1-h3（被采用时从正文剥除，避免渲染层
  // h2 标题与正文首行重复），缺省"第N章"
  const parts = html.split(/<mbp:pagebreak[^>]*>/i).map((s) => s.trim()).filter(Boolean);
  const chapters = (parts.length ? parts : [html]).map((chunk, i) => {
    let body = chunk;
    let head = '';
    const t = chunk.match(/<h[123][^>]*>([\s\S]*?)<\/h[123]>/i);
    if (t) {
      head = t[1].replace(/<[^>]+>/g, '').trim();
      body = chunk.slice(0, t.index) + chunk.slice(t.index + t[0].length);
    }
    return { title: head || `第${i + 1}章`, text: htmlToText(body) };
  }).filter((c) => c.text.length > 0);

  return { title, chapters };
}

module.exports = { readMobi, palmdocDecompress, trailingEntrySize };
