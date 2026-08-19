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
  EditTimelineCommand,
  EndPausedCommand,
  PauseCommand,
  RecordGapTaskCommand,
  ReorderRunCommand,
  ResumeCommand,
  Run,
  RunEvent,
  RunState,
  StartNextCommand,
  StartUnplannedCommand,
  Timetable,
  TransitionCommand,
  TransitionKind,
} from './types';

export type RunPatch = Partial<
  Pick<Run, 'status' | 'completedAt' | 'startedAt' | 'executionOrder'>
>;

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
  const last = [...state.events]
    .reverse()
    .find((event) => event.type !== 'recorded-start' && event.type !== 'recorded-end');
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
    executionOrder: timetable.items.map((item) => item.id),
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
  kind === 'skip' ? 'skipped' : 'completed';

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

  if (state.status !== 'active' || state.phase !== 'running') {
    throw new QuartzError(
      'run-completed',
      state.status === 'completed'
        ? 'This run has already been completed.'
        : 'This run is no longer active.',
    );
  }
  const { currentActivity } = state;
  if (currentActivity === null) {
    throw new QuartzError('corrupt-history', 'The run has no current activity.');
  }

  if (command.expectedItemId !== currentActivity.id || command.expectedSeq !== state.lastSeq) {
    throw new QuartzError(
      'stale-state',
      'The run moved on before this action was applied.',
      [
        `Expected to advance "${command.expectedItemId}" at position ${command.expectedSeq}, ` +
          `but the run is on "${currentActivity.id}" at position ${state.lastSeq}.`,
      ],
    );
  }
  if (command.kind === 'skip' && currentActivity.kind !== 'planned') {
    throw new QuartzError('invalid-transition-time', 'An inserted task cannot be skipped.');
  }

  const occurredAt = monotonic(command.occurredAt, state);
  const nextItem = state.nextItem;
  const completesRun = nextItem === null;

  const terminalSeq = state.lastSeq + 1;
  const terminalId = eventId(run.id, terminalSeq);
  const newEvents: RunEvent[] = [
    {
      id: terminalId,
      runId: run.id,
      itemId: currentActivity.id,
      type: terminalTypeFor(command.kind),
      occurredAt,
      reversesEventId: null,
      transitionId: terminalId,
      seq: terminalSeq,
    },
  ];

  if (nextItem && command.kind !== 'finish') {
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
    runPatch: completesRun ? { status: 'completed', completedAt: occurredAt } : null,
    state,
  };
};

export const planStartNext = (
    timetable: Timetable,
    run: Run,
    events: readonly RunEvent[],
    command: StartNextCommand,
  ): PlannedWrite => {
    const state = reconstructRunState(timetable, run, events);
    if (
      state.status !== 'active' ||
      state.phase !== 'between' ||
      !state.nextItem ||
      command.itemId !== state.nextItem.id ||
      command.expectedSeq !== state.lastSeq
    ) {
      throw new QuartzError('stale-state', 'The next task changed before it could be started.');
    }
    const seq = state.lastSeq + 1;
    const id = eventId(run.id, seq);
    return {
      events: [
        {
          id,
          runId: run.id,
          itemId: state.nextItem.id,
          type: 'started',
          occurredAt: monotonic(command.occurredAt, state),
          reversesEventId: null,
          transitionId: id,
          seq,
        },
      ],
      runPatch: null,
      state,
    };
  };

const insertedOccurrenceId = (runId: string, startSeq: number): string =>
  `${eventId(runId, startSeq)}:occurrence`;

