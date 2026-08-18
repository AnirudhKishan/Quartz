/**
 * Pure reconstruction of a run from its event history.
 *
 * This reducer is the single source of truth for "what is happening now". It is
 * used by the active-run screen, by the storage adapters inside their write
 * transactions, by the report engine, and by backup validation. If a history
 * cannot produce a valid state the reducer throws instead of guessing.
 */

import { QuartzError } from './errors';
import type { Run, RunEvent, RunState, Timetable, TimetableItem } from './types';

export const eventId = (runId: string, seq: number): string =>
  `${runId}#${String(seq).padStart(8, '0')}`;

const isTerminal = (event: RunEvent): boolean =>
  event.type === 'completed' || event.type === 'skipped';

export const sortEvents = (events: readonly RunEvent[]): RunEvent[] =>
  [...events].sort((a, b) => a.seq - b.seq);

function corrupt(message: string, details: readonly string[] = []): never {
  throw new QuartzError('corrupt-history', message, details);
}

/**
 * Determine which transitions have been reversed by an undo.
 *
 * A transition's ID is the ID of its first event, and an undo always targets
 * that first (terminal) event, so `reversesEventId` is also the reversed
 * transition ID.
 */
const collectReversedTransitions = (sorted: readonly RunEvent[]): Set<string> => {
  const byId = new Map(sorted.map((event) => [event.id, event]));
  const reversed = new Set<string>();

  for (const event of sorted) {
    if (event.type !== 'undo') {
      if (event.reversesEventId !== null) {
        corrupt(`Event ${event.id} is not an undo but sets reversesEventId`);
      }
      continue;
    }
    if (event.reversesEventId === null) {
      corrupt(`Undo event ${event.id} does not reference the event it reverses`);
    }
    const target = byId.get(event.reversesEventId);
    if (!target) {
      corrupt(`Undo event ${event.id} references unknown event ${event.reversesEventId}`);
      return reversed;
    }
    const standaloneStart =
      target.type === 'started' && target.seq > 1 && target.id === target.transitionId;
    if (!isTerminal(target) && !standaloneStart) {
      corrupt(`Undo event ${event.id} must reverse a transition that can be undone`);
    }
    if (target.id !== target.transitionId) {
      corrupt(`Undo event ${event.id} must reverse the first event of a transition`);
    }
    if (reversed.has(target.transitionId)) {
      corrupt(`Transition ${target.transitionId} has already been reversed`);
    }
    reversed.add(target.transitionId);
  }

  return reversed;
};

const assertWellFormed = (run: Run, sorted: readonly RunEvent[]): void => {
  sorted.forEach((event, index) => {
    if (event.runId !== run.id) {
      corrupt(`Event ${event.id} belongs to run ${event.runId}, not ${run.id}`);
    }
    if (event.seq !== index + 1) {
      corrupt(
        `Event sequence is not contiguous: expected seq ${index + 1} but found ${event.seq}`,
        ['A gap means events were lost or reordered in storage.'],
      );
    }
    if (event.id !== eventId(run.id, event.seq)) {
      corrupt(`Event ${event.id} does not match its sequence position ${event.seq}`);
    }
    if (Number.isNaN(event.occurredAt.getTime())) {
      corrupt(`Event ${event.id} has an invalid timestamp`);
    }
  });
};

export const resolveExecutionOrder = (
  timetable: Timetable,
  run: Run,
): readonly TimetableItem[] => {
  const originalIds = timetable.items.map((item) => item.id);
  const order = run.executionOrder ?? originalIds;
  if (
    order.length !== originalIds.length ||
    new Set(order).size !== order.length ||
    order.some((id) => !originalIds.includes(id))
  ) {
    corrupt(`Run ${run.id} has an invalid execution order`);
  }
  const byId = new Map(timetable.items.map((item) => [item.id, item]));
  return order.map((id) => {
    const item = byId.get(id);
    if (!item) corrupt(`Run ${run.id} references unknown item "${id}" in its execution order`);
    return item;
  });
};

