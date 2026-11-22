// Generates the original Maybe Pile app icon (build/icon.png, 1024px) without
// any third-party artwork: a rounded square with three stacked "pile" bars.
// electron-builder derives .ico/.icns and Linux sizes from this PNG.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 1024;
const px = new Uint8Array(SIZE * SIZE * 4);

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Signed distance to a rounded rectangle; negative inside. */
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

function blend(i, rgb, a) {
  const o = px[i + 3] / 255;
  const outA = a + o * (1 - a);
  for (let k = 0; k < 3; k++) px[i + k] = outA === 0 ? 0 : (rgb[k] * a + px[i + k] * o * (1 - a)) / outA;
  px[i + 3] = outA * 255;
}

const S = SIZE / 1024;
const shapes = [
  // background tile
  { cx: 512, cy: 512, hw: 440, hh: 440, r: 200, rgb: [47, 79, 191] },
  // the pile (bottom to top), warm off-white
  { cx: 512, cy: 700, hw: 300, hh: 70, r: 40, rgb: [246, 245, 242] },
  { cx: 500, cy: 535, hw: 250, hh: 62, r: 36, rgb: [246, 245, 242] },
  { cx: 525, cy: 385, hw: 180, hh: 56, r: 32, rgb: [246, 245, 242] },
];

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    for (const s of shapes) {
      const d = sdRoundRect(x + 0.5, y + 0.5, s.cx * S, s.cy * S, s.hw * S, s.hh * S, s.r * S);
      const a = Math.max(0, Math.min(1, 0.5 - d)); // 1px anti-aliasing
      if (a > 0) blend(i, s.rgb, a);
    }
  }
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
mkdirSync('build', { recursive: true });
writeFileSync('build/icon.png', png);
console.log(`build/icon.png written (${png.length} bytes)`);
