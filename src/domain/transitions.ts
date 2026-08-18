/**
 * Pure planners for the three run commands.
 *
 * Each planner turns "the world as stored" plus one authoritative timestamp into
 * the exact records that must be written. Storage adapters run these inside a
 * single transaction, so a transition is all-or-nothing and a repeated tap is
 * rejected by the precondition rather than duplicated.
 */

import { QuartzError } from './errors';
import { eventId, findUndoTarget, reconstructRunState } from './runState';
import { getLocalDate, zonedLocalTimeToUtc } from './time';
import { isTimetableEligible } from './timetable';
import type {
  CorrectTransitionTimeCommand,
  Run,
  RunEvent,
  RunState,
  Timetable,
  TransitionCommand,
  TransitionKind,
} from './types';

export interface RunPatch {
  readonly status: Run['status'];
  readonly completedAt: Date | null;
  readonly startedAt?: Date;
}

export interface PlannedWrite {
  readonly events: readonly RunEvent[];
  /** Present only when the command changes the run itself. */
  readonly runPatch: RunPatch | null;
  readonly state: RunState;
}

export interface PlannedCorrection {
  readonly events: readonly RunEvent[];
  readonly runPatch: RunPatch | null;
  readonly state: RunState;
}

/**
 * Clocks can move backwards (manual change, NTP correction). Clamping keeps the
 * stored history monotonic so it can never describe a negative duration.
 */
const monotonic = (occurredAt: Date, state: RunState): Date => {
  const last = state.events[state.events.length - 1];
  if (!last) return occurredAt;
  return occurredAt.getTime() < last.occurredAt.getTime() ? last.occurredAt : occurredAt;
};

export interface StartRunPlan {
  readonly run: Run;
  readonly events: readonly RunEvent[];
}

/** Starting a run records the plan reference and the actual start of item one. */
export const planStartRun = (
  timetable: Timetable,
  runId: string,
  occurredAt: Date,
): StartRunPlan => {
  if (!isTimetableEligible(timetable, occurredAt)) {
    throw new QuartzError('ineligible-day', `${timetable.name} is not available on this day.`);
  }
  const firstItem = timetable.items[0];
  if (!firstItem) {
    throw new QuartzError('invalid-timetable', `Timetable ${timetable.id} has no items`);
  }

  const localDate = getLocalDate(occurredAt, timetable.timezone);
  const run: Run = {
    id: runId,
    timetableId: timetable.id,
    timetableVersion: timetable.version,
    localDate,
    startedAt: occurredAt,
    completedAt: null,
    status: 'active',
  };

  const id = eventId(runId, 1);
  return {
    run,
    events: [
      {
        id,
        runId,
        itemId: firstItem.id,
        type: 'started',
        occurredAt,
        reversesEventId: null,
        transitionId: id,
        seq: 1,
      },
    ],
  };
};

const terminalTypeFor = (kind: TransitionKind): RunEvent['type'] =>
  kind === 'next' ? 'completed' : 'skipped';

const isTerminalEvent = (event: RunEvent): boolean =>
  event.type === 'completed' || event.type === 'skipped';

/**
 * Plan a Next or Skip.
 *
 * Both record the outcome of the current item and the start of the next item
 * using the same timestamp. On the final item the run is completed instead.
 */
export const planTransition = (
  timetable: Timetable,
  run: Run,
  events: readonly RunEvent[],
  command: TransitionCommand,
): PlannedWrite => {
  const state = reconstructRunState(timetable, run, events);

  if (state.status !== 'active') {
    throw new QuartzError(
      'run-completed',
      state.status === 'completed'
        ? 'This run has already been completed.'
        : 'This run is no longer active.',
    );
  }
  const { currentItem, currentIndex } = state;
  if (currentItem === null || currentIndex === null) {
    throw new QuartzError('corrupt-history', 'The run has no current item.');
  }

  if (command.expectedItemId !== currentItem.id || command.expectedSeq !== state.lastSeq) {
    throw new QuartzError(
      'stale-state',
      'The run moved on before this action was applied.',
      [
        `Expected to advance "${command.expectedItemId}" at position ${command.expectedSeq}, ` +
          `but the run is on "${currentItem.id}" at position ${state.lastSeq}.`,
      ],
    );
  }

  const occurredAt = monotonic(command.occurredAt, state);
  const isFinalItem = currentIndex === timetable.items.length - 1;

  const terminalSeq = state.lastSeq + 1;
  const terminalId = eventId(run.id, terminalSeq);
  const newEvents: RunEvent[] = [
    {
      id: terminalId,
      runId: run.id,
      itemId: currentItem.id,
      type: terminalTypeFor(command.kind),
      occurredAt,
      reversesEventId: null,
      transitionId: terminalId,
      seq: terminalSeq,
    },
  ];

  if (!isFinalItem) {
    const nextItem = timetable.items[currentIndex + 1];
    if (!nextItem) {
      throw new QuartzError('corrupt-history', 'The timetable is missing the next item.');
    }
    const startSeq = terminalSeq + 1;
    newEvents.push({
      id: eventId(run.id, startSeq),
      runId: run.id,
      itemId: nextItem.id,
      type: 'started',
      occurredAt,
      reversesEventId: null,
      transitionId: terminalId,
      seq: startSeq,
    });
  }

  return {
    events: newEvents,
    runPatch: isFinalItem ? { status: 'completed', completedAt: occurredAt } : null,
    state,
  };
};

