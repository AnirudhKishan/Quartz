/**
 * Application-level behaviour that spans several use cases.
 *
 * These exercise the services through the repository interface only, with no
 * IndexedDB in sight, which is the property the specification asks for.
 */

import { describe, expect, it } from 'vitest';

import { sequentialIdGenerator, type Clock } from '../domain/clock';
import { InMemoryRepository } from '../infrastructure/memoryRepository';
import { simpleTimetable, simpleTimetableV2 } from '../test/fixtures';
import type { Timetable } from '../domain/types';
import { createServices } from './bootstrap';

const clockFrom = (start: string) => {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    advance(minutes: number) {
      current = new Date(current.getTime() + minutes * 60_000);
    },
  } satisfies Clock & { advance(minutes: number): void };
};

/** 06:00 local in the fixture's zone, so deviations are easy to read. */
const DAY_START = '2026-03-02T00:30:00.000Z';

const runADay = async (
  services: ReturnType<typeof createServices>,
  clock: ReturnType<typeof clockFrom>,
  version: number,
  plan: readonly ('next' | 'skip')[],
  minutesPerStep: readonly number[],
) => {
  let state = await services.runs.startRun({ timetableId: 'test-plan', version });
  for (let index = 0; index < plan.length; index += 1) {
    clock.advance(minutesPerStep[index] ?? 0);
    state = await services.runs.advance(state, plan[index]!);
  }
  return state;
};

describe('published timetable definitions', () => {
  it('requires an explicit migration instead of reinterpreting existing history', async () => {
    const repository = new InMemoryRepository(sequentialIdGenerator());
    const clock = clockFrom(DAY_START);
    const services = createServices(repository, clock);

    await repository.saveTimetable(simpleTimetable);
    await runADay(services, clock, 1, ['next', 'next', 'next'], [30, 60, 30]);

    await expect(
      repository.saveTimetable({ ...simpleTimetableV2, version: 1 }),
    ).rejects.toMatchObject({ code: 'timetable-migration-required' });

    const runs = await repository.listCompletedRuns();
    const report = await services.reports.loadRunReport(runs[0]!.id);
    expect(report.observations[0]?.item.label).toBe('Wake');
    expect(report.observations[0]?.plannedDurationMs).toBe(30 * 60_000);
  });
});

describe('time budget review', () => {
  it('keeps versions separate and never credits a skip as measured time', async () => {
    const repository = new InMemoryRepository(sequentialIdGenerator());
    const clock = clockFrom(DAY_START);
    const services = createServices(repository, clock);

    await repository.saveTimetable(simpleTimetable);
    await repository.saveTimetable(simpleTimetableV2);

    // v1: Wake overruns by 15 minutes, Gym is skipped.
    await runADay(services, clock, 1, ['next', 'skip', 'next'], [45, 0, 30]);

    clock.advance(24 * 60);
    // v2: Wake is planned for 20 minutes and takes 40, so it overruns by 20.
    await runADay(services, clock, 2, ['next', 'next', 'next'], [40, 70, 40]);

    const report = await services.reports.loadTimeBudgetReview('test-plan', {
      currentVersion: 2,
    });

    expect(report.dayCount).toBe(1);
    expect(report.availableVersions).toEqual([1, 2]);
    expect(report.selectedVersion).toBe(2);
    expect(report.items.find((item) => item.itemId === 'wake')).toMatchObject({
      label: 'Wake up',
      measuredCount: 1,
      typicalDurationMs: 40 * 60_000,
    });
    const gym = report.items.find((item) => item.itemId === 'gym');
    expect(gym).toMatchObject({
      measuredCount: 1,
      skipCount: 0,
      typicalDurationMs: 70 * 60_000,
    });

    const historical = await services.reports.loadTimeBudgetReview('test-plan', {
      selectedVersion: 1,
      currentVersion: 2,
    });
    expect(historical.isCurrentVersion).toBe(false);
    expect(historical.items.find((item) => item.itemId === 'gym')).toMatchObject({
      measuredCount: 0,
      skipCount: 1,
    });
  });

  it('uses the latest run per date and only the latest 20 dates', async () => {
      const repository = new InMemoryRepository(sequentialIdGenerator());
      const clock = clockFrom(DAY_START);
      const services = createServices(repository, clock);
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
      await repository.saveTimetable(everydayTimetable);

      for (let day = 0; day < 21; day += 1) {
        await runADay(services, clock, 1, ['next', 'next', 'next'], [30, 60, 30]);
        if (day < 20) clock.advance(22 * 60);
      }
      clock.advance(1);
      await runADay(services, clock, 1, ['next', 'next', 'next'], [45, 60, 30]);

      const review = await services.reports.loadTimeBudgetReview('test-plan', {
        currentVersion: 1,
      });
      const runs = await repository.listCompletedRuns();
      const latestDate = [...runs].sort((a, b) => b.localDate.localeCompare(a.localDate))[0]!.localDate;
      const latestRun = runs
        .filter((run) => run.localDate === latestDate)
        .sort(
          (a, b) =>
            (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0),
        )[0]!;

      expect(review.dayCount).toBe(20);
      expect(review.excludedRepeatCount).toBe(1);
      expect(review.oldestLocalDate).toBe('2026-03-03');
      expect(review.newestLocalDate).toBe('2026-03-22');
      expect(review.items[0]?.evidence).toHaveLength(20);
      expect(review.items.find((item) => item.itemId === 'wake')?.evidence[0]?.runId).toBe(
        latestRun.id,
      );
  });
});

describe('an active run survives being reopened', () => {
  it('restores the same current item from storage alone', async () => {
    const repository = new InMemoryRepository(sequentialIdGenerator());
    const clock = clockFrom(DAY_START);
    const services = createServices(repository, clock);
    await repository.saveTimetable(simpleTimetable);

    let state = await services.runs.startRun({ timetableId: 'test-plan', version: 1 });
    clock.advance(30);
    state = await services.runs.advance(state, 'next');

    // A brand-new service over the same storage stands in for a fresh launch.
    const reopened = createServices(repository, clock);
    const restored = await reopened.runs.loadActiveState();

    expect(restored?.currentItem?.id).toBe('gym');
    expect(restored?.currentItemStartedAt?.toISOString()).toBe(
      state.currentItemStartedAt?.toISOString(),
    );
  });

  describe('whole-day skip reporting', () => {
    it('retains the run while excluding it from every report entry point', async () => {
      const repository = new InMemoryRepository(sequentialIdGenerator());
      const clock = clockFrom(DAY_START);
      const services = createServices(repository, clock);
      await repository.saveTimetable(simpleTimetable);

      const state = await services.runs.startRun({ timetableId: 'test-plan', version: 1 });
      clock.advance(20);
      await services.runs.skipDay(simpleTimetable.timezone, state);

      expect((await repository.getRun(state.run.id))?.status).toBe('skipped');
      expect(await services.reports.listCompletedRuns()).toEqual([]);
      expect(await services.reports.listMeasuredTimetables()).toEqual([]);
      await expect(services.reports.loadRunReport(state.run.id)).rejects.toThrow(
        /excluded from analysis/,
      );
    });
  });
});
