import { describe, expect, it } from 'vitest';

import { computePlannedSchedule } from '../domain/analysis';
import { overnightTimetable, simpleTimetable } from '../test/fixtures';
import {
  instantFraction,
  moveTimelineBoundary,
  timelineSectionHeight,
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

describe('smart boundary movement', () => {
  const minute = 60_000;
  const segments = [
    {
      startEventId: 'a-start',
      endEventId: 'a-end',
      start: 0,
      end: 30 * minute,
    },
    {
      startEventId: 'b-start',
      endEventId: 'b-end',
      start: 40 * minute,
      end: 60 * minute,
    },
  ];

  it('prefers an exact neighboring edge over the five-minute grid', () => {
    const moved = moveTimelineBoundary(segments, 1, 'start', 31 * minute, 0, 90 * minute);
    expect(moved.magnetic).toBe(true);
    expect(moved.updates.get('b-start')).toBe(30 * minute);
    expect(moved.updates.has('a-end')).toBe(false);
  });

  it('creates a gap while moving away from a neighbor', () => {
    const moved = moveTimelineBoundary(segments, 0, 'end', 35 * minute, 0, 90 * minute);
    expect(moved.magnetic).toBe(false);
    expect(moved.updates.get('a-end')).toBe(35 * minute);
    expect(moved.updates.has('b-start')).toBe(false);
  });

  it('carries only the immediate neighbor when crossing it', () => {
    const topCross = moveTimelineBoundary(segments, 1, 'start', 20 * minute, 0, 90 * minute);
    expect(topCross.updates.get('a-end')).toBe(20 * minute);
    expect(topCross.updates.get('b-start')).toBe(20 * minute);

    const bottomCross = moveTimelineBoundary(segments, 0, 'end', 45 * minute, 0, 90 * minute);
    expect(bottomCross.updates.get('a-end')).toBe(45 * minute);
    expect(bottomCross.updates.get('b-start')).toBe(45 * minute);
  });

  it('does not cross immutable history between editable edges', () => {
    const segment = [
      {
        startEventId: 'start',
        endEventId: 'end',
        start: 10 * minute,
        end: 30 * minute,
      },
    ];

    const movedStart = moveTimelineBoundary(
      segment,
      0,
      'start',
      20 * minute,
      0,
      90 * minute,
      { maximum: 15 * minute },
    );
    expect(movedStart.updates.get('start')).toBe(15 * minute);

    const movedEnd = moveTimelineBoundary(
      segment,
      0,
      'end',
      10 * minute,
      0,
      90 * minute,
      { minimum: 15 * minute },
    );
    expect(movedEnd.updates.get('end')).toBe(15 * minute);
  });
});
