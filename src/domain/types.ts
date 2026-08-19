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

export type InsertedOccurrenceOrigin = 'unplanned' | 'pause';

export interface InsertedOccurrenceDefinition {
  readonly label: string;
  readonly origin: InsertedOccurrenceOrigin;
  readonly resumeTargetId: string | null;
}

export type RunEventType =
  | 'started'
  | 'completed'
  | 'skipped'
  | 'paused'
  | 'ended'
  | 'recorded-start'
  | 'recorded-end'
  | 'undo';

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
  /** Planned item ID, or the unique occurrence ID of an inserted activity. */
  readonly itemId: string;
  readonly type: RunEventType;
  readonly occurredAt: Date;
  /** Present only on the first start of an inserted occurrence. */
  readonly inserted?: InsertedOccurrenceDefinition | null;
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

export interface StartNextCommand {
  readonly runId: string;
  readonly itemId: string;
  readonly occurredAt: Date;
  readonly expectedSeq: number;
}

export interface StartUnplannedCommand {
  readonly runId: string;
  readonly label: string;
  readonly occurredAt: Date;
  readonly expectedItemId: string;
  readonly expectedSeq: number;
}

export interface RecordGapTaskCommand {
  readonly runId: string;
  readonly label: string;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly observedAt: Date;
  readonly expectedSeq: number;
}

export interface PauseCommand {
  readonly runId: string;
  readonly occurredAt: Date;
  readonly expectedItemId: string;
  readonly expectedSeq: number;
}

export interface ResumeCommand {
  readonly runId: string;
  readonly occurredAt: Date;
  readonly expectedItemId: string;
  readonly expectedResumeTargetId: string;
  readonly expectedSeq: number;
}

export interface EndPausedCommand {
  readonly runId: string;
  readonly occurredAt: Date;
  readonly expectedItemId: string;
  readonly expectedResumeTargetId: string;
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

export type RunPhase = 'running' | 'paused' | 'between' | 'completed';

export interface TrackedOccurrence {
  readonly id: string;
  readonly label: string;
  readonly kind: 'planned' | 'inserted';
  readonly plannedItemId: string | null;
  readonly insertedOrigin: InsertedOccurrenceOrigin | null;
  readonly resumeTargetId: string | null;
}

export interface ActivitySegment {
  /** The segment's started event is its stable identity. */
  readonly id: string;
  readonly occurrenceId: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly startEventId: string;
  readonly endEventId: string | null;
  readonly endType: 'completed' | 'skipped' | 'paused' | null;
}

/** Everything needed to render the active run screen. */
export interface RunState {
  readonly run: Run;
  readonly timetable: Timetable;
  readonly events: readonly RunEvent[];
  /** Events that still count, i.e. not reversed by an undo. */
  readonly effectiveEvents: readonly RunEvent[];
  readonly status: RunStatus;
  readonly phase: RunPhase;
  /** Planned and effective inserted occurrences known to this run. */
  readonly occurrences: readonly TrackedOccurrence[];
  /** Actual active intervals in chronological order. */
  readonly segments: readonly ActivitySegment[];
  readonly currentActivity: TrackedOccurrence | null;
  readonly currentActivityStartedAt: Date | null;
  readonly resumeTarget: TrackedOccurrence | null;
  readonly completedOccurrenceIds: readonly string[];
  readonly skippedOccurrenceIds: readonly string[];
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
