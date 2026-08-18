import { describe, expect, it } from 'vitest';

import { at, minutes, overnightTimetable, simpleTimetable, simpleTimetableV2 } from '../test/fixtures';
import { RunDriver } from '../test/runDriver';
import {
  buildAggregateReport,
  buildRunReport,
  computePlannedSchedule,
  median,
  type RunReport,
} from './analysis';

// 05:30 local in Asia/Kolkata. Planned day is 06:00 -> 08:00 local.
const START = at('2026-03-02T00:00:00.000Z');

const observation = (report: RunReport, itemId: string) => {
  const found = report.observations.find((entry) => entry.item.id === itemId);
  if (!found) throw new Error(`no observation for ${itemId}`);
  return found;
};

describe('computePlannedSchedule', () => {
  it('resolves planned local times to UTC instants on the run day', () => {
    const planned = computePlannedSchedule(simpleTimetable, '2026-03-02');

    expect(planned.map((entry) => entry.plannedStartUtc.toISOString())).toEqual([
      '2026-03-02T00:30:00.000Z',
      '2026-03-02T01:00:00.000Z',
      '2026-03-02T02:00:00.000Z',
    ]);
    expect(planned.map((entry) => entry.plannedDurationMs)).toEqual([
      minutes(30),
      minutes(60),
      minutes(30),
    ]);
  });

  it('rolls onto the next calendar day when the plan crosses midnight', () => {
    const planned = computePlannedSchedule(overnightTimetable, '2026-03-02');

    expect(planned[0]?.plannedStartUtc.toISOString()).toBe('2026-03-02T18:00:00.000Z');
    expect(planned[0]?.plannedEndUtc.toISOString()).toBe('2026-03-02T18:45:00.000Z');
    // 00:15 belongs to the following local day, not the same morning.
    expect(planned[1]?.plannedStartUtc.toISOString()).toBe('2026-03-02T18:45:00.000Z');
    expect(planned[1]?.plannedEndUtc.toISOString()).toBe('2026-03-02T19:15:00.000Z');
    expect(planned.every((entry) => entry.plannedDurationMs > 0)).toBe(true);
  });
});

