/**
 * Static checks for the installable-PWA requirements.
 *
 * Installation and offline behaviour ultimately need a real browser, but the
 * inputs a browser depends on — a valid manifest, real icon files at the
 * declared sizes, and a worker that precaches the shell — can be verified here
 * so a deploy cannot silently ship an uninstallable app.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { loadBundledTimetables } from '../infrastructure/timetableAssets';

const root = resolve(__dirname, '..', '..');
const readIcon = (name: string) => readFileSync(resolve(root, 'public/icons', name));

/** PNG dimensions live in the IHDR chunk, immediately after the 8-byte signature. */
const pngSize = (buffer: Buffer) => ({
  signature: buffer.subarray(0, 8).toString('hex'),
  width: buffer.readUInt32BE(16),
  height: buffer.readUInt32BE(20),
});

describe('web app manifest', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'public/manifest.webmanifest'), 'utf-8'),
  ) as Record<string, unknown>;
  const icons = manifest.icons as { src: string; sizes: string; purpose?: string }[];

  it('declares a name, standalone display, and theme colours', () => {
    expect(manifest.name).toBe('Quartz');
    expect(manifest.short_name).toBe('Quartz');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe('#0d1117');
    expect(manifest.background_color).toBe('#0d1117');
  });

  it('uses relative start and scope so it works from any base path', () => {
    expect(manifest.start_url).toBe('.');
    expect(manifest.scope).toBe('.');
  });

  it('declares the icon sizes Android needs to install, including a maskable one', () => {
    expect(icons.map((icon) => icon.sizes)).toEqual(
      expect.arrayContaining(['192x192', '512x512']),
    );
    expect(icons.some((icon) => icon.purpose === 'maskable')).toBe(true);

    for (const icon of icons) {
      const [width, height] = icon.sizes.split('x').map(Number);
      const png = pngSize(readIcon(icon.src.replace('icons/', '')));
      expect(png.signature).toBe('89504e470d0a1a0a');
      expect(png.width).toBe(width);
      expect(png.height).toBe(height);
    }
  });

  it('keeps the entire maskable mark within the central 40%-radius safe circle', () => {
    const icon = icons.find((entry) => entry.purpose === 'maskable');
    if (!icon) throw new Error('Missing maskable icon');
    const buffer = readIcon(icon.src.replace('icons/', ''));
    const { width, height } = pngSize(buffer);
    expect(buffer[24]).toBe(8);
    expect(buffer[25]).toBe(2); // The generator writes opaque RGB PNGs.
    const compressed: Buffer[] = [];
    for (let offset = 8; offset < buffer.length;) {
      const length = buffer.readUInt32BE(offset);
      if (buffer.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
        compressed.push(buffer.subarray(offset + 8, offset + 8 + length));
      }
      offset += length + 12;
    }
    const pixels = inflateSync(Buffer.concat(compressed));
    const stride = width * 3 + 1;
    expect(pixels.length).toBe(stride * height);
    let markedPixels = 0;
    let furthestPixel = 0;
    for (let y = 0; y < height; y += 1) {
      expect(pixels[y * stride]).toBe(0);
      for (let x = 0; x < width; x += 1) {
        const offset = y * stride + 1 + x * 3;
        if (
          pixels[offset] === 13 &&
          pixels[offset + 1] === 17 &&
          pixels[offset + 2] === 23
        ) continue;
        markedPixels += 1;
        furthestPixel = Math.max(
          furthestPixel,
          Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2),
        );
      }
    }
    expect(markedPixels).toBeGreaterThan(0);
    expect(furthestPixel).toBeLessThanOrEqual(width * 0.4);
  });
});

describe('browser and Apple icons', () => {
  const html = new DOMParser().parseFromString(
    readFileSync(resolve(root, 'index.html'), 'utf-8'),
    'text/html',
  );

  it.each([
    ['icon', 32],
    ['apple-touch-icon', 180],
  ])('links a dedicated %s at its native size', (rel, size) => {
    const link = html.querySelector(`link[rel="${rel}"]`);
    const href = link?.getAttribute('href');
    if (!href) throw new Error(`Missing ${rel} link`);
    expect(href.startsWith('icons/')).toBe(true);
    expect(link?.getAttribute('sizes')).toBe(`${size}x${size}`);
    const png = pngSize(readIcon(href.replace('icons/', '')));
    expect(png.signature).toBe('89504e470d0a1a0a');
    expect(png.width).toBe(size);
    expect(png.height).toBe(size);
  });
});

describe('bundled timetables', () => {
  it('bundles exactly the two weekday plans', () => {
    const timetables = loadBundledTimetables();

    expect(timetables.map((timetable) => `${timetable.id}@${timetable.version}`).sort()).toEqual([
      'weekday-gym@1',
      'weekday-no-gym@1',
    ]);
    for (const timetable of timetables) {
      expect(timetable.eligibleWeekdays).toEqual([
        'monday',
        'tuesday',
        'wednesday',
        'thursday',
        'friday',
      ]);
    }
  });

  it('matches the agreed Gym and No-gym schedules', () => {
    const timetables = loadBundledTimetables();
    const gym = timetables.find((timetable) => timetable.id === 'weekday-gym');
    const noGym = timetables.find((timetable) => timetable.id === 'weekday-no-gym');
    const rows = (items: NonNullable<typeof gym>['items']) =>
      items.map((item) => `${item.plannedStart}-${item.plannedEnd} ${item.label}`);

    expect(gym && rows(gym.items)).toEqual([
      '05:30-05:45 Brush, hydrate and change',
      '05:45-07:00 🏋️ Gym',
      '07:00-07:30 Morning chores',
      '07:30-08:30 🚿 Shower and get ready',
      '08:30-08:45 🕉️ Pooja',
      '08:45-09:15 🥣 Breakfast',
      '09:15-10:15 🚗 Commute',
      '10:15-13:00 💼 Work',
      '13:00-13:45 🍽️ Lunch',
      '13:45-17:30 💼 Work',
      '17:30-18:45 🚗 Commute home',
      '18:45-19:00 Decompress and change',
      '19:00-19:15 🕉️ Evening Pooja',
      '19:15-20:00 Flexible time',
      '20:00-20:45 🍽️ Dinner',
      '20:45-21:00 Dishwasher + Trash',
      '21:00-21:30 Night routine and wind down',
      '21:30-05:30 😴 Sleep',
    ]);
    expect(noGym && rows(noGym.items)).toEqual([
      '05:30-05:45 Brush, hydrate and change',
      '05:45-06:00 🕉️ Pooja',
      '06:00-06:15 Meditation',
      '06:15-06:45 Morning chores',
      '06:45-08:00 🚿 Shower and get ready',
      '08:00-08:30 🥣 Breakfast',
      '08:30-09:30 🚗 Commute',
      '09:30-13:00 💼 Work',
      '13:00-13:45 🍽️ Lunch',
      '13:45-17:30 💼 Work',
      '17:30-18:45 🚗 Commute home',
      '18:45-19:00 Decompress and change',
      '19:00-19:15 🕉️ Evening Pooja',
      '19:15-20:00 Flexible time',
      '20:00-20:45 🍽️ Dinner',
      '20:45-21:00 Dishwasher + Trash',
      '21:00-21:30 Night routine and wind down',
      '21:30-05:30 😴 Sleep',
    ]);
  });
});
