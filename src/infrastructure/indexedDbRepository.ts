/**
 * IndexedDB adapter.
 *
 * Every state change is a single read-write transaction that reads the run, its
 * timetable version, and its full event history, runs the pure planner, and then
 * writes. If anything is rejected the transaction aborts and storage is left
 * exactly as it was. Event IDs are the primary key, so even a duplicated write
 * is refused by the store itself.
 */

import type { TimetableRepository } from '../application/repository';
import type { BackupData } from '../domain/backup';
import { systemIdGenerator, type IdGenerator } from '../domain/clock';
import { QuartzError } from '../domain/errors';
import { getLocalDate } from '../domain/time';
import { toSummary } from '../domain/timetable';
import {
  applyRunPatch,
  planEndPaused,
  planPause,
  planRecordGapTask,
  planReorderRun,
  planResume,
  planStartNext,
  planStartUnplanned,
  planTimelineEdit,
  planStartRun,
  planTransition,
  planUndo,
  type PlannedWrite,
} from '../domain/transitions';
import type {
  DayDecision,
  EditTimelineCommand,
  EndPausedCommand,
  PauseCommand,
  RecordGapTaskCommand,
  ReorderRunCommand,
  ResumeCommand,
  Run,
  RunEvent,
  SkipDayCommand,
  StartNextCommand,
  StartUnplannedCommand,
  Timetable,
  TimetableRef,
  TimetableSummary,
  TransitionCommand,
} from '../domain/types';

export const DB_NAME = 'quartz';
export const DB_VERSION = 3;

const TIMETABLES = 'timetables';
const RUNS = 'runs';
const EVENTS = 'events';
const DAY_DECISIONS = 'dayDecisions';

const storageError = (cause?: unknown): QuartzError =>
  new QuartzError(
    'storage-unavailable',
    'Quartz cannot reach the browser database on this device.',
    cause instanceof Error ? [cause.message] : [],
  );

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(storageError(req.error));
  });

const asRun = (raw: unknown): Run | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  return {
    id: String(record.id),
    timetableId: String(record.timetableId),
    timetableVersion: Number(record.timetableVersion),
    localDate: String(record.localDate),
    startedAt: new Date(record.startedAt as string | number | Date),
    completedAt:
      record.completedAt === null || record.completedAt === undefined
        ? null
        : new Date(record.completedAt as string | number | Date),
    status:
      record.status === 'completed'
        ? 'completed'
        : record.status === 'skipped'
          ? 'skipped'
          : 'active',
    executionOrder: Array.isArray(record.executionOrder)
      ? record.executionOrder.map(String)
      : null,
  };
};

const asDayDecision = (raw: unknown): DayDecision | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  return {
    timezone: String(record.timezone),
    localDate: String(record.localDate),
    status: 'skipped',
    occurredAt: new Date(record.occurredAt as string | number | Date),
  };
};

const asEvent = (raw: unknown): RunEvent => {
  const record = raw as Record<string, unknown>;
  const insertedRecord =
    record.inserted && typeof record.inserted === 'object'
      ? (record.inserted as Record<string, unknown>)
      : null;
  return {
    id: String(record.id),
    runId: String(record.runId),
    itemId: String(record.itemId),
    type: record.type as RunEvent['type'],
    occurredAt: new Date(record.occurredAt as string | number | Date),
    inserted: insertedRecord
      ? {
          label: String(insertedRecord.label),
          origin: insertedRecord.origin === 'pause' ? 'pause' : 'unplanned',
          resumeTargetId:
            insertedRecord.resumeTargetId === null ||
            insertedRecord.resumeTargetId === undefined
              ? null
              : String(insertedRecord.resumeTargetId),
        }
      : null,
    reversesEventId: (record.reversesEventId ?? null) as string | null,
    transitionId: String(record.transitionId),
    seq: Number(record.seq),
  };
};

