// Generates assets/tray.png — a 32x32 blue rounded-square shield with a white
// checkmark, drawn pixel-by-pixel. Zero dependencies (PNG via zlib + manual chunks).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 32;
const RADIUS = 7;

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function inRoundedRect(x, y) {
  const min = RADIUS, max = SIZE - RADIUS;
  if (x < min) { if (y < min) return Math.hypot(x - min, y - min) <= RADIUS; if (y > max) return Math.hypot(x - min, y - max) <= RADIUS; return x >= 0; }
  if (x > max) { if (y < min) return Math.hypot(x - max, y - min) <= RADIUS; if (y > max) return Math.hypot(x - max, y - max) <= RADIUS; return x <= SIZE; }
  return true;
}

const center = x => x + 0.5;
const bg = [36, 113, 255]; // Windows blue
const fg = [255, 255, 255];

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const i = y * (SIZE * 4 + 1) + 1 + x * 4;
    const cx = center(x), cy = center(y);
    if (!inRoundedRect(cx, cy)) continue;
    // checkmark: two thick segments
    const on = distToSegment(cx, cy, 7.5, 16.5, 13.5, 22.5) <= 2.6 ||
               distToSegment(cx, cy, 13.5, 22.5, 24.5, 9.5) <= 2.6;
    if (on) { raw[i] = fg[0]; raw[i + 1] = fg[1]; raw[i + 2] = fg[2]; raw[i + 3] = 255; }
    else { raw[i] = bg[0]; raw[i + 1] = bg[1]; raw[i + 2] = bg[2]; raw[i + 3] = 255; }
  }
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

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'assets', 'tray.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
