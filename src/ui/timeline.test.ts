import { describe, expect, it } from 'vitest';

import { computePlannedSchedule } from '../domain/analysis';
import { overnightTimetable, simpleTimetable } from '../test/fixtures';
import {
  fromLocalDateTimeValue,
  instantFraction,
  timelineSectionHeight,
  toLocalDateTimeValue,
} from './timeline';

describe('timeline geometry', () => {
  it('uses bounded square-root scaling instead of proportional heights', () => {
    const short = timelineSectionHeight(15 * 60_000);
    const hour = timelineSectionHeight(60 * 60_000);
    const fourHours = timelineSectionHeight(4 * 60 * 60_000);

    expect(short).toBeGreaterThanOrEqual(96);
    expect(fourHours).toBeLessThanOrEqual(190);
    expect(fourHours / hour).toBeLessThan(4);
  });

  it('maps current time within the transformed section', () => {
    const plan = computePlannedSchedule(simpleTimetable, '2026-03-02')[0]!;
    expect(instantFraction(plan, new Date('2026-03-02T00:45:00.000Z'))).toBe(0.5);
    expect(instantFraction(plan, new Date('2026-03-02T00:00:00.000Z'))).toBeNull();
  });

  it('supports a timetable day that crosses local midnight', () => {
    const plan = computePlannedSchedule(overnightTimetable, '2026-03-02');
    expect(instantFraction(plan[1]!, new Date('2026-03-02T19:00:00.000Z'))).toBe(0.5);
  });
});

describe('timetable-local correction input', () => {
  it('round-trips a local date and time through the timetable timezone', () => {
    const instant = new Date('2026-03-02T03:12:00.000Z');
    const value = toLocalDateTimeValue(instant, 'Asia/Kolkata');

    expect(value).toBe('2026-03-02T08:42');
    expect(fromLocalDateTimeValue(value, 'Asia/Kolkata')?.toISOString()).toBe(
      instant.toISOString(),
    );
  });
});