export class IndexedDbRepository implements TimetableRepository {
  private db: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly databaseName: string = DB_NAME,
    private readonly ids: IdGenerator = systemIdGenerator,
    private readonly factory: IDBFactory | null = typeof indexedDB === 'undefined'
      ? null
      : indexedDB,
  ) {}

  /** Opening early lets the app report a storage failure before offering actions. */
  async open(): Promise<void> {
    await this.database();
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.opening = null;
  }

  private database(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    if (this.opening) return this.opening;
    const factory = this.factory;
    if (!factory) return Promise.reject(storageError());

    this.opening = new Promise<IDBDatabase>((resolve, reject) => {
      let openRequest: IDBOpenDBRequest;
      try {
        openRequest = factory.open(this.databaseName, DB_VERSION);
      } catch (error) {
        reject(storageError(error));
        return;
      }

      openRequest.onupgradeneeded = () => {
        const db = openRequest.result;
        for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
        db.createObjectStore(TIMETABLES, { keyPath: ['id', 'version'] });
        const runs = db.createObjectStore(RUNS, { keyPath: 'id' });
        runs.createIndex('status', 'status', { unique: false });
        runs.createIndex('startedAt', 'startedAt', { unique: false });
        const events = db.createObjectStore(EVENTS, { keyPath: 'id' });
        events.createIndex('runId', 'runId', { unique: false });
        db.createObjectStore(DAY_DECISIONS, { keyPath: ['timezone', 'localDate'] });
      };
      openRequest.onsuccess = () => {
        const db = openRequest.result;
        db.onversionchange = () => this.close();
        this.db = db;
        resolve(db);
      };
      openRequest.onerror = () => reject(storageError(openRequest.error));
      openRequest.onblocked = () => reject(storageError(new Error('Database upgrade is blocked.')));
    }).catch((error) => {
      this.opening = null;
      throw error;
    });

    return this.opening;
  }

  private async readTransaction<T>(
    stores: string[],
    run: (tx: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    const db = await this.database();
    const tx = db.transaction(stores, 'readonly');
    return run(tx);
  }

  async listTimetables(): Promise<TimetableSummary[]> {
    const rows = await this.readTransaction([TIMETABLES], (tx) =>
      request(tx.objectStore(TIMETABLES).getAll()),
    );
    return (rows as Timetable[])
      .map(toSummary)
      .sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version);
  }

  async getTimetable(id: string, version: number): Promise<Timetable> {
    const row = await this.readTransaction([TIMETABLES], (tx) =>
      request(tx.objectStore(TIMETABLES).get([id, version])),
    );
    if (!row) throw new QuartzError('not-found', `Timetable ${id}@${version} is not available.`);
    return row as Timetable;
  }

  async saveTimetable(timetable: Timetable): Promise<void> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([TIMETABLES], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(storageError(tx.error));
      tx.onerror = () => reject(storageError(tx.error));
      tx.objectStore(TIMETABLES).put(timetable);
    });
  }

  async createRun(ref: TimetableRef, occurredAt: Date): Promise<Run> {
    const db = await this.database();
    return new Promise<Run>((resolve, reject) => {
      const tx = db.transaction([TIMETABLES, RUNS, EVENTS, DAY_DECISIONS], 'readwrite');
      let failure: unknown = null;
      let created: Run | null = null;

      tx.oncomplete = () => {
        if (created) resolve(created);
        else reject(failure ?? storageError());
      };
      tx.onabort = () => reject(failure ?? storageError(tx.error));
      tx.onerror = () => reject(failure ?? storageError(tx.error));

      const runStore = tx.objectStore(RUNS);
      const activeRequest = runStore.index('status').get('active');
      activeRequest.onsuccess = () => {
        if (activeRequest.result) {
          failure = new QuartzError(
            'run-already-active',
            'A day is already in progress. Finish or undo it before starting another.',
          );
          tx.abort();
          return;
        }

        const timetableRequest = tx
          .objectStore(TIMETABLES)
          .get([ref.timetableId, ref.version]);
        timetableRequest.onsuccess = () => {
          const timetable = timetableRequest.result as Timetable | undefined;
          if (!timetable) {
            failure = new QuartzError(
              'not-found',
              `Timetable ${ref.timetableId}@${ref.version} is not available.`,
            );
            tx.abort();
            return;
          }
          const localDate = getLocalDate(occurredAt, timetable.timezone);
          const decisionRequest = tx
            .objectStore(DAY_DECISIONS)
            .get([timetable.timezone, localDate]);
          decisionRequest.onsuccess = () => {
            if (decisionRequest.result) {
              failure = new QuartzError(
                'day-skipped',
                'Tracking has been skipped for this day.',
              );
              tx.abort();
              return;
            }
            const runsRequest = runStore.getAll();
            runsRequest.onsuccess = () => {
              const timetablesRequest = tx.objectStore(TIMETABLES).getAll();
              timetablesRequest.onsuccess = () => {
                const timetables = timetablesRequest.result as Timetable[];
                const skipped = (runsRequest.result as unknown[]).map(asRun).some((run) => {
                  if (run?.status !== 'skipped' || run.localDate !== localDate) return false;
                  return timetables.some(
                    (stored) =>
                      stored.id === run.timetableId &&
                      stored.version === run.timetableVersion &&
                      stored.timezone === timetable.timezone,
                  );
                });
                if (skipped) {
                  failure = new QuartzError(
                    'day-skipped',
                    'Tracking has been skipped for this day.',
                  );
                  tx.abort();
                  return;
                }
                try {
                  const runId = this.ids.newRunId(localDate);
                  const plan = planStartRun(timetable, runId, occurredAt);
                  runStore.add(plan.run);
                  const eventStore = tx.objectStore(EVENTS);
                  for (const event of plan.events) eventStore.add(event);
                  created = plan.run;
                } catch (error) {
                  failure = error;
                  tx.abort();
                }
              };
            };
          };
        };
      };
    });
  }

  async getActiveRun(): Promise<Run | null> {
    const row = await this.readTransaction([RUNS], (tx) =>
      request(tx.objectStore(RUNS).index('status').get('active')),
    );
    return asRun(row);
  }

  async getRun(runId: string): Promise<Run | null> {
    const row = await this.readTransaction([RUNS], (tx) =>
      request(tx.objectStore(RUNS).get(runId)),
    );
    return asRun(row);
  }

  async getDayDecision(timezone: string, localDate: string): Promise<DayDecision | null> {
    return this.readTransaction([DAY_DECISIONS, RUNS, TIMETABLES], async (tx) => {
      const [row, runRows, timetableRows] = await Promise.all([
        request(tx.objectStore(DAY_DECISIONS).get([timezone, localDate])),
        request(tx.objectStore(RUNS).getAll()),
        request(tx.objectStore(TIMETABLES).getAll()),
      ]);
      const stored = asDayDecision(row);
      if (stored) return stored;
      const timetables = timetableRows as Timetable[];
      const skipped = (runRows as unknown[])
        .map(asRun)
        .find((run) => {
          if (run?.status !== 'skipped' || run.localDate !== localDate) return false;
          return timetables.some(
            (timetable) =>
              timetable.id === run.timetableId &&
              timetable.version === run.timetableVersion &&
              timetable.timezone === timezone,
          );
        });
      return skipped?.completedAt
        ? {
            timezone,
            localDate,
            status: 'skipped',
            occurredAt: skipped.completedAt,
          }
        : null;
    });
  }

  async skipDay(command: SkipDayCommand): Promise<DayDecision> {
    const db = await this.database();
    const decision: DayDecision = {
      timezone: command.timezone,
      localDate: command.localDate,
      status: 'skipped',
      occurredAt: command.occurredAt,
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction([TIMETABLES, RUNS, DAY_DECISIONS], 'readwrite');
      let failure: unknown = null;
      tx.oncomplete = () => resolve(decision);
      tx.onabort = () => reject(failure ?? storageError(tx.error));
      tx.onerror = () => reject(failure ?? storageError(tx.error));

      const runStore = tx.objectStore(RUNS);
      const activeRequest = runStore.index('status').get('active');
      activeRequest.onsuccess = () => {
        const active = asRun(activeRequest.result);
        if (!active) {
          if (command.activeRunId !== null) {
            failure = new QuartzError('no-active-run', 'There is no active day to skip.');
            tx.abort();
            return;
          }
          const runsRequest = runStore.getAll();
          runsRequest.onsuccess = () => {
            const timetablesRequest = tx.objectStore(TIMETABLES).getAll();
            timetablesRequest.onsuccess = () => {
              const timetables = timetablesRequest.result as Timetable[];
              for (const run of (runsRequest.result as unknown[]).map(asRun)) {
                if (
                  run?.status !== 'completed' ||
                  run.localDate !== command.localDate ||
                  !timetables.some(
                    (timetable) =>
                      timetable.id === run.timetableId &&
                      timetable.version === run.timetableVersion &&
                      timetable.timezone === command.timezone,
                  )
                ) {
                  continue;
                }
                runStore.put({
                  ...run,
                  status: 'skipped',
                  completedAt: command.occurredAt,
                });
              }
              tx.objectStore(DAY_DECISIONS).put(decision);
            };
          };
          return;
        }
        if (command.activeRunId !== active.id) {
          failure = new QuartzError(
            'stale-state',
            'The active day changed before it could be skipped.',
          );
          tx.abort();
          return;
        }

        const timetableRequest = tx
          .objectStore(TIMETABLES)
          .get([active.timetableId, active.timetableVersion]);
        timetableRequest.onsuccess = () => {
          const timetable = timetableRequest.result as Timetable | undefined;
          if (
            !timetable ||
            timetable.timezone !== command.timezone ||
            active.localDate !== command.localDate
          ) {
            failure = new QuartzError(
              'stale-state',
              'The active run belongs to a different local day.',
            );
            tx.abort();
            return;
          }
          runStore.put({
            ...active,
            status: 'skipped',
            completedAt: command.occurredAt,
          });
          tx.objectStore(DAY_DECISIONS).put(decision);
        };
      };
    });
  }

  async completeRun(runId: string, occurredAt: Date): Promise<void> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([RUNS], 'readwrite');
      let failure: unknown = null;
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(failure ?? storageError(tx.error));
      tx.onerror = () => reject(failure ?? storageError(tx.error));

      const store = tx.objectStore(RUNS);
      const runRequest = store.get(runId);
      runRequest.onsuccess = () => {
        const run = asRun(runRequest.result);
        if (!run) {
          failure = new QuartzError('not-found', `Run ${runId} does not exist.`);
          tx.abort();
          return;
        }
        if (run.status === 'completed') return;
        store.put({ ...run, status: 'completed', completedAt: occurredAt });
      };
    });
  }

  /**
   * Shared write path for Next, Skip, and Undo.
   *
   * The planner runs synchronously inside the transaction between the last read
   * and the first write, so no other tab or tap can interleave.
   */
  private mutateRun(
    runId: string,
    plan: (timetable: Timetable, run: Run, events: RunEvent[]) => PlannedWrite,
  ): Promise<void> {
    return this.database().then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction([TIMETABLES, RUNS, EVENTS], 'readwrite');
          let failure: unknown = null;

          tx.oncomplete = () => (failure ? reject(failure) : resolve());
          tx.onabort = () => reject(failure ?? storageError(tx.error));
          tx.onerror = () => reject(failure ?? storageError(tx.error));

          const runStore = tx.objectStore(RUNS);
          const eventStore = tx.objectStore(EVENTS);

          const runRequest = runStore.get(runId);
          runRequest.onsuccess = () => {
            const run = asRun(runRequest.result);
            if (!run) {
              failure = new QuartzError('not-found', `Run ${runId} does not exist.`);
              tx.abort();
              return;
            }

            const timetableRequest = tx
              .objectStore(TIMETABLES)
              .get([run.timetableId, run.timetableVersion]);
            timetableRequest.onsuccess = () => {
              const timetable = timetableRequest.result as Timetable | undefined;
              if (!timetable) {
                failure = new QuartzError(
                  'corrupt-history',
                  `Run ${runId} was measured against ${run.timetableId}@${run.timetableVersion}, ` +
                    'which is no longer stored.',
                );
                tx.abort();
                return;
              }

              const eventsRequest = eventStore.index('runId').getAll(runId);
              eventsRequest.onsuccess = () => {
                try {
                  const events = (eventsRequest.result as unknown[])
                    .map(asEvent)
                    .sort((a, b) => a.seq - b.seq);
                  const planned = plan(timetable, run, events);
                  for (const event of planned.events) eventStore.add(event);
                  if (planned.runPatch) runStore.put(applyRunPatch(run, planned.runPatch));
                } catch (error) {
                  failure = error;
                  tx.abort();
                }
              };
            };
          };
        }),
    );
  }

  appendTransition(command: TransitionCommand): Promise<void> {
    return this.mutateRun(command.runId, (timetable, run, events) =>
      planTransition(timetable, run, events, command),
    );
  }

  startNext(command: StartNextCommand): Promise<void> {
    return this.mutateRun(command.runId, (timetable, run, events) =>
      planStartNext(timetable, run, events, command),
    );
  }

  startUnplanned(command: StartUnplannedCommand): Promise<void> {
    return this.mutateRun(command.runId, (timetable, run, events) =>
      planStartUnplanned(timetable, run, events, command),
    );
  }

  recordGapTask(command: RecordGapTaskCommand): Promise<void> {
    return this.mutateRun(command.runId, (timetable, run, events) =>
      planRecordGapTask(timetable, run, events, command),
    );
  }

  pause(command: PauseCommand): Promise<void> {
    return this.mutateRun(command.runId, (timetable, run, events) =>
      planPause(timetable, run, events, command),
    );
  }

  resume(command: ResumeCommand): Promise<void> {
    return this.mutateRun(command.runId, (timetable, run, events) =>
      planResume(timetable, run, events, command),
    );
  }

  endPaused(command: EndPausedCommand): Promise<void> {
    return this.mutateRun(command.runId, (timetable, run, events) =>
      planEndPaused(timetable, run, events, command),
    );
  }

  reorderRun(command: ReorderRunCommand): Promise<void> {
    return this.mutateRun(command.runId, (timetable, run, events) =>
      planReorderRun(timetable, run, events, command),
    );
  }

  editTimeline(command: EditTimelineCommand): Promise<void> {
    return this.database().then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction([TIMETABLES, RUNS, EVENTS], 'readwrite');
          let failure: unknown = null;
          tx.oncomplete = () => (failure ? reject(failure) : resolve());
          tx.onabort = () => reject(failure ?? storageError(tx.error));
          tx.onerror = () => reject(failure ?? storageError(tx.error));
          const runStore = tx.objectStore(RUNS);
          const eventStore = tx.objectStore(EVENTS);
          const runRequest = runStore.get(command.runId);
          runRequest.onsuccess = () => {
            const run = asRun(runRequest.result);
            if (!run) {
              failure = new QuartzError('not-found', `Run ${command.runId} does not exist.`);
              tx.abort();
              return;
            }
            const timetableRequest = tx
              .objectStore(TIMETABLES)
              .get([run.timetableId, run.timetableVersion]);
            timetableRequest.onsuccess = () => {
              const timetable = timetableRequest.result as Timetable | undefined;
              if (!timetable) {
                failure = new QuartzError(
                  'corrupt-history',
                  `Run ${run.id} references a timetable that is no longer stored.`,
                );
                tx.abort();
                return;
              }
              const eventsRequest = eventStore.index('runId').getAll(run.id);
              eventsRequest.onsuccess = () => {
                try {
                  const events = (eventsRequest.result as unknown[])
                    .map(asEvent)
                    .sort((a, b) => a.seq - b.seq);
                  const planned = planTimelineEdit(timetable, run, events, command);
                  for (const event of planned.events) eventStore.put(event);
                  if (planned.runPatch) runStore.put(applyRunPatch(run, planned.runPatch));
                } catch (error) {
                  failure = error;
                  tx.abort();
                }
              };
            };
          };
        }),
    );
  }

  undoLastTransition(runId: string, occurredAt: Date): Promise<void> {
    return this.mutateRun(runId, (timetable, run, events) =>
      planUndo(timetable, run, events, occurredAt),
    );
  }

  async getRunEvents(runId: string): Promise<RunEvent[]> {
    const rows = await this.readTransaction([EVENTS], (tx) =>
      request(tx.objectStore(EVENTS).index('runId').getAll(runId)),
    );
    return (rows as unknown[]).map(asEvent).sort((a, b) => a.seq - b.seq);
  }

  async listRuns(): Promise<Run[]> {
    const rows = await this.readTransaction([RUNS], (tx) =>
      request(tx.objectStore(RUNS).getAll()),
    );
    return (rows as unknown[])
      .map(asRun)
      .filter((run): run is Run => run !== null)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }

  async listCompletedRuns(): Promise<Run[]> {
    return (await this.listRuns()).filter((run) => run.status === 'completed');
  }

  async exportAll(): Promise<BackupData> {
    const db = await this.database();
    const tx = db.transaction([TIMETABLES, RUNS, EVENTS], 'readonly');
    const [timetables, runs, events] = await Promise.all([
      request(tx.objectStore(TIMETABLES).getAll()),
      request(tx.objectStore(RUNS).getAll()),
      request(tx.objectStore(EVENTS).getAll()),
    ]);
    return {
      timetables: timetables as Timetable[],
      runs: (runs as unknown[]).map(asRun).filter((run): run is Run => run !== null),
      events: (events as unknown[]).map(asEvent).sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  /** Replaces the whole database in one transaction, or changes nothing at all. */
  async replaceAll(data: BackupData): Promise<void> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([TIMETABLES, RUNS, EVENTS, DAY_DECISIONS], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(storageError(tx.error));
      tx.onerror = () => reject(storageError(tx.error));

      const timetables = tx.objectStore(TIMETABLES);
      const runs = tx.objectStore(RUNS);
      const events = tx.objectStore(EVENTS);
      const dayDecisions = tx.objectStore(DAY_DECISIONS);

      timetables.clear();
      runs.clear();
      events.clear();
      dayDecisions.clear();

      for (const timetable of data.timetables) timetables.put(timetable);
      for (const run of data.runs) runs.put(run);
      for (const event of data.events) events.put(event);
    });
  }

  async clearAll(): Promise<void> {
    await this.replaceAll({ timetables: [], runs: [], events: [] });
  }
}