/**
 * Plan an undo of the most recent Next or Skip.
 *
 * Nothing is deleted or rewritten: an `undo` event is appended that reverses the
 * whole transition, which restores the preceding item — and its original start
 * timestamp — as current.
 */
export const planUndo = (
  timetable: Timetable,
  run: Run,
  events: readonly RunEvent[],
  occurredAt: Date,
): PlannedWrite => {
  const state = reconstructRunState(timetable, run, events);
  const target = findUndoTarget(state);

  if (!target) {
    throw new QuartzError('nothing-to-undo', 'There is no Next or Skip left to undo.');
  }

  const seq = state.lastSeq + 1;
  const id = eventId(run.id, seq);
  const undoEvent: RunEvent = {
    id,
    runId: run.id,
    itemId: target.itemId,
    type: 'undo',
    occurredAt: monotonic(occurredAt, state),
    reversesEventId: target.id,
    transitionId: id,
    seq,
  };

  return {
    events: [undoEvent],
    // Undoing the final Next or Skip reopens the run.
    runPatch: run.status === 'completed' ? { status: 'active', completedAt: null } : null,
    state,
  };
};

/**
 * Replace the timestamp of the initial start or a shared Next/Skip transition.
 *
 * Corrections intentionally rewrite the existing records. Event identity and
 * transition grouping stay unchanged, so reconstruction and Undo keep working.
 */
export const planTransitionTimeCorrection = (
  timetable: Timetable,
  run: Run,
  events: readonly RunEvent[],
  command: CorrectTransitionTimeCommand,
): PlannedCorrection => {
  const state = reconstructRunState(timetable, run, events);
  if (run.status === 'skipped') {
    throw new QuartzError('invalid-transition-time', 'A skipped day cannot be corrected.');
  }
  if (command.expectedSeq !== state.lastSeq) {
    throw new QuartzError(
      'stale-state',
      'The run changed before this time correction was applied.',
    );
  }
  if (
    Number.isNaN(command.correctedAt.getTime()) ||
    Number.isNaN(command.observedAt.getTime())
  ) {
    throw new QuartzError('invalid-transition-time', 'The corrected time is not valid.');
  }

  const targetIndex = state.effectiveEvents.findIndex(
    (event) =>
      event.id === command.transitionId &&
      event.transitionId === command.transitionId &&
      (isTerminalEvent(event) || (event.seq === 1 && event.type === 'started')),
  );
  const target = state.effectiveEvents[targetIndex];
  if (!target) {
    throw new QuartzError(
      'stale-state',
      'That changeover is no longer part of the effective run history.',
    );
  }

  const isInitialStart = target.seq === 1 && target.type === 'started';
  const previous = state.effectiveEvents[targetIndex - 1];
  const nextStarted = state.effectiveEvents[targetIndex + 1];
  const nextBoundary = isInitialStart
    ? nextStarted
    : nextStarted?.transitionId === target.transitionId
      ? state.effectiveEvents[targetIndex + 2]
      : nextStarted;
  const correctedMs = command.correctedAt.getTime();
  const minimumMs = isInitialStart
    ? zonedLocalTimeToUtc(run.localDate, 0, timetable.timezone).getTime()
    : (previous?.occurredAt.getTime() ?? run.startedAt.getTime());
  const maximumMs = Math.min(
    nextBoundary?.occurredAt.getTime() ?? command.observedAt.getTime(),
    command.observedAt.getTime(),
  );

  if (correctedMs < minimumMs || correctedMs > maximumMs) {
    const range =
      minimumMs === maximumMs
        ? `The only valid time is ${new Date(minimumMs).toISOString()}.`
        : `Choose a time from ${new Date(minimumMs).toISOString()} through ${new Date(maximumMs).toISOString()}.`;
    throw new QuartzError(
      'invalid-transition-time',
      'The corrected time must stay between the neighboring changeovers.',
      [range],
    );
  }

  const correctedEvents = state.effectiveEvents
    .filter((event) => event.transitionId === target.transitionId)
    .map((event) => ({ ...event, occurredAt: command.correctedAt }));
  const isFinal = correctedEvents.length === 1 && run.status === 'completed';

  return {
    events: correctedEvents,
    runPatch: isInitialStart
      ? {
          status: run.status,
          completedAt: run.completedAt,
          startedAt: command.correctedAt,
        }
      : isFinal
        ? { status: 'completed', completedAt: command.correctedAt }
        : null,
    state,
  };
};

export const applyRunPatch = (run: Run, patch: RunPatch | null): Run =>
  patch === null ? run : { ...run, ...patch };
