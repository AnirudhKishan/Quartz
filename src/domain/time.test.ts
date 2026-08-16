import { describe, expect, it } from 'vitest';

import {
  addDaysToLocalDate,
  formatClockTime,
  getLocalDate,
  getTimezoneOffsetMs,
  parseClockTime,
  zonedLocalTimeToUtc,
} from '../domain/time';

describe('parseClockTime', () => {
  it('reads HH:mm as minutes from local midnight', () => {
    expect(parseClockTime('00:00')).toBe(0);
    expect(parseClockTime('05:45')).toBe(345);
    expect(parseClockTime('23:59')).toBe(1439);
  });

  it('rejects malformed and out-of-range times', () => {
    expect(() => parseClockTime('5:45')).toThrow(/HH:mm/);
    expect(() => parseClockTime('24:00')).toThrow(/out of range/);
    expect(() => parseClockTime('07:60')).toThrow(/out of range/);
  });
});

describe('formatClockTime', () => {
  it('wraps around midnight', () => {
    expect(formatClockTime(345)).toBe('05:45');
    expect(formatClockTime(1440)).toBe('00:00');
    expect(formatClockTime(-60)).toBe('23:00');
  });
});

describe('zonedLocalTimeToUtc', () => {
  it('resolves a half-hour offset zone', () => {
    const instant = zonedLocalTimeToUtc('2026-03-02', parseClockTime('05:30'), 'Asia/Kolkata');
    expect(instant.toISOString()).toBe('2026-03-02T00:00:00.000Z');
  });

  it('resolves a whole-hour offset zone', () => {
    const instant = zonedLocalTimeToUtc('2026-01-15', parseClockTime('09:00'), 'Europe/London');
    expect(instant.toISOString()).toBe('2026-01-15T09:00:00.000Z');
  });

  it('applies a day offset for planned times that cross midnight', () => {
    const instant = zonedLocalTimeToUtc('2026-03-02', parseClockTime('00:15'), 'Asia/Kolkata', 1);
    expect(instant.toISOString()).toBe('2026-03-02T18:45:00.000Z');
  });

  it('uses the correct offset on each side of a daylight-saving change', () => {
    const beforeDst = zonedLocalTimeToUtc('2026-03-28', parseClockTime('12:00'), 'Europe/London');
    const afterDst = zonedLocalTimeToUtc('2026-03-29', parseClockTime('12:00'), 'Europe/London');
    expect(beforeDst.toISOString()).toBe('2026-03-28T12:00:00.000Z');
    expect(afterDst.toISOString()).toBe('2026-03-29T11:00:00.000Z');
  });

  it('resolves a nonexistent local time in the spring-forward gap deterministically', () => {
    // 01:30 does not exist on 2026-03-29 in London; the clock jumps 01:00 -> 02:00.
    const instant = zonedLocalTimeToUtc('2026-03-29', parseClockTime('01:30'), 'Europe/London');
    expect(instant.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(Number.isNaN(instant.getTime())).toBe(false);
  });

  it('resolves an ambiguous local time in the autumn overlap to the earlier instant', () => {
    // 01:30 happens twice on 2026-10-25 in London (BST then GMT).
    const instant = zonedLocalTimeToUtc('2026-10-25', parseClockTime('01:30'), 'Europe/London');
    expect(instant.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('measures a planned duration that contains a daylight-saving change', () => {
    const start = zonedLocalTimeToUtc('2026-03-29', parseClockTime('00:30'), 'Europe/London');
    const end = zonedLocalTimeToUtc('2026-03-29', parseClockTime('02:30'), 'Europe/London');
    // Two hours on the clock, one real hour.
    expect(end.getTime() - start.getTime()).toBe(60 * 60_000);
  });
});

describe('getLocalDate', () => {
  it('reports the calendar date in the timetable zone, not the host zone', () => {
    const instant = new Date('2026-03-01T20:00:00.000Z');
    expect(getLocalDate(instant, 'Asia/Kolkata')).toBe('2026-03-02');
    expect(getLocalDate(instant, 'UTC')).toBe('2026-03-01');
    expect(getLocalDate(instant, 'America/Los_Angeles')).toBe('2026-03-01');
  });
});

describe('getTimezoneOffsetMs', () => {
  it('returns the offset ahead of UTC', () => {
    expect(getTimezoneOffsetMs(new Date('2026-01-15T00:00:00Z'), 'Asia/Kolkata')).toBe(
      5.5 * 60 * 60_000,
    );
    expect(getTimezoneOffsetMs(new Date('2026-07-15T00:00:00Z'), 'Europe/London')).toBe(60 * 60_000);
  });
});

describe('addDaysToLocalDate', () => {
  it('rolls across month and year boundaries', () => {
    expect(addDaysToLocalDate('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDaysToLocalDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToLocalDate('2026-01-01', -1)).toBe('2025-12-31');
  });
});
