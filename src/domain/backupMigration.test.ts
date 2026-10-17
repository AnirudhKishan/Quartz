import { describe, expect, it } from 'vitest';

import { createBackupDocument, parseBackupDocument } from './backup';
import { migrateQuartzBackup } from './backupMigration';
import { reconstructRunState } from './runState';
import { parseTimetable } from './timetable';
import type { Timetable } from './types';
import { loadBundledTimetables } from '../infrastructure/timetableAssets';
import { RunDriver } from '../test/runDriver';

const oldGym = parseTimetable({
  id: 'weekday-gym',
  name: 'Gym weekday',
  version: 1,
  timezone: 'Asia/Kolkata',
  eligibleWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  items: [
    ['wake-and-prepare', '05:30', '05:45'],
    ['gym', '05:45', '07:00'],
    ['morning-chores', '07:00', '07:30'],
    ['shower-get-ready', '07:30', '08:30'],
    ['morning-pooja', '08:30', '08:45'],
    ['breakfast', '08:45', '09:15'],
    ['commute-to-work', '09:15', '10:15'],
    ['work-morning', '10:15', '13:00'],
    ['lunch', '13:00', '13:45'],
    ['work-afternoon', '13:45', '17:30'],
    ['commute-home', '17:30', '18:45'],
    ['decompress', '18:45', '19:00'],
    ['evening-pooja', '19:00', '19:15'],
    ['free-time', '19:15', '20:00'],
    ['dinner', '20:00', '20:45'],
    ['dishwasher', '20:45', '21:00'],
    ['brush', '21:00', '21:15'],
    ['wind-down', '21:15', '21:30'],
    ['sleep', '21:30', '05:30'],
  ].map(([id, plannedStart, plannedEnd]) => ({
    id,
    label: id,
    plannedStart,
    plannedEnd,
  })),
});

const oldNoGym = parseTimetable({
  id: 'weekday-no-gym',
  name: 'No-gym weekday',
  version: 1,
  timezone: 'Asia/Kolkata',
  eligibleWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  items: [
    ['wake-and-prepare', '05:30', '05:45'],
    ['morning-pooja', '05:45', '06:00'],
    ['morning-chores', '06:00', '06:30'],
    ['shower-get-ready', '06:30', '07:30'],
    ['work-from-home', '07:30', '08:00'],
    ['breakfast', '08:00', '08:30'],
    ['commute-to-work', '08:30', '09:30'],
    ['work-morning', '09:30', '13:00'],
    ['lunch', '13:00', '13:45'],
    ['work-afternoon', '13:45', '17:30'],
    ['commute-home', '17:30', '18:45'],
    ['decompress', '18:45', '19:00'],
    ['evening-pooja', '19:00', '19:15'],
    ['free-time', '19:15', '20:00'],
    ['dinner', '20:00', '20:45'],
    ['dishwasher', '20:45', '21:00'],
    ['brush', '21:00', '21:15'],
    ['wind-down', '21:15', '21:30'],
    ['sleep', '21:30', '05:30'],
  ].map(([id, plannedStart, plannedEnd]) => ({
    id,
    label: id,
    plannedStart,
    plannedEnd,
  })),
});

const nextTime = (current: Date, minutes: number) =>
  new Date(current.getTime() + minutes * 60_000);

describe('single-version backup migration', () => {
  it('rewrites complex history without losing tracked duration', () => {
    let now = new Date('2026-03-02T00:00:00.000Z');
    const driver = new RunDriver(oldNoGym, now, 'run-migration');

    now = nextTime(now, 15);
    driver.next(now).undo(nextTime(now, 1)).next(nextTime(now, 2));

    while (driver.state.status === 'active') {
      const current = driver.state.currentActivity;
      if (!current) throw new Error('expected a running task');
      now = nextTime(now, 15);
      if (current.id === 'work-from-home') {
        driver.skip(now);
      } else if (current.id === 'brush') {
        driver.pause(now);
        now = nextTime(now, 5);
        driver.resume(now);
        now = nextTime(now, 10);
        driver.next(now);
      } else {
        driver.next(now);
      }
    }

    const source = createBackupDocument(
      {
        timetables: [oldGym, oldNoGym],
        runs: [driver.run],
        events: driver.events,
      },
      new Date('2026-03-03T00:00:00.000Z'),
    );
    const result = migrateQuartzBackup(
      source,
      loadBundledTimetables(),
      new Date('2026-03-04T00:00:00.000Z'),
    );
    const migrated = parseBackupDocument(result.document);
    const run = migrated.runs[0]!;
    const timetable = migrated.timetables.find(
      (candidate) => candidate.id === 'weekday-no-gym',
    ) as Timetable;
    const events = migrated.events.filter((event) => event.runId === run.id);
    const state = reconstructRunState(timetable, run, events);

    expect(migrated.timetables.map((entry) => entry.version)).toEqual([1, 1]);
    expect(events.some((event) => event.type === 'undo')).toBe(false);
    expect(state.orderedItems.map((item) => item.id)).toContain('meditation');
    expect(state.orderedItems.map((item) => item.id)).not.toContain('work-from-home');
    expect(state.orderedItems.map((item) => item.id)).not.toContain('wind-down');
    expect(state.skippedOccurrenceIds).toContain('meditation');
    expect(
      state.occurrences.find((occurrence) => occurrence.label === 'Work from home'),
    ).toMatchObject({ kind: 'inserted', insertedOrigin: 'unplanned' });
    expect(
      state.segments.filter(
        (segment) => segment.occurrenceId === 'night-routine-and-wind-down',
      ),
    ).toHaveLength(2);
    expect(result.audit).toMatchObject({
      droppedUndoEvents: 1,
      insertedMeditationSkips: 1,
      convertedWorkFromHomeOccurrences: 1,
      mergedBedtimeBoundaries: 1,
    });
    expect(result.audit.trackedDurationAfterMs).toBe(result.audit.trackedDurationBeforeMs);
  });
});
