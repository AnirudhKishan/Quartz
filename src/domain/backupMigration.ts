import {
  createBackupDocument,
  parseBackupDocument,
  type BackupDocument,
} from './backup';
import { QuartzError } from './errors';
import { eventId, reconstructRunState } from './runState';
import { timetablesEqual } from './timetable';
import type { Run, RunEvent, Timetable } from './types';

const OLD_GYM_ORDER = [
  'wake-and-prepare',
  'gym',
  'morning-chores',
  'shower-get-ready',
  'morning-pooja',
  'breakfast',
  'commute-to-work',
  'work-morning',
  'lunch',
  'work-afternoon',
  'commute-home',
  'decompress',
  'evening-pooja',
  'free-time',
  'dinner',
  'dishwasher',
  'brush',
  'wind-down',
  'sleep',
] as const;

const OLD_NO_GYM_ORDER = [
  'wake-and-prepare',
  'morning-pooja',
  'morning-chores',
  'shower-get-ready',
  'work-from-home',
  'breakfast',
  'commute-to-work',
  'work-morning',
  'lunch',
  'work-afternoon',
  'commute-home',
  'decompress',
  'evening-pooja',
  'free-time',
  'dinner',
  'dishwasher',
  'brush',
  'wind-down',
  'sleep',
] as const;

interface DraftEvent {
  readonly sourceId: string;
  readonly groupKey: string;
  readonly runId: string;
  readonly itemId: string;
  readonly type: RunEvent['type'];
  readonly occurredAt: Date;
  readonly inserted: RunEvent['inserted'];
}

export interface BackupMigrationAudit {
  readonly sourceExportedAt: string;
  readonly migratedAt: string;
  readonly timetableCount: number;
  readonly runCount: number;
  readonly sourceEventCount: number;
  readonly migratedEventCount: number;
  readonly droppedUndoEvents: number;
  readonly renamedFlexibleTimeEvents: number;
  readonly renamedDishwasherEvents: number;
  readonly insertedMeditationSkips: number;
  readonly convertedWorkFromHomeOccurrences: number;
  readonly mergedBedtimeBoundaries: number;
  readonly trackedDurationBeforeMs: number;
  readonly trackedDurationAfterMs: number;
}

export interface BackupMigrationResult {
  readonly document: unknown;
  readonly audit: BackupMigrationAudit;
}

const fail = (message: string, details: readonly string[] = []): never => {
  throw new QuartzError('invalid-backup', message, details);
};

const expectedOrder = (id: string): readonly string[] => {
  if (id === 'weekday-gym') return OLD_GYM_ORDER;
  if (id === 'weekday-no-gym') return OLD_NO_GYM_ORDER;
  return fail(`Unsupported timetable "${id}" in the source backup.`);
};

const assertSourceTimetables = (timetables: readonly Timetable[]) => {
  if (timetables.length !== 2) {
    fail('The source backup must contain exactly the two Quartz weekday timetables.');
  }
  for (const timetable of timetables) {
    if (timetable.version !== 1) {
      fail(`Expected ${timetable.id} to use timetable version 1.`);
    }
    const actual = timetable.items.map((item) => item.id);
    const expected = expectedOrder(timetable.id);
    if (
      actual.length !== expected.length ||
      actual.some((itemId, index) => itemId !== expected[index])
    ) {
      fail(`The source timetable ${timetable.id}@1 is not the expected pre-migration shape.`);
    }
  }
};

const renameItemId = (itemId: string): string => {
  if (itemId === 'free-time') return 'flexible-time';
  if (itemId === 'dishwasher') return 'dishwasher-trash';
  if (itemId === 'brush' || itemId === 'wind-down') {
    return 'night-routine-and-wind-down';
  }
  return itemId;
};

const migrateOrder = (run: Run): string[] => {
  const source = run.executionOrder ?? expectedOrder(run.timetableId);
  const result = source
    .filter((itemId) => itemId !== 'work-from-home' && itemId !== 'wind-down')
    .map(renameItemId);
  if (run.timetableId === 'weekday-no-gym') {
    const chores = result.indexOf('morning-chores');
    if (chores < 0) fail(`Run ${run.id} omits Morning chores from its execution order.`);
    result.splice(chores, 0, 'meditation');
  }
  return result;
};

const totalTrackedMs = (timetable: Timetable, run: Run, events: readonly RunEvent[]): number =>
  reconstructRunState(timetable, run, events).segments.reduce(
    (total, segment) =>
      total + (segment.endedAt ? segment.endedAt.getTime() - segment.startedAt.getTime() : 0),
    0,
  );

