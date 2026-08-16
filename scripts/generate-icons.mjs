/**
 * Generate the PWA icons.
 *
 * The icons are committed, so a build never depends on an image toolchain. This
 * script writes them from scratch with zlib only, which keeps the repository
 * free of binary tooling while still producing real PNG files.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const BACKGROUND = [13, 17, 23];
const FACE = [47, 129, 247];
const HIGHLIGHT = [126, 179, 255];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

const encodePng = (size, pixel) => {
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = pixel(x, y);
      const offset = y * (stride + 1) + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

/**
 * A quartz crystal: a hexagon with a lighter left face.
 *
 * `inset` shrinks the mark so a maskable icon survives being cropped to a circle.
 */
const crystal = (size, inset) => {
  const cx = size / 2;
  const cy = size / 2;
  const radius = (size / 2) * inset;
  const halfWidth = radius * 0.62;
  const shoulder = radius * 0.5;

  return (x, y) => {
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    if (Math.abs(dx) > halfWidth) return BACKGROUND;

    // Point at top and bottom, straight sides between the shoulders.
    const taper = Math.max(0, Math.abs(dy) - shoulder) / (radius - shoulder);
    if (Math.abs(dy) > radius) return BACKGROUND;
    if (Math.abs(dx) > halfWidth * (1 - taper)) return BACKGROUND;

    return dx < -halfWidth * 0.12 ? HIGHLIGHT : FACE;
  };
};

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { name: 'icon-192.png', size: 192, inset: 0.8 },
  { name: 'icon-512.png', size: 512, inset: 0.8 },
  { name: 'maskable-512.png', size: 512, inset: 0.55 },
];

for (const { name, size, inset } of targets) {
  writeFileSync(join(OUT_DIR, name), encodePng(size, crystal(size, inset)));
  console.log(`wrote ${name} (${size}x${size})`);
}
