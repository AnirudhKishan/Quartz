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
const FACE_TOP = [160, 225, 255];
const FACE_BOTTOM = [63, 145, 237];

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
 * An icy-blue faceted quartz crystal.
 *
 * Coordinates are relative to the crystal's radius. The maskable target keeps
 * the whole crystal inside the central safe circle (40% of the image width).
 */
const crystal = (size, inset) => {
  const radius = (size / 2) * inset;
  const outline = [
    [0, -1], [0.8, -0.5], [0.8, 0.5],
    [0, 1], [-0.8, 0.5], [-0.8, -0.5],
  ];
  const face = [
    [0, -0.69], [0.53, -0.35], [0.53, 0.35],
    [0, 0.69], [-0.53, 0.35], [-0.53, -0.35],
  ];
  const facetColors = [
    [130, 204, 255], [58, 130, 224], [41, 100, 204],
    [71, 154, 241], [113, 202, 255], [205, 244, 255],
  ];
  const facets = outline.map((point, index) => {
    const next = (index + 1) % outline.length;
    return {
      points: [point, outline[next], face[next], face[index]],
      color: facetColors[index],
    };
  });
  const inPolygon = (x, y, points) =>
    points.every(([x1, y1], index) => {
      const [x2, y2] = points[(index + 1) % points.length];
      return (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1) >= 0;
    });
  const sample = (x, y) => {
    const px = (x - size / 2) / radius;
    const py = (y - size / 2) / radius;
    if (!inPolygon(px, py, outline)) return BACKGROUND;
    if (!inPolygon(px, py, face)) {
      return facets.find((facet) => inPolygon(px, py, facet.points)).color;
    }

    const blend = (py + 0.69) / 1.38;
    return FACE_TOP.map((channel, index) => channel + (FACE_BOTTOM[index] - channel) * blend);
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
  { name: 'crystal-32.png', size: 32, inset: 0.84 },
  { name: 'crystal-180.png', size: 180, inset: 0.84 },
  { name: 'crystal-192.png', size: 192, inset: 0.84 },
  { name: 'crystal-512.png', size: 512, inset: 0.84 },
  { name: 'crystal-maskable-512.png', size: 512, inset: 0.72 },
];

for (const { name, size, inset } of targets) {
  writeFileSync(join(OUT_DIR, name), encodePng(size, crystal(size, inset)));
  console.log(`wrote ${name} (${size}x${size})`);
}
