// One-shot icon generator for the PWA (no image tooling needed): draws
// the Flowdeck mark — a rounded indigo square with a white F — and writes
// plain PNGs via node:zlib. Run: node scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

function png(width, height, pixel) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      row.writeUInt8(r, 1 + x * 4);
      row.writeUInt8(g, 2 + x * 4);
      row.writeUInt8(b, 3 + x * 4);
      row.writeUInt8(a, 4 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let table;
function crc32(buf) {
  table ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const INDIGO = [0x4f, 0x46, 0xe5, 255];
const WHITE = [255, 255, 255, 255];

/** Rounded-square icon with the F glyph; `pad` shrinks the square for
 *  maskable icons (safe zone). */
function drawIcon(size, { maskable = false } = {}) {
  const pad = maskable ? 0 : size * 0.08; // regular icons get rounded corners
  const radius = maskable ? 0 : size * 0.22;
  const cx = size / 2;
  const glyph = size * (maskable ? 0.42 : 0.5); // F bounding box
  const stroke = glyph * 0.24;
  const left = cx - glyph / 2;
  const top = cx - glyph / 2;
  const inRoundedSquare = (x, y) => {
    const minX = pad, minY = pad, maxX = size - pad, maxY = size - pad;
    if (x < minX || x > maxX || y < minY || y > maxY) return false;
    if (radius <= 0) return true;
    const rx = Math.min(radius, (maxX - minX) / 2);
    const ry = Math.min(radius, (maxY - minY) / 2);
    const dx = Math.max(minX + rx - x, 0, x - (maxX - rx));
    const dy = Math.max(minY + ry - y, 0, y - (maxY - ry));
    if (dx === 0 || dy === 0) return true;
    return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
  };
  const inF = (x, y) => {
    if (y < top || y > top + glyph || x < left || x > left + glyph) return false;
    const inBar = (x0, x1, y0, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    return (
      inBar(left, left + stroke, top, top + glyph) || // vertical
      inBar(left, left + glyph * 0.82, top, top + stroke) || // top arm
      inBar(left, left + glyph * 0.62, top + glyph * 0.44, top + glyph * 0.44 + stroke) // mid arm
    );
  };
  return png(size, size, (x, y) => {
    if (inF(x, y)) return WHITE;
    if (inRoundedSquare(x, y)) return INDIGO;
    return [0, 0, 0, 0];
  });
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', drawIcon(192));
writeFileSync('public/icons/icon-512.png', drawIcon(512));
writeFileSync('public/icons/maskable-512.png', drawIcon(512, { maskable: true }));
console.log('icons written to public/icons');