describe('buildRunReport', () => {
  const completedRun = () =>
    new RunDriver(simpleTimetable, START)
      .next(at('2026-03-02T01:00:00.000Z')) // wake ran 60m against a planned 30m
      .next(at('2026-03-02T01:50:00.000Z')) // gym ran 50m against a planned 60m
      .next(at('2026-03-02T02:40:00.000Z')); // breakfast ran 50m against a planned 30m

  it('measures start deviation against the planned start', () => {
    const driver = completedRun();
    const report = buildRunReport(simpleTimetable, driver.run, driver.events);

    // Started 05:30 local against a planned 06:00 local.
    expect(observation(report, 'wake').startDeviationMs).toBe(-minutes(30));
    expect(observation(report, 'gym').startDeviationMs).toBe(0);
    expect(observation(report, 'breakfast').startDeviationMs).toBe(-minutes(10));
  });

  describe('flexible execution reporting', () => {
    it('keeps original duration estimates after reordering and excludes reordered starts', () => {
      const driver = new RunDriver(simpleTimetable, START)
        .reorder('breakfast')
        .next(at('2026-03-02T00:30:00.000Z'))
        .next(at('2026-03-02T01:00:00.000Z'));
      const report = buildRunReport(simpleTimetable, driver.run, driver.events);

      expect(report.observations.map((observation) => observation.item.id)).toEqual([
        'wake',
        'breakfast',
        'gym',
      ]);
      const breakfast = report.observations[1]!;
      expect(breakfast.reordered).toBe(true);
      expect(breakfast.startDeviationMs).toBeNull();
      expect(breakfast.actualDurationMs).toBe(30 * 60_000);
    });

    it('reports time between tasks separately', () => {
      const driver = new RunDriver(simpleTimetable, START)
        .finish(at('2026-03-02T00:30:00.000Z'))
        .startNext(at('2026-03-02T00:45:00.000Z'));
      const report = buildRunReport(simpleTimetable, driver.run, driver.events);

      expect(report.totalBetweenTasksMs).toBe(15 * 60_000);
      expect(report.betweenTasks[0]).toMatchObject({
        afterItemId: 'wake',
        beforeItemId: 'gym',
        durationMs: 15 * 60_000,
      });
      expect(report.observations[0]?.actualDurationMs).toBe(30 * 60_000);
    });
  });

  it('measures actual duration and duration deviation', () => {
    const driver = completedRun();
    const report = buildRunReport(simpleTimetable, driver.run, driver.events);

    expect(observation(report, 'wake').actualDurationMs).toBe(minutes(60));
    expect(observation(report, 'wake').durationDeviationMs).toBe(minutes(30));
    expect(observation(report, 'gym').durationDeviationMs).toBe(-minutes(10));
    expect(observation(report, 'breakfast').durationDeviationMs).toBe(minutes(20));
  });

  it('counts only overruns towards total positive duration deviation', () => {
    const driver = completedRun();
    const report = buildRunReport(simpleTimetable, driver.run, driver.events);

    // The 10 minute underrun on gym does not offset the overruns.
    expect(report.totalPositiveDurationDeviationMs).toBe(minutes(50));
  });

  it('measures day-start and final completion deviation', () => {
    const driver = completedRun();
    const report = buildRunReport(simpleTimetable, driver.run, driver.events);

    expect(report.dayStartDeviationMs).toBe(-minutes(30));
    expect(report.finalCompletionDeviationMs).toBe(minutes(10));
  });

  it('reports skipped items without treating them as time saved', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .skip(at('2026-03-02T00:10:00.000Z'))
      .next(at('2026-03-02T02:00:00.000Z'))
      .next(at('2026-03-02T02:30:00.000Z'));
    const report = buildRunReport(simpleTimetable, driver.run, driver.events);
    const wake = observation(report, 'wake');

    expect(wake.skipped).toBe(true);
    expect(wake.actualDurationMs).toBeNull();
    expect(wake.durationDeviationMs).toBeNull();
    expect(wake.startDeviationMs).toBeNull();
    // The 30 planned minutes are not credited back anywhere.
    expect(wake.positiveDurationDeviationMs).toBe(0);
    expect(report.totalPositiveDurationDeviationMs).toBe(minutes(50));
    expect(report.skippedCount).toBe(1);
    expect(report.skipRate).toBeCloseTo(1 / 3);
  });

  it('ignores transitions that were undone', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .skip(at('2026-03-02T00:10:00.000Z'))
      .undo(at('2026-03-02T00:12:00.000Z'))
      .next(at('2026-03-02T01:00:00.000Z'))
      .next(at('2026-03-02T01:50:00.000Z'))
      .next(at('2026-03-02T02:40:00.000Z'));
    const report = buildRunReport(simpleTimetable, driver.run, driver.events);

    expect(report.skippedCount).toBe(0);
    expect(observation(report, 'wake').actualDurationMs).toBe(minutes(60));
    expect(report.totalPositiveDurationDeviationMs).toBe(minutes(50));
  });

  it('leaves an active run without a final completion deviation', () => {
    const driver = new RunDriver(simpleTimetable, START).next(at('2026-03-02T01:00:00.000Z'));
    const report = buildRunReport(simpleTimetable, driver.run, driver.events);

    expect(report.finalCompletionDeviationMs).toBeNull();
    expect(observation(report, 'breakfast').reached).toBe(false);
    expect(observation(report, 'breakfast').startDeviationMs).toBeNull();
  });
});

describe('median', () => {
  it('averages the middle pair for an even count', () => {
    expect(median([3, 1])).toBe(2);
    expect(median([1, 2, 3])).toBe(2);
    expect(median([-10, 10, 30, 50])).toBe(20);
    expect(median([])).toBeNull();
  });
});

