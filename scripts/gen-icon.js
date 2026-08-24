// Generates assets/tray.png (32x32) and assets/icon.ico (256x256) — a blue
// rounded-square shield with a white checkmark, drawn pixel-by-pixel.
// Zero dependencies (PNG via zlib + manual chunks; ICO wraps the PNG).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function inRoundedRect(x, y, size, radius) {
  const min = radius, max = size - radius;
  if (x < min) { if (y < min) return Math.hypot(x - min, y - min) <= radius; if (y > max) return Math.hypot(x - min, y - max) <= radius; return x >= 0; }
  if (x > max) { if (y < min) return Math.hypot(x - max, y - min) <= radius; if (y > max) return Math.hypot(x - max, y - max) <= radius; return x <= size; }
  return true;
}

function drawPng(size, radius) {
  const center = (x) => x + 0.5;
  const bg = [36, 113, 255]; // Windows blue
  const fg = [255, 255, 255];
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      const cx = center(x), cy = center(y);
      if (!inRoundedRect(cx, cy, size, radius)) continue;
      // checkmark: two thick segments (比例随尺寸缩放)
      const t = size / 32;
      const on = distToSegment(cx, cy, 7.5 * t, 16.5 * t, 13.5 * t, 22.5 * t) <= 2.6 * t ||
                 distToSegment(cx, cy, 13.5 * t, 22.5 * t, 24.5 * t, 9.5 * t) <= 2.6 * t;
      if (on) { raw[i] = fg[0]; raw[i + 1] = fg[1]; raw[i + 2] = fg[2]; raw[i + 3] = 255; }
      else { raw[i] = bg[0]; raw[i + 1] = bg[1]; raw[i + 2] = bg[2]; raw[i + 3] = 255; }
    }
  }
  return pngEncode(raw, size);
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
  let c, table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngEncode(raw, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ICO 封装（256x256 PNG 嵌入；width/height 字节 0 表示 256）
function icoFromPng(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); // type=1, count=1
  const entry = Buffer.alloc(16);
  entry[0] = 0; entry[1] = 0; // 256x256
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6); // planes=1, bpp=32
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // image offset
  return Buffer.concat([header, entry, png]);
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'tray.png'), drawPng(32, 7));
fs.writeFileSync(path.join(out, 'icon.ico'), icoFromPng(drawPng(256, 56)));
console.log('wrote assets/tray.png + assets/icon.ico');