export const planStartUnplanned = (
  timetable: Timetable,
  run: Run,
  events: readonly RunEvent[],
  command: StartUnplannedCommand,
): PlannedWrite => {
  const state = reconstructRunState(timetable, run, events);
  const current = state.currentActivity;
  const label = command.label.trim();
  if (
    state.status !== 'active' ||
    state.phase !== 'running' ||
    current?.kind !== 'planned' ||
    current.id !== command.expectedItemId ||
    command.expectedSeq !== state.lastSeq
  ) {
    throw new QuartzError('stale-state', 'The current task changed before the new task started.');
  }
  if (label.length === 0) {
    throw new QuartzError('invalid-transition-time', 'Enter a name for the new task.');
  }

  const occurredAt = monotonic(command.occurredAt, state);
  const terminalSeq = state.lastSeq + 1;
  const transitionId = eventId(run.id, terminalSeq);
  const startSeq = terminalSeq + 1;
  const occurrenceId = insertedOccurrenceId(run.id, startSeq);
  return {
    events: [
      {
        id: transitionId,
        runId: run.id,
        itemId: current.id,
        type: 'completed',
        occurredAt,
        reversesEventId: null,
        transitionId,
        seq: terminalSeq,
      },
      {
        id: eventId(run.id, startSeq),
        runId: run.id,
        itemId: occurrenceId,
        type: 'started',
        occurredAt,
        inserted: { label, origin: 'unplanned', resumeTargetId: null },
        reversesEventId: null,
        transitionId,
        seq: startSeq,
      },
    ],
    runPatch: null,
    state,
  };
};

export const planRecordGapTask = (
  timetable: Timetable,
  run: Run,
  events: readonly RunEvent[],
  command: RecordGapTaskCommand,
): PlannedWrite => {
  const state = reconstructRunState(timetable, run, events);
  const label = command.label.trim();
  if (run.status === 'skipped' || command.expectedSeq !== state.lastSeq) {
    throw new QuartzError('stale-state', 'The timeline changed before the gap was filled.');
  }
  if (
    label.length === 0 ||
    Number.isNaN(command.startedAt.getTime()) ||
    Number.isNaN(command.endedAt.getTime()) ||
    command.startedAt.getTime() >= command.endedAt.getTime() ||
    command.endedAt.getTime() > command.observedAt.getTime()
  ) {
    throw new QuartzError('invalid-transition-time', 'The gap task is not valid.');
  }
  const gapExists = state.segments.some((segment, index) => {
    const next = state.segments[index + 1];
    return (
      segment.endedAt?.getTime() === command.startedAt.getTime() &&
      next?.startedAt.getTime() === command.endedAt.getTime()
    );
  });
  if (!gapExists) {
    throw new QuartzError('stale-state', 'That gap no longer exists.');
  }

  const startSeq = state.lastSeq + 1;
  const endSeq = state.lastSeq + 2;
  const startId = eventId(run.id, startSeq);
  const occurrenceId = insertedOccurrenceId(run.id, startSeq);
  const transitionId = `${startId}:recorded`;
  const newEvents: RunEvent[] = [
    {
      id: startId,
      runId: run.id,
      itemId: occurrenceId,
      type: 'recorded-start',
      occurredAt: command.startedAt,
      inserted: { label, origin: 'unplanned', resumeTargetId: null },
      reversesEventId: null,
      transitionId,
      seq: startSeq,
    },
    {
      id: eventId(run.id, endSeq),
      runId: run.id,
      itemId: occurrenceId,
      type: 'recorded-end',
      occurredAt: command.endedAt,
      reversesEventId: null,
      transitionId,
      seq: endSeq,
    },
  ];
  reconstructRunState(timetable, run, [...events, ...newEvents]);
  return { events: newEvents, runPatch: null, state };
};

export const planPause = (
  timetable: Timetable,
  run: Run,
  events: readonly RunEvent[],
  command: PauseCommand,
): PlannedWrite => {
  const state = reconstructRunState(timetable, run, events);
  const current = state.currentActivity;
  if (
    state.status !== 'active' ||
    state.phase !== 'running' ||
    current?.kind !== 'planned' ||
    current.id !== command.expectedItemId ||
    command.expectedSeq !== state.lastSeq
  ) {
    throw new QuartzError('stale-state', 'The current task changed before it could be paused.');
  }

  const occurredAt = monotonic(command.occurredAt, state);
  const terminalSeq = state.lastSeq + 1;
  const transitionId = eventId(run.id, terminalSeq);
  const startSeq = terminalSeq + 1;
  const occurrenceId = insertedOccurrenceId(run.id, startSeq);
  return {
    events: [
      {
        id: transitionId,
        runId: run.id,
        itemId: current.id,
        type: 'paused',
        occurredAt,
        reversesEventId: null,
        transitionId,
        seq: terminalSeq,
      },
      {
        id: eventId(run.id, startSeq),
        runId: run.id,
        itemId: occurrenceId,
        type: 'started',
        occurredAt,
        inserted: {
          label: 'Between tasks',
          origin: 'pause',
          resumeTargetId: current.id,
        },
        reversesEventId: null,
        transitionId,
        seq: startSeq,
      },
    ],
    runPatch: null,
    state,
  };
};

