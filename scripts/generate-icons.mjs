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
const FACE = [23, 54, 95];
const HIGHLIGHT = [33, 77, 131];
const OUTLINE = [55, 135, 247];
const TIMELINE = [169, 207, 255];
const CURRENT = [248, 81, 73];
const WHITE = [255, 255, 255];

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
 * The Quartz timeline inside a faceted crystal.
 *
 * `inset` shrinks the mark so a maskable icon survives being cropped to a circle.
 */
const timelinePrism = (size, inset) => {
  const cx = size / 2;
  const cy = size / 2;
  const radius = (size / 2) * inset;
  const inCrystal = (x, y, shapeRadius) => {
    const dx = x - cx;
    const dy = y - cy;
    const halfWidth = shapeRadius * 0.62;
    const shoulder = shapeRadius * 0.5;
    if (Math.abs(dx) > halfWidth) return false;
    const taper = Math.max(0, Math.abs(dy) - shoulder) / (shapeRadius - shoulder);
    return Math.abs(dy) <= shapeRadius && Math.abs(dx) <= halfWidth * (1 - taper);
  };
  const nearSegment = (x, y, x1, y1, x2, y2, width) => {
    const vx = x2 - x1;
    const vy = y2 - y1;
    const lengthSquared = vx * vx + vy * vy;
    const projection = Math.max(
      0,
      Math.min(1, ((x - x1) * vx + (y - y1) * vy) / lengthSquared),
    );
    const dx = x - (x1 + projection * vx);
    const dy = y - (y1 + projection * vy);
    return dx * dx + dy * dy <= width * width;
  };
  const sample = (x, y) => {
    if (!inCrystal(x, y, radius)) return BACKGROUND;
    if (!inCrystal(x, y, radius - Math.max(2, radius * 0.035))) return OUTLINE;

    const base = x < cx ? HIGHLIGHT : FACE;
    const timelineX = cx - radius * 0.23;
    const timelineTop = cy - radius * 0.64;
    const timelineBottom = cy + radius * 0.64;
    const lineWidth = Math.max(1.25, radius * 0.022);
    const nodeRadius = radius * 0.075;
    const nodeStroke = radius * 0.025;
    const nodes = [-0.52, -0.06, 0.52].map((offset) => cy + radius * offset);

    const currentY = cy + radius * 0.16;
    if (
      nearSegment(
        x,
        y,
        cx - radius * 0.47,
        currentY,
        cx + radius * 0.48,
        currentY,
        radius * 0.027,
      )
    ) {
      return CURRENT;
    }

    if (nearSegment(x, y, timelineX, timelineTop, timelineX, timelineBottom, lineWidth)) {
      return TIMELINE;
    }

    for (const nodeY of nodes) {
      const distance = Math.hypot(x - timelineX, y - nodeY);
      if (distance <= nodeRadius - nodeStroke) return BACKGROUND;
      if (distance <= nodeRadius) return TIMELINE;
    }

    if (Math.hypot(x - timelineX, y - currentY) <= radius * 0.047) return WHITE;

    const bars = [
      { y: cy - radius * 0.54, end: cx + radius * 0.38 },
      { y: cy - radius * 0.08, end: cx + radius * 0.25 },
      { y: cy + radius * 0.5, end: cx + radius * 0.42 },
    ];
    for (const bar of bars) {
      if (
        nearSegment(
          x,
          y,
          cx + radius * 0.01,
          bar.y,
          bar.end,
          bar.y,
          radius * 0.032,
        )
      ) {
        return OUTLINE;
      }
    }
    return base;
  };

  return (x, y) => {
    const samples = 4;
    const total = [0, 0, 0];
    for (let sampleY = 0; sampleY < samples; sampleY += 1) {
      for (let sampleX = 0; sampleX < samples; sampleX += 1) {
        const color = sample(x + (sampleX + 0.5) / samples, y + (sampleY + 0.5) / samples);
        total[0] += color[0];
        total[1] += color[1];
        total[2] += color[2];
      }
    }
    return total.map((channel) => Math.round(channel / (samples * samples)));
  };
};

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { name: 'icon-192.png', size: 192, inset: 0.8 },
  { name: 'icon-512.png', size: 512, inset: 0.8 },
  { name: 'maskable-512.png', size: 512, inset: 0.55 },
];

for (const { name, size, inset } of targets) {
  writeFileSync(join(OUT_DIR, name), encodePng(size, timelinePrism(size, inset)));
  console.log(`wrote ${name} (${size}x${size})`);
}
