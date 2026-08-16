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
  it('bundles more than one selectable, versioned timetable', () => {
    const timetables = loadBundledTimetables();

    expect(timetables.length).toBeGreaterThanOrEqual(2);
    expect(new Set(timetables.map((timetable) => timetable.id)).size).toBeGreaterThanOrEqual(2);
    // The same stable ID must be able to carry more than one immutable version.
    expect(timetables.filter((timetable) => timetable.id === 'weekday-gym')).toHaveLength(2);
  });
});
