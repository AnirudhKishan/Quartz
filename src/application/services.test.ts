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

describe('a run stays tied to the timetable version it was measured against', () => {
  it('reports an old run against its own version after a newer one is bundled', async () => {
    const repository = new InMemoryRepository(sequentialIdGenerator());
    const clock = clockFrom(DAY_START);
    const services = createServices(repository, clock);

    await repository.saveTimetable(simpleTimetable);
    await runADay(services, clock, 1, ['next', 'next', 'next'], [30, 60, 30]);

    // A later version changes the plan; the completed run must not move with it.
    await repository.saveTimetable(simpleTimetableV2);

    const runs = await repository.listCompletedRuns();
    const report = await services.reports.loadRunReport(runs[0]!.id);

    expect(report.run.timetableVersion).toBe(1);
    expect(report.timetable.version).toBe(1);
    expect(report.observations[0]?.item.label).toBe('Wake');
    expect(report.observations[0]?.plannedDurationMs).toBe(30 * 60_000);
    // Every step matched its v1 plan exactly.
    expect(report.totalPositiveDurationDeviationMs).toBe(0);
  });
});

describe('aggregate reporting', () => {
  it('groups by stable item ID across versions and never credits a skip as time saved', async () => {
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

    const report = await services.reports.loadAggregateReport('test-plan');

    expect(report.runCount).toBe(2);
    expect(report.versions).toEqual([1, 2]);
    // The newest version's wording wins the label.
    expect(report.items[0]).toMatchObject({ itemId: 'wake', label: 'Wake up' });
    expect(report.items[0]?.observations).toBe(2);
    expect(report.items[0]?.totalPositiveDurationDeviationMs).toBe(35 * 60_000);

    const gym = report.items.find((item) => item.itemId === 'gym');
    expect(gym?.skipCount).toBe(1);
    expect(gym?.skipRate).toBe(0.5);
    // Gym was skipped once and ran to plan once, so it saved nothing.
    expect(gym?.totalPositiveDurationDeviationMs).toBe(0);
    expect(gym?.medianDurationDeviationMs).toBe(0);
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
