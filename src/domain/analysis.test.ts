import { describe, expect, it } from 'vitest';

import { at, minutes, overnightTimetable, simpleTimetable } from '../test/fixtures';
import { RunDriver } from '../test/runDriver';
import {
  buildRunReport,
  buildTimeBudgetAnalysis,
  computePlannedSchedule,
  median,
  nearestRankPercentile,
  type RunReport,
} from './analysis';
import type { Timetable } from './types';

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

    it('sums resumed segments and keeps pause time separate', () => {
      const driver = new RunDriver(simpleTimetable, START)
        .pause(at('2026-03-02T00:10:00.000Z'))
        .resume(at('2026-03-02T00:20:00.000Z'))
        .next(at('2026-03-02T00:40:00.000Z'));
      const report = buildRunReport(simpleTimetable, driver.run, driver.events);
      const wake = observation(report, 'wake');

      expect(wake.segmentCount).toBe(2);
      expect(wake.actualDurationMs).toBe(minutes(30));
      expect(wake.durationDeviationMs).toBe(0);
      expect(report.insertedObservations).toHaveLength(1);
      expect(report.totalInsertedDurationMs).toBe(minutes(10));
      expect(report.totalBetweenTasksMs).toBe(0);
    });

    it('does not turn inserted time into lateness for the following planned task', () => {
      const driver = new RunDriver(simpleTimetable, START)
        .startUnplanned('Phone call', at('2026-03-02T00:10:00.000Z'))
        .next(at('2026-03-02T00:20:00.000Z'));
      const report = buildRunReport(simpleTimetable, driver.run, driver.events);

      expect(report.insertedObservations[0]).toMatchObject({
        actualDurationMs: minutes(10),
        segmentCount: 1,
      });
      expect(report.insertedObservations[0]?.occurrence.label).toBe('Phone call');
      expect(report.totalInsertedDurationMs).toBe(minutes(10));
      expect(observation(report, 'gym').startDeviationMs).toBeNull();
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

describe('time budget analysis', () => {
  const everydayTimetable: Timetable = {
    ...simpleTimetable,
    eligibleWeekdays: [
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
      'sunday',
    ],
  };

  const reportWithWakeDuration = (
    wakeMinutes: number,
    day: number,
    options: { skipWake?: boolean } = {},
  ): RunReport => {
    const date = String(day).padStart(2, '0');
    const start = at(`2026-03-${date}T00:30:00.000Z`);
    const driver = new RunDriver(everydayTimetable, start, `run-${date}`);
    const wakeEnd = new Date(start.getTime() + minutes(options.skipWake ? 0 : wakeMinutes));
    if (options.skipWake) driver.skip(wakeEnd);
    else driver.next(wakeEnd);
    driver
      .next(new Date(wakeEnd.getTime() + minutes(60)))
      .next(new Date(wakeEnd.getTime() + minutes(90)));
    return buildRunReport(everydayTimetable, driver.run, driver.events);
  };

  it('uses the median and nearest-rank 75th percentile', () => {
    expect(median([39, 40, 40, 40, 40, 45, 50, 55])).toBe(40);
    expect(nearestRankPercentile([39, 40, 40, 40, 40, 45, 50, 55], 0.75)).toBe(45);
  });

  it('suggests typical and roomier whole-minute budgets from measured active time', () => {
    const durations = [39, 40, 40, 40, 40, 45, 50, 55];
    const analysis = buildTimeBudgetAnalysis(
      everydayTimetable,
      durations.map((duration, index) => reportWithWakeDuration(duration, index + 2)),
    );
    const wake = analysis.items.find((item) => item.itemId === 'wake');

    expect(wake).toMatchObject({
      status: 'review-budget',
      measuredCount: 8,
      typicalDurationMs: minutes(40),
      roomierDurationMs: minutes(45),
      typicalSuggestedBudgetMs: minutes(40),
      roomierSuggestedBudgetMs: minutes(45),
      overBudgetCount: 8,
    });
  });

  it('does not let one exceptional day dominate the estimates', () => {
    const analysis = buildTimeBudgetAnalysis(
      everydayTimetable,
      [10, 10, 10, 10, 10, 10, 10, 180].map((duration, index) =>
        reportWithWakeDuration(duration, index + 2),
      ),
    );
    const wake = analysis.items.find((item) => item.itemId === 'wake');

    expect(wake?.typicalDurationMs).toBe(minutes(10));
    expect(wake?.roomierDurationMs).toBe(minutes(10));
    expect(wake?.status).toBe('no-increase');
  });

  it('requires five measurements and keeps skips out of duration estimates', () => {
    const measured = [31, 31, 31, 31].map((duration, index) =>
      reportWithWakeDuration(duration, index + 2),
    );
    const skipped = reportWithWakeDuration(0, 6, { skipWake: true });
    const wake = buildTimeBudgetAnalysis(everydayTimetable, [...measured, skipped]).items.find(
      (item) => item.itemId === 'wake',
    );

    expect(wake).toMatchObject({
      status: 'insufficient-evidence',
      measuredCount: 4,
      skipCount: 1,
      typicalDurationMs: minutes(31),
      typicalSuggestedBudgetMs: null,
      roomierSuggestedBudgetMs: null,
    });
  });

  it('treats exactly one minute over plan as actionable', () => {
    const wake = buildTimeBudgetAnalysis(
      everydayTimetable,
      [31, 31, 31, 31, 31].map((duration, index) =>
        reportWithWakeDuration(duration, index + 2),
      ),
    ).items.find((item) => item.itemId === 'wake');

    expect(wake?.status).toBe('review-budget');
    expect(wake?.typicalSuggestedBudgetMs).toBe(minutes(31));
  });

  it('keeps every timetable step when there are no reports', () => {
    const analysis = buildTimeBudgetAnalysis(everydayTimetable, []);

    expect(analysis.items).toHaveLength(simpleTimetable.items.length);
    expect(analysis.items.every((item) => item.status === 'insufficient-evidence')).toBe(true);
    expect(analysis.items.every((item) => item.measuredCount === 0)).toBe(true);
  });
});