export const planResume = (
  timetable: Timetable,
  run: Run,
  events: readonly RunEvent[],
  command: ResumeCommand,
): PlannedWrite => {
  const state = reconstructRunState(timetable, run, events);
  const current = state.currentActivity;
  const target = state.resumeTarget;
  if (
    state.status !== 'active' ||
    state.phase !== 'paused' ||
    current?.kind !== 'inserted' ||
    !target ||
    current.id !== command.expectedItemId ||
    target.id !== command.expectedResumeTargetId ||
    command.expectedSeq !== state.lastSeq
  ) {
    throw new QuartzError('stale-state', 'The paused task changed before it could be resumed.');
  }

  const occurredAt = monotonic(command.occurredAt, state);
  const terminalSeq = state.lastSeq + 1;
  const transitionId = eventId(run.id, terminalSeq);
  const startSeq = terminalSeq + 1;
  return {
    events: [
      {
        id: transitionId,
        runId: run.id,
        itemId: current.id,
        type: 'completed',
        occurredAt,
        reversesEventId: null,
        transitionId,
        seq: terminalSeq,
      },
      {
        id: eventId(run.id, startSeq),
        runId: run.id,
        itemId: target.id,
        type: 'started',
        occurredAt,
        reversesEventId: null,
        transitionId,
        seq: startSeq,
      },
    ],
    runPatch: null,
    state,
  };
};

export const planEndPaused = (
  timetable: Timetable,
  run: Run,
  events: readonly RunEvent[],
  command: EndPausedCommand,
): PlannedWrite => {
  const state = reconstructRunState(timetable, run, events);
  const current = state.currentActivity;
  const target = state.resumeTarget;
  if (
    state.status !== 'active' ||
    state.phase !== 'paused' ||
    current?.kind !== 'inserted' ||
    !target ||
    current.id !== command.expectedItemId ||
    target.id !== command.expectedResumeTargetId ||
    command.expectedSeq !== state.lastSeq
  ) {
    throw new QuartzError('stale-state', 'The paused task changed before it could be ended.');
  }

  const seq = state.lastSeq + 1;
  const id = eventId(run.id, seq);
  return {
    events: [
      {
        id,
        runId: run.id,
        itemId: target.id,
        type: 'ended',
        occurredAt: monotonic(command.occurredAt, state),
        reversesEventId: null,
        transitionId: id,
        seq,
      },
    ],
    runPatch: null,
    state,
  };
};