/** Rebuild the current state of a run, or throw `corrupt-history`. */
export const reconstructRunState = (
  timetable: Timetable,
  run: Run,
  events: readonly RunEvent[],
): RunState => {
  if (run.timetableId !== timetable.id || run.timetableVersion !== timetable.version) {
    corrupt(
      `Run ${run.id} was measured against ${run.timetableId}@${run.timetableVersion} ` +
        `but was given ${timetable.id}@${timetable.version}`,
    );
  }

  const sorted = sortEvents(events);
  assertWellFormed(run, sorted);
  const orderedItems = resolveExecutionOrder(timetable, run);

  const reversed = collectReversedTransitions(sorted);
  const effectiveEvents = sorted.filter(
    (event) => event.type !== 'undo' && !reversed.has(event.transitionId),
  );

  if (effectiveEvents.length === 0) {
    corrupt(`Run ${run.id} has no effective events; a run always starts its first item`);
  }

  let index = 0;
  let expecting: 'start' | 'terminal' = 'start';
  let currentItemStartedAt: Date | null = null;
  let previousAt = -Infinity;

  for (const event of effectiveEvents) {
    if (event.occurredAt.getTime() < previousAt) {
      corrupt(`Event ${event.id} occurs before the event that precedes it`);
    }
    previousAt = event.occurredAt.getTime();

    const item = orderedItems[index];
    if (!item) {
      corrupt(`Event ${event.id} refers to a position beyond the end of the timetable`);
      break;
    }
    if (event.itemId !== item.id) {
      corrupt(
        `Event ${event.id} refers to item "${event.itemId}" but the timetable expects "${item.id}"`,
      );
    }

    if (expecting === 'start') {
      if (event.type !== 'started') {
        corrupt(`Expected a started event for "${item.id}" but found "${event.type}"`);
      }
      currentItemStartedAt = event.occurredAt;
      expecting = 'terminal';
    } else {
      if (!isTerminal(event)) {
        corrupt(`Expected a completed or skipped event for "${item.id}" but found "${event.type}"`);
      }
      currentItemStartedAt = null;
      index += 1;
      expecting = 'start';
    }
  }

  let status: Run['status'];
  let phase: RunState['phase'];
  let currentIndex: number | null;
  let nextIndex: number | null;

  if (expecting === 'terminal') {
    status = 'active';
    phase = 'running';
    currentIndex = index;
    nextIndex = index + 1 < orderedItems.length ? index + 1 : null;
  } else if (index === orderedItems.length) {
    status = 'completed';
    phase = 'completed';
    currentIndex = null;
    nextIndex = null;
  } else {
    status = 'active';
    phase = 'between';
    currentIndex = null;
    nextIndex = index;
  }

  if (run.status === 'skipped') {
    if (status !== 'active' && status !== 'completed') {
      corrupt(`Skipped run ${run.id} must contain a valid run history`);
    }
    if (run.completedAt === null) {
      corrupt(`Skipped run ${run.id} has no skip timestamp`);
    }
    status = 'skipped';
    phase = 'completed';
    currentIndex = null;
    nextIndex = null;
    currentItemStartedAt = null;
  } else if (status !== run.status) {
    corrupt(
      `Run ${run.id} is stored as "${run.status}" but its events describe "${status}"`,
    );
  }
  if (status === 'completed' && run.completedAt === null) {
    corrupt(`Run ${run.id} is completed but has no completion timestamp`);
  }
  if (status === 'active' && run.completedAt !== null) {
    corrupt(`Run ${run.id} is active but has a completion timestamp`);
  }

  const currentItem = currentIndex === null ? null : (orderedItems[currentIndex] ?? null);
  const nextItem = nextIndex === null ? null : (orderedItems[nextIndex] ?? null);
  const lastEvent = sorted[sorted.length - 1];

  return {
    run,
    timetable,
    events: sorted,
    effectiveEvents,
    status,
    phase,
    orderedItems,
    currentIndex,
    currentItem,
    currentItemStartedAt,
    nextIndex,
    nextItem,
    canUndo: status !== 'skipped' && effectiveEvents.some(isTerminal),
    lastSeq: lastEvent ? lastEvent.seq : 0,
  };
};

/** The most recent transition that can be undone. */
export const findUndoTarget = (state: RunState): RunEvent | null => {
  for (let i = state.effectiveEvents.length - 1; i >= 0; i -= 1) {
    const event = state.effectiveEvents[i];
    if (
      event &&
      (isTerminal(event) ||
        (event.type === 'started' && event.seq > 1 && event.id === event.transitionId))
    ) {
      return event;
    }
  }
  return null;
};
