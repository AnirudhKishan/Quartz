import { describe, expect, it } from 'vitest';

import { parseRoute, routeToHash } from './router';

describe('time budget review routes', () => {
  it('round-trips a selected historical version', () => {
    const route = {
      kind: 'timetable-report' as const,
      timetableId: 'weekday/gym',
      version: 3,
    };

    expect(parseRoute(routeToHash(route))).toEqual(route);
  });

  it('ignores an invalid version query', () => {
    expect(parseRoute('#/reports/timetable/test-plan?version=not-a-number')).toEqual({
      kind: 'timetable-report',
      timetableId: 'test-plan',
      version: null,
    });
  });
});