describe('buildAggregateReport', () => {
  const reportsAcrossVersions = (): RunReport[] => {
    // Version 1: gym overruns by 30 minutes, breakfast by 5.
    const first = new RunDriver(simpleTimetable, START, 'run-a')
      .next(at('2026-03-02T00:30:00.000Z'))
      .next(at('2026-03-02T02:00:00.000Z'))
      .next(at('2026-03-02T02:35:00.000Z'));

    // Version 2 keeps the same stable item IDs; gym overruns by 40 minutes.
    const secondStart = at('2026-03-03T00:00:00.000Z');
    const second = new RunDriver(simpleTimetableV2, secondStart, 'run-b')
      .next(at('2026-03-03T00:30:00.000Z'))
      .next(at('2026-03-03T02:20:00.000Z'))
      .next(at('2026-03-03T02:50:00.000Z'));

    return [
      buildRunReport(simpleTimetable, first.run, first.events),
      buildRunReport(simpleTimetableV2, second.run, second.events),
    ];
  };

  it('groups by stable item ID across timetable versions', () => {
    const aggregate = buildAggregateReport('test-plan', 'Test plan', reportsAcrossVersions());

    expect(aggregate.runCount).toBe(2);
    expect(aggregate.versions).toEqual([1, 2]);
    expect(aggregate.items.map((item) => item.itemId).sort()).toEqual([
      'breakfast',
      'gym',
      'wake',
    ]);
    expect(aggregate.items.every((item) => item.observations === 2)).toBe(true);
  });

  it('uses the newest version for an item label', () => {
    const aggregate = buildAggregateReport('test-plan', 'Test plan', reportsAcrossVersions());
    const wake = aggregate.items.find((item) => item.itemId === 'wake');

    expect(wake?.label).toBe('Wake up');
  });

  it('ranks steps by total positive duration deviation', () => {
    const aggregate = buildAggregateReport('test-plan', 'Test plan', reportsAcrossVersions());

    expect(aggregate.items[0]?.itemId).toBe('gym');
    expect(aggregate.items[0]?.totalPositiveDurationDeviationMs).toBe(minutes(30 + 40));
    expect(aggregate.items[0]?.medianDurationDeviationMs).toBe(minutes(35));
    expect(aggregate.items.map((item) => item.itemId)).toEqual(['gym', 'wake', 'breakfast']);
  });

  it('reports skip count and skip rate per item', () => {
    const skippedRun = new RunDriver(simpleTimetable, START, 'run-c')
      .next(at('2026-03-02T00:30:00.000Z'))
      .skip(at('2026-03-02T02:00:00.000Z'))
      .next(at('2026-03-02T02:35:00.000Z'));

    const aggregate = buildAggregateReport('test-plan', 'Test plan', [
      ...reportsAcrossVersions(),
      buildRunReport(simpleTimetable, skippedRun.run, skippedRun.events),
    ]);
    const gym = aggregate.items.find((item) => item.itemId === 'gym');

    expect(gym?.skipCount).toBe(1);
    expect(gym?.observations).toBe(2);
    expect(gym?.skipRate).toBeCloseTo(1 / 3);
    // The skipped observation adds nothing to the deviation total.
    expect(gym?.totalPositiveDurationDeviationMs).toBe(minutes(70));
  });

  it('reports median start deviation per item', () => {
    const aggregate = buildAggregateReport('test-plan', 'Test plan', reportsAcrossVersions());
    const wake = aggregate.items.find((item) => item.itemId === 'wake');

    // Both runs started 30 minutes before the planned 06:00.
    expect(wake?.medianStartDeviationMs).toBe(-minutes(30));
  });

  it('returns an empty ranking when there are no runs', () => {
    const aggregate = buildAggregateReport('test-plan', 'Test plan', []);

    expect(aggregate.items).toEqual([]);
    expect(aggregate.totalPositiveDurationDeviationMs).toBe(0);
    expect(aggregate.medianDayStartDeviationMs).toBeNull();
  });
});
