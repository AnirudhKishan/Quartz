/**
 * The only storage seam in the application.
 *
 * Domain and application rules depend on this contract, never on IndexedDB. A
 * future SQLite or remote adapter can be added by implementing it again.
 */

import type { BackupData } from '../domain/backup';
import type {
  Run,
  RunEvent,
  Timetable,
  TimetableRef,
  TimetableSummary,
  TransitionCommand,
} from '../domain/types';

export interface TimetableRepository {
  listTimetables(): Promise<TimetableSummary[]>;
  getTimetable(id: string, version: number): Promise<Timetable>;
  /**
   * Store a timetable version. Rejects an attempt to change a version that a
   * run has already been measured against.
   */
  saveTimetable(timetable: Timetable): Promise<void>;

  /**
   * Create the run and record the actual start of its first item atomically.
   * Rejects when another run is already active.
   */
  createRun(ref: TimetableRef, occurredAt: Date): Promise<Run>;
  getActiveRun(): Promise<Run | null>;
  getRun(runId: string): Promise<Run | null>;
  completeRun(runId: string, occurredAt: Date): Promise<void>;

  /** Applies a guarded Next or Skip as one atomic write. */
  appendTransition(command: TransitionCommand): Promise<void>;
  undoLastTransition(runId: string, occurredAt: Date): Promise<void>;
  getRunEvents(runId: string): Promise<RunEvent[]>;
  listCompletedRuns(): Promise<Run[]>;
  listRuns(): Promise<Run[]>;

  /** Whole-database export and atomic replace, used by backup and restore. */
  exportAll(): Promise<BackupData>;
  replaceAll(data: BackupData): Promise<void>;
}
