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
    const icons = manifest.icons as { src: string; sizes: string; purpose?: string }[];
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
      '19:15-20:00 Free time or optional work',
      '20:00-20:45 🍽️ Dinner',
      '20:45-21:00 Dishwasher loading',
      '21:00-21:15 🪥 Brush',
      '21:15-21:30 Wind down',
      '21:30-05:30 😴 Sleep',
    ]);
    expect(noGym && rows(noGym.items)).toEqual([
      '05:30-05:45 Brush, hydrate and change',
      '05:45-06:00 🕉️ Pooja',
      '06:00-06:30 Morning chores',
      '06:30-07:30 🚿 Shower and get ready',
      '07:30-08:00 💼 Work from home',
      '08:00-08:30 🥣 Breakfast',
      '08:30-09:30 🚗 Commute',
      '09:30-13:00 💼 Work',
      '13:00-13:45 🍽️ Lunch',
      '13:45-17:30 💼 Work',
      '17:30-18:45 🚗 Commute home',
      '18:45-19:00 Decompress and change',
      '19:00-19:15 🕉️ Evening Pooja',
      '19:15-20:00 Free time or optional work',
      '20:00-20:45 🍽️ Dinner',
      '20:45-21:00 Dishwasher loading',
      '21:00-21:15 🪥 Brush',
      '21:15-21:30 Wind down',
      '21:30-05:30 😴 Sleep',
    ]);
  });
});