const migrateRunEvents = (
  timetable: Timetable,
  run: Run,
  events: readonly RunEvent[],
  counters: {
    flexible: number;
    dishwasher: number;
    meditation: number;
    work: number;
    bedtime: number;
    undo: number;
  },
): RunEvent[] => {
  const state = reconstructRunState(timetable, run, events);
  counters.undo += events.filter((event) => event.type === 'undo').length;
  const effective = state.effectiveEvents;
  const bedtimeBoundaryGroups = new Set<string>();

  for (const transitionId of new Set(effective.map((event) => event.transitionId))) {
    const group = effective.filter((event) => event.transitionId === transitionId);
    const brushEnd = group.find(
      (event) =>
        event.itemId === 'brush' &&
        (event.type === 'completed' || event.type === 'skipped'),
    );
    const windStart = group.find(
      (event) => event.itemId === 'wind-down' && event.type === 'started',
    );
    if (!brushEnd && !windStart) continue;
    if (
      !brushEnd ||
      !windStart ||
      brushEnd.type !== 'completed' ||
      brushEnd.occurredAt.getTime() !== windStart.occurredAt.getTime()
    ) {
      fail(`Run ${run.id} has a bedtime boundary that cannot be merged safely.`);
    }
    bedtimeBoundaryGroups.add(transitionId);
    counters.bedtime += 1;
  }

  const workOccurrenceId = `migration:${run.id}:work-from-home`;
  const initialChoresStartId = state.segments.find(
    (segment) => segment.occurrenceId === 'morning-chores',
  )?.startEventId;
  let sawWorkStart = false;
  const drafts: DraftEvent[] = [];

  for (const event of effective) {
    if (event.type === 'undo') continue;
    if (
      bedtimeBoundaryGroups.has(event.transitionId) &&
      ((event.itemId === 'brush' &&
        (event.type === 'completed' || event.type === 'skipped')) ||
        (event.itemId === 'wind-down' && event.type === 'started'))
    ) {
      continue;
    }

    let itemId = event.itemId;
    let type = event.type;
    let inserted = event.inserted
      ? {
          ...event.inserted,
          resumeTargetId:
            event.inserted.resumeTargetId === null
              ? null
              : renameItemId(event.inserted.resumeTargetId),
        }
      : null;

    if (itemId === 'free-time') {
      itemId = 'flexible-time';
      counters.flexible += 1;
    } else if (itemId === 'dishwasher') {
      itemId = 'dishwasher-trash';
      counters.dishwasher += 1;
    } else if (itemId === 'brush' || itemId === 'wind-down') {
      itemId = 'night-routine-and-wind-down';
    } else if (itemId === 'work-from-home') {
      if (type === 'paused' || type === 'ended') {
        fail(`Run ${run.id} pauses Work from home, which this migration does not support.`);
      }
      itemId = workOccurrenceId;
      if (type === 'started') {
        if (sawWorkStart) fail(`Run ${run.id} starts Work from home more than once.`);
        sawWorkStart = true;
        counters.work += 1;
        inserted = { label: 'Work from home', origin: 'unplanned', resumeTargetId: null };
      } else if (type === 'skipped') {
        type = 'completed';
      }
    }

    if (
      run.timetableId === 'weekday-no-gym' &&
      itemId === 'morning-chores' &&
      type === 'started' &&
      event.id === initialChoresStartId &&
      inserted === null
    ) {
      drafts.push({
        sourceId: event.id,
        groupKey: event.transitionId,
        runId: event.runId,
        itemId: 'meditation',
        type: 'started',
        occurredAt: event.occurredAt,
        inserted: null,
      });
      const groupKey = `migration:${run.id}:meditation:${event.id}`;
      drafts.push(
        {
          sourceId: `${groupKey}:skip`,
          groupKey,
          runId: event.runId,
          itemId: 'meditation',
          type: 'skipped',
          occurredAt: event.occurredAt,
          inserted: null,
        },
        {
          sourceId: `${groupKey}:chores`,
          groupKey,
          runId: event.runId,
          itemId: 'morning-chores',
          type: 'started',
          occurredAt: event.occurredAt,
          inserted: null,
        },
      );
      counters.meditation += 1;
      continue;
    }

    drafts.push({
      sourceId: event.id,
      groupKey: event.transitionId,
      runId: event.runId,
      itemId,
      type,
      occurredAt: event.occurredAt,
      inserted,
    });
  }

  const firstIdByGroup = new Map<string, string>();
  drafts.forEach((draft, index) => {
    if (!firstIdByGroup.has(draft.groupKey)) {
      firstIdByGroup.set(draft.groupKey, eventId(run.id, index + 1));
    }
  });

  return drafts.map((draft, index) => {
    const id = eventId(run.id, index + 1);
    const groupId = firstIdByGroup.get(draft.groupKey);
    const transitionId =
      groupId ?? fail(`Run ${run.id} lost transition ${draft.groupKey}.`);
    const recorded = draft.type === 'recorded-start' || draft.type === 'recorded-end';
    return {
      id,
      runId: draft.runId,
      itemId: draft.itemId,
      type: draft.type,
      occurredAt: draft.occurredAt,
      inserted: draft.inserted ?? null,
      reversesEventId: null,
      transitionId: recorded ? `${transitionId}:recorded` : transitionId,
      seq: index + 1,
    };
  });
};

