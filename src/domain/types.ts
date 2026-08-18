/**
 * Domain model for Quartz.
 *
 * The plan (timetables) and reality (runs + events) are deliberately separate.
 * Nothing here may import React or IndexedDB.
 */

/** A single planned activity inside a timetable. */
export interface TimetableItem {
  /** Stable across versions while the activity keeps the same meaning. */
  readonly id: string;
  readonly label: string;
  /** Planned local start, `HH:mm` in the timetable's timezone. */
  readonly plannedStart: string;
  /** Planned local end, `HH:mm` in the timetable's timezone. */
  readonly plannedEnd: string;
}

export type Weekday =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

/** A locally stored plan definition, replaced when the matching bundle changes. */
export interface Timetable {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  /** IANA timezone, e.g. `Asia/Kolkata`. */
  readonly timezone: string;
  readonly eligibleWeekdays: readonly Weekday[];
  readonly items: readonly TimetableItem[];
}

export interface TimetableSummary {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly timezone: string;
  readonly eligibleWeekdays: readonly Weekday[];
  readonly itemCount: number;
  readonly firstPlannedStart: string;
  readonly lastPlannedEnd: string;
}

export interface TimetableRef {
  readonly timetableId: string;
  readonly version: number;
}

export type RunStatus = 'active' | 'completed' | 'skipped';

export interface Run {
  readonly id: string;
  readonly timetableId: string;
  readonly timetableVersion: number;
  /** Intended local day, `YYYY-MM-DD` in the timetable's timezone. */
  readonly localDate: string;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly status: RunStatus;
  /** Today's execution order. Null means the timetable order for legacy runs. */
  readonly executionOrder: readonly string[] | null;
}

export interface DayDecision {
  readonly timezone: string;
  readonly localDate: string;
  readonly status: 'skipped';
  readonly occurredAt: Date;
}

export interface SkipDayCommand {
  readonly timezone: string;
  readonly localDate: string;
  readonly occurredAt: Date;
  readonly activeRunId: string | null;
}

export type RunEventType = 'started' | 'completed' | 'skipped' | 'undo';

/**
 * A record of something that actually happened.
 *
 * `transitionId` groups every event produced by a single button press. It is an
 * internal addition to the specification's event shape: it makes Undo
 * unambiguous while allowing an explicit transition-time correction.
 */
export interface RunEvent {
  /** Unique and monotonically sortable within a run. */
  readonly id: string;
  readonly runId: string;
  readonly itemId: string;
  readonly type: RunEventType;
  readonly occurredAt: Date;
  /** For `undo` events, the terminal event whose transition is reversed. */
  readonly reversesEventId: string | null;
  readonly transitionId: string;
  /** Monotonic ordering position within the run, starting at 1. */
  readonly seq: number;
}

export type TransitionKind = 'next' | 'skip' | 'finish';

/**
 * A guarded request to advance a run.
 *
 * `expectedItemId` and `expectedSeq` are optimistic-concurrency preconditions.
 * They are re-checked inside the storage transaction so a repeated tap, a stale
 * tab, or a duplicated submission cannot advance the run twice.
 */
export interface TransitionCommand {
  readonly runId: string;
  readonly kind: TransitionKind;
  readonly occurredAt: Date;
  readonly expectedItemId: string;
  readonly expectedSeq: number;
}

/** A guarded replacement for the initial start or a shared Next/Skip timestamp. */
export interface CorrectTransitionTimeCommand {
  readonly runId: string;
  /** The initial started event ID, or the terminal event ID produced by Next or Skip. */
  readonly transitionId: string;
  readonly expectedOccurredAt: Date;
  readonly correctedAt: Date;
  /** Current time when the correction is submitted; prevents future boundaries. */
  readonly observedAt: Date;
  readonly expectedSeq: number;
}

export interface StartNextCommand {
  readonly runId: string;
  readonly itemId: string;
  readonly occurredAt: Date;
  readonly expectedSeq: number;
}

export interface ReorderRunCommand {
  readonly runId: string;
  readonly itemId: string;
  readonly expectedSeq: number;
  readonly expectedOrder: readonly string[];
}

export interface TimelineEventReplacement {
  readonly eventId: string;
  readonly expectedOccurredAt: Date;
  readonly occurredAt: Date;
}

export interface EditTimelineCommand {
  readonly runId: string;
  readonly replacements: readonly TimelineEventReplacement[];
  readonly observedAt: Date;
  readonly expectedSeq: number;
}

export type RunPhase = 'running' | 'between' | 'completed';

/** Everything needed to render the active run screen. */
export interface RunState {
  readonly run: Run;
  readonly timetable: Timetable;
  readonly events: readonly RunEvent[];
  /** Events that still count, i.e. not reversed by an undo. */
  readonly effectiveEvents: readonly RunEvent[];
  readonly status: RunStatus;
  readonly phase: RunPhase;
  /** Today's ordered items, which may differ from the timetable order. */
  readonly orderedItems: readonly TimetableItem[];
  /** Index into `orderedItems`; set only while an item is running. */
  readonly currentIndex: number | null;
  readonly currentItem: TimetableItem | null;
  readonly currentItemStartedAt: Date | null;
  /** Index into `orderedItems` for the item that Next or Start will select. */
  readonly nextIndex: number | null;
  readonly nextItem: TimetableItem | null;
  readonly canUndo: boolean;
  /** Highest `seq` present, used as the transition precondition. */
  readonly lastSeq: number;
}
