import { describe, expect, it } from 'vitest';

import { locateTimelineClock, timelineSectionHeight } from './timeline';

describe('timeline geometry', () => {
  it('uses bounded square-root scaling for task cards', () => {
    const short = timelineSectionHeight(15 * 60_000);
    const hour = timelineSectionHeight(60 * 60_000);
    const fourHours = timelineSectionHeight(4 * 60 * 60_000);

    expect(short).toBeGreaterThanOrEqual(96);
    expect(fourHours).toBeLessThanOrEqual(190);
    expect(fourHours / hour).toBeLessThan(4);
  });

  it('maps actual clock time through planned intervals', () => {
    const intervals = [
      { id: 'brush', durationMs: 15 * 60_000 },
      { id: 'gym', durationMs: 75 * 60_000 },
    ];

    expect(locateTimelineClock(intervals, 5 * 60_000)).toEqual({
      id: 'brush',
      fraction: 1 / 3,
    });
    expect(locateTimelineClock(intervals, 20 * 60_000)).toEqual({
      id: 'gym',
      fraction: 5 / 75,
    });
    expect(locateTimelineClock(intervals, 15 * 60_000)).toEqual({
      id: 'gym',
      fraction: 0,
    });
  });

  it('continues beyond the final planned interval', () => {
    const intervals = [{ id: 'sleep', durationMs: 8 * 60 * 60_000 }];
    expect(locateTimelineClock(intervals, 9 * 60 * 60_000)).toEqual({
      id: 'sleep',
      fraction: 1.125,
    });
    expect(locateTimelineClock([], 0)).toBeNull();
  });
});