export const planReorderRun = (
    timetable: Timetable,
    run: Run,
    events: readonly RunEvent[],
    command: ReorderRunCommand,
  ): PlannedWrite => {
    const state = reconstructRunState(timetable, run, events);
    const currentOrder = state.orderedItems.map((item) => item.id);
    if (
      run.status !== 'active' ||
      command.expectedSeq !== state.lastSeq ||
      command.expectedOrder.length !== currentOrder.length ||
      command.expectedOrder.some((id, index) => id !== currentOrder[index])
    ) {
      throw new QuartzError('stale-state', 'The day changed before its task order was updated.');
    }
    const targetIndex = currentOrder.indexOf(command.itemId);
    const firstUnstarted = state.nextIndex;
    if (firstUnstarted === null || targetIndex < firstUnstarted) {
      throw new QuartzError(
        'invalid-transition-time',
        'Only tasks that have not started can be reordered.',
      );
    }
    const executionOrder = [...currentOrder];
    const [target] = executionOrder.splice(targetIndex, 1);
    if (!target) {
      throw new QuartzError('invalid-transition-time', 'That task is not part of this day.');
    }
    executionOrder.splice(firstUnstarted, 0, target);
    return {
      events: [],
      runPatch: { executionOrder },
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

export const planTimelineEdit = (
  timetable: Timetable,
  run: Run,
  events: readonly RunEvent[],
  command: EditTimelineCommand,
): PlannedCorrection => {
  const state = reconstructRunState(timetable, run, events);
  if (run.status === 'skipped') {
    throw new QuartzError('invalid-transition-time', 'A skipped day cannot be edited.');
  }
  if (command.expectedSeq !== state.lastSeq) {
    throw new QuartzError('stale-state', 'The run changed before the timeline was saved.');
  }
  const effectiveById = new Map(state.effectiveEvents.map((event) => [event.id, event]));
  const requested = new Map<string, Date>();
  for (const replacement of command.replacements) {
    const current = effectiveById.get(replacement.eventId);
    if (
      requested.has(replacement.eventId) ||
      !current ||
      Number.isNaN(replacement.occurredAt.getTime()) ||
      Number.isNaN(replacement.expectedOccurredAt.getTime()) ||
      replacement.occurredAt.getTime() > command.observedAt.getTime()
    ) {
      throw new QuartzError('invalid-transition-time', 'The timeline edit is not valid.');
    }
    if (current.occurredAt.getTime() !== replacement.expectedOccurredAt.getTime()) {
      throw new QuartzError('stale-state', 'The timeline changed before it was saved.');
    }
    requested.set(replacement.eventId, replacement.occurredAt);
  }
  if (requested.size === 0) {
    throw new QuartzError('invalid-transition-time', 'No timeline changes were provided.');
  }

  const replacements = new Map(requested);
  for (const [eventId, occurredAt] of requested) {
    const current = effectiveById.get(eventId)!;
    for (const sibling of state.effectiveEvents) {
      if (
        sibling.id === current.id ||
        sibling.transitionId !== current.transitionId ||
        sibling.occurredAt.getTime() !== current.occurredAt.getTime()
      ) {
        continue;
      }
      const requestedSibling = requested.get(sibling.id);
      if (requestedSibling && requestedSibling.getTime() !== occurredAt.getTime()) {
        throw new QuartzError(
          'invalid-transition-time',
          'Both sides of a shared task boundary must use the same time.',
        );
      }
      replacements.set(sibling.id, occurredAt);
    }
  }

  const correctedEvents = events.map((event) => {
    const occurredAt = replacements.get(event.id);
    return occurredAt ? { ...event, occurredAt } : event;
  });
  const effectiveCorrected = correctedEvents.filter((event) => effectiveById.has(event.id));
  const operationalCorrected = effectiveCorrected.filter(
    (event) => event.type !== 'recorded-start' && event.type !== 'recorded-end',
  );
  const first = operationalCorrected[0];
  const last = operationalCorrected[operationalCorrected.length - 1];
  if (!first || first.type !== 'started') {
    throw new QuartzError('invalid-transition-time', 'The edited run has no valid start.');
  }
  const midnight = zonedLocalTimeToUtc(run.localDate, 0, timetable.timezone);
  if (first.occurredAt.getTime() < midnight.getTime()) {
    throw new QuartzError('invalid-transition-time', 'The day cannot start before its local date.');
  }
  const runPatch: RunPatch = {
    startedAt: first.occurredAt,
    completedAt: run.status === 'completed' ? (last?.occurredAt ?? run.completedAt) : null,
  };
  const editedRun = applyRunPatch(run, runPatch);
  try {
    reconstructRunState(timetable, editedRun, correctedEvents);
  } catch (error) {
    if (error instanceof QuartzError && error.code === 'corrupt-history') {
      throw new QuartzError(
        'invalid-transition-time',
        'These times overlap another task. Choose times in the available range.',
      );
    }
    throw error;
  }

  return {
    events: correctedEvents.filter((event) => replacements.has(event.id)),
    runPatch,
    state,
  };
};

export const applyRunPatch = (run: Run, patch: RunPatch | null): Run =>
  patch === null ? run : { ...run, ...patch };