export const migrateQuartzBackup = (
  raw: unknown,
  targetTimetables: readonly Timetable[],
  migratedAt: Date,
): BackupMigrationResult => {
  const sourceDocument = raw as Partial<BackupDocument>;
  const source = parseBackupDocument(raw);
  assertSourceTimetables(source.timetables);
  if (source.runs.some((run) => run.status === 'active')) {
    fail('The source backup contains an active day. Finish or skip it before migration.');
  }
  if (
    targetTimetables.length !== 2 ||
    targetTimetables.some((timetable) => timetable.version !== 1)
  ) {
    fail('The migration target must contain exactly two version-1 timetables.');
  }

  const sourceTimetables = new Map(source.timetables.map((timetable) => [timetable.id, timetable]));
  const targetById = new Map(targetTimetables.map((timetable) => [timetable.id, timetable]));
  const counters = {
    flexible: 0,
    dishwasher: 0,
    meditation: 0,
    work: 0,
    bedtime: 0,
    undo: 0,
  };
  let trackedDurationBeforeMs = 0;
  let trackedDurationAfterMs = 0;
  const migratedRuns: Run[] = [];
  const migratedEvents: RunEvent[] = [];

  for (const run of source.runs) {
    const sourceTimetable = sourceTimetables.get(run.timetableId);
    const targetTimetable = targetById.get(run.timetableId);
    if (!sourceTimetable || !targetTimetable) {
      fail(`Run ${run.id} references an unsupported timetable.`);
    }
    const checkedSourceTimetable = sourceTimetable as Timetable;
    const checkedTargetTimetable = targetTimetable as Timetable;
    const runEvents = source.events.filter((event) => event.runId === run.id);
    trackedDurationBeforeMs += totalTrackedMs(checkedSourceTimetable, run, runEvents);
    const nextRun: Run = { ...run, executionOrder: migrateOrder(run) };
    const nextEvents = migrateRunEvents(checkedSourceTimetable, run, runEvents, counters);
    reconstructRunState(checkedTargetTimetable, nextRun, nextEvents);
    trackedDurationAfterMs += totalTrackedMs(checkedTargetTimetable, nextRun, nextEvents);
    migratedRuns.push(nextRun);
    migratedEvents.push(...nextEvents);
  }

  if (trackedDurationBeforeMs !== trackedDurationAfterMs) {
    fail('The migration changed total tracked duration.', [
      `Before: ${trackedDurationBeforeMs} ms`,
      `After: ${trackedDurationAfterMs} ms`,
    ]);
  }

  const data = {
    timetables: [...targetTimetables],
    runs: migratedRuns,
    events: migratedEvents,
  };
  const document = createBackupDocument(data, migratedAt);
  parseBackupDocument(document);

  for (const timetable of targetTimetables) {
    const parsed = parseBackupDocument(document).timetables.find(
      (candidate) => candidate.id === timetable.id,
    );
    if (!parsed || !timetablesEqual(parsed, timetable)) {
      fail(`The migrated backup did not retain target timetable ${timetable.id}.`);
    }
  }

  return {
    document,
    audit: {
      sourceExportedAt: String(sourceDocument.exportedAt ?? ''),
      migratedAt: migratedAt.toISOString(),
      timetableCount: targetTimetables.length,
      runCount: migratedRuns.length,
      sourceEventCount: source.events.length,
      migratedEventCount: migratedEvents.length,
      droppedUndoEvents: counters.undo,
      renamedFlexibleTimeEvents: counters.flexible,
      renamedDishwasherEvents: counters.dishwasher,
      insertedMeditationSkips: counters.meditation,
      convertedWorkFromHomeOccurrences: counters.work,
      mergedBedtimeBoundaries: counters.bedtime,
      trackedDurationBeforeMs,
      trackedDurationAfterMs,
    },
  };
};
