import { describe, expect, it } from 'vitest';

import { QuartzError } from './errors';
import { parseTimetable, assertUniqueVersions, timetablesEqual, toSummary } from './timetable';

const valid = {
  id: 'weekday-gym',
  name: 'Gym weekday',
  version: 1,
  timezone: 'Asia/Kolkata',
  items: [
    { id: 'wake', label: 'Wake', plannedStart: '05:30', plannedEnd: '05:45' },
    { id: 'gym', label: 'Gym', plannedStart: '05:45', plannedEnd: '07:00' },
  ],
};

const detailsOf = (run: () => unknown): string[] => {
  try {
    run();
  } catch (error) {
    if (error instanceof QuartzError) return [error.message, ...error.details];
  }
  return [];
};

describe('parseTimetable', () => {
  it('accepts a well-formed definition', () => {
    const timetable = parseTimetable(valid);
    expect(timetable.id).toBe('weekday-gym');
    expect(timetable.items).toHaveLength(2);
  });

  it('rejects a non-integer or zero version', () => {
    expect(detailsOf(() => parseTimetable({ ...valid, version: 1.5 }))).toContain(
      'version must be an integer of at least 1',
    );
    expect(detailsOf(() => parseTimetable({ ...valid, version: 0 }))).toContain(
      'version must be an integer of at least 1',
    );
  });

  it('rejects an unknown timezone', () => {
    expect(detailsOf(() => parseTimetable({ ...valid, timezone: 'Mars/Olympus' }))).toContain(
      'timezone must be a valid IANA timezone, got "Mars/Olympus"',
    );
  });

  it('rejects an empty item list', () => {
    expect(detailsOf(() => parseTimetable({ ...valid, items: [] }))).toContain(
      'items must be a non-empty ordered array',
    );
  });

  it('rejects duplicate stable item IDs', () => {
    const duplicated = {
      ...valid,
      items: [valid.items[0], { ...valid.items[0], plannedStart: '06:00', plannedEnd: '06:15' }],
    };
    expect(detailsOf(() => parseTimetable(duplicated)).join(' ')).toMatch(/duplicated/);
  });

  it('rejects a zero-length planned duration', () => {
    const zeroLength = {
      ...valid,
      items: [{ id: 'wake', label: 'Wake', plannedStart: '05:30', plannedEnd: '05:30' }],
    };
    expect(detailsOf(() => parseTimetable(zeroLength)).join(' ')).toMatch(
      /zero-length planned duration/,
    );
  });

  it('rejects a malformed planned time', () => {
    const bad = {
      ...valid,
      items: [{ id: 'wake', label: 'Wake', plannedStart: '5:30', plannedEnd: '05:45' }],
    };
    expect(detailsOf(() => parseTimetable(bad))).toContain('items[0].plannedStart must be an HH:mm time');
  });

  it('accepts an item that crosses midnight', () => {
    const overnight = {
      ...valid,
      items: [{ id: 'wind-down', label: 'Wind down', plannedStart: '23:30', plannedEnd: '00:15' }],
    };
    expect(parseTimetable(overnight).items).toHaveLength(1);
  });
});

describe('assertUniqueVersions', () => {
  it('rejects two definitions sharing an id and version', () => {
    const a = parseTimetable(valid);
    const b = parseTimetable({ ...valid, name: 'Different name' });
    expect(() => assertUniqueVersions([a, b])).toThrow(/Duplicate timetable definition/);
  });

  it('accepts the same id at different versions', () => {
    const a = parseTimetable(valid);
    const b = parseTimetable({ ...valid, version: 2 });
    expect(() => assertUniqueVersions([a, b])).not.toThrow();
  });
});

describe('timetablesEqual', () => {
  it('detects a changed planned time', () => {
    const a = parseTimetable(valid);
    const b = parseTimetable({
      ...valid,
      items: [{ ...valid.items[0], plannedEnd: '05:50' }, valid.items[1]],
    });
    expect(timetablesEqual(a, a)).toBe(true);
    expect(timetablesEqual(a, b)).toBe(false);
  });
});

describe('toSummary', () => {
  it('reports the span of the plan', () => {
    const summary = toSummary(parseTimetable(valid));
    expect(summary).toMatchObject({
      id: 'weekday-gym',
      version: 1,
      itemCount: 2,
      firstPlannedStart: '05:30',
      lastPlannedEnd: '07:00',
    });
  });
});
