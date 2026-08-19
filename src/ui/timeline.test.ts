import { describe, expect, it } from 'vitest';

import {
  locateTimelineClock,
  locateTimelineClockCard,
  moveTimelineBoundary,
  timelineDragTime,
  timelineEditSectionHeight,
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

  it('maps elapsed wall time continuously through planned intervals', () => {
    const intervals = [
      { id: 'wake', durationMs: 15 * 60_000 },
      { id: 'gym', durationMs: 75 * 60_000 },
    ];

    expect(locateTimelineClock(intervals, 5 * 60_000)).toEqual({
      id: 'wake',
      fraction: 1 / 3,
    });
    expect(locateTimelineClock(intervals, 20 * 60_000)).toEqual({
      id: 'gym',
      fraction: 5 / 75,
    });
    expect(locateTimelineClock(intervals, 0)).toEqual({ id: 'wake', fraction: 0 });
  });

  it('continues beyond the final planned interval', () => {
    const intervals = [{ id: 'sleep', durationMs: 8 * 60 * 60_000 }];
    expect(locateTimelineClock(intervals, 9 * 60 * 60_000)).toEqual({
      id: 'sleep',
      fraction: 1.125,
    });
  });

  it('moves exact planned boundaries into the next interval', () => {
    const intervals = [
      { id: 'first', durationMs: 15 * 60_000 },
      { id: 'second', durationMs: 15 * 60_000 },
    ];
    expect(locateTimelineClock(intervals, 15 * 60_000)).toEqual({
      id: 'second',
      fraction: 0,
    });
    expect(locateTimelineClock([], 5 * 60_000)).toBeNull();
  });

  it('uses a finger-sized five-minute edit scale including scroll movement', () => {
    const start = Date.UTC(2026, 2, 2, 7, 0);
    expect(timelineDragTime(start, 40)).toBe(start + 5 * 60_000);
    expect(timelineDragTime(start, 20, 20)).toBe(start + 5 * 60_000);
    expect(timelineEditSectionHeight(15 * 60_000)).toBe(129);
  });

  it('maps a planned interval across every rendered segment card', () => {
    const cards = [
      { key: 'first-segment', height: 80 },
      { key: 'resumed-segment', height: 120 },
    ];
    expect(locateTimelineClockCard(cards, 0.25)).toEqual({
      key: 'first-segment',
      fraction: 0.625,
    });
    expect(locateTimelineClockCard(cards, 0.7)).toEqual({
      key: 'resumed-segment',
      fraction: 0.5,
    });
    const overrun = locateTimelineClockCard(cards, 1.1);
    expect(overrun?.key).toBe('resumed-segment');
    expect(overrun?.fraction).toBeCloseTo(1 + 20 / 120);
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

  it('moves away from an aligned edge without a magnetic dead zone', () => {
    const aligned = [
      {
        startEventId: 'a-start',
        endEventId: 'a-end',
        start: 0,
        end: 30 * minute,
      },
      {
        startEventId: 'b-start',
        endEventId: 'b-end',
        start: 30 * minute,
        end: 60 * minute,
      },
    ];

    const topDown = moveTimelineBoundary(aligned, 1, 'start', 35 * minute, 0, 90 * minute);
    expect(topDown.updates.get('b-start')).toBe(35 * minute);
    expect(topDown.updates.has('a-end')).toBe(false);

    const topUp = moveTimelineBoundary(aligned, 1, 'start', 25 * minute, 0, 90 * minute);
    expect(topUp.updates.get('a-end')).toBe(25 * minute);
    expect(topUp.updates.get('b-start')).toBe(25 * minute);

    const bottomDown = moveTimelineBoundary(aligned, 0, 'end', 35 * minute, 0, 90 * minute);
    expect(bottomDown.updates.get('a-end')).toBe(35 * minute);
    expect(bottomDown.updates.get('b-start')).toBe(35 * minute);

    const bottomUp = moveTimelineBoundary(aligned, 0, 'end', 25 * minute, 0, 90 * minute);
    expect(bottomUp.updates.get('a-end')).toBe(25 * minute);
    expect(bottomUp.updates.has('b-start')).toBe(false);
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
