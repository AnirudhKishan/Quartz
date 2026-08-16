/**
 * Pure reconstruction of a run from its event history.
 *
 * This reducer is the single source of truth for "what is happening now". It is
 * used by the active-run screen, by the storage adapters inside their write
 * transactions, by the report engine, and by backup validation. If a history
 * cannot produce a valid state the reducer throws instead of guessing.
 */

import { QuartzError } from './errors';
import type { Run, RunEvent, RunState, Timetable } from './types';

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
    if (!isTerminal(target)) {
      corrupt(`Undo event ${event.id} must reverse a completed or skipped event`);
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

    const item = timetable.items[index];
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
  let currentIndex: number | null;

  if (expecting === 'terminal') {
    status = 'active';
    currentIndex = index;
  } else if (index === timetable.items.length) {
    status = 'completed';
    currentIndex = null;
  } else {
    status = 'active';
    currentIndex = null;
    corrupt(
      `Run ${run.id} ended item ${index} without starting the next one`,
      ['Next and Skip must record both changes atomically.'],
    );
  }

  if (run.status === 'skipped') {
    if (status !== 'active' && status !== 'completed') {
      corrupt(`Skipped run ${run.id} must contain a valid run history`);
    }
    if (run.completedAt === null) {
      corrupt(`Skipped run ${run.id} has no skip timestamp`);
    }
    status = 'skipped';
    currentIndex = null;
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

  const currentItem = currentIndex === null ? null : (timetable.items[currentIndex] ?? null);
  const nextItem = currentIndex === null ? null : (timetable.items[currentIndex + 1] ?? null);
  const lastEvent = sorted[sorted.length - 1];

  return {
    run,
    timetable,
    events: sorted,
    effectiveEvents,
    status,
    currentIndex,
    currentItem,
    currentItemStartedAt,
    nextItem,
    canUndo: status !== 'skipped' && effectiveEvents.some(isTerminal),
    lastSeq: lastEvent ? lastEvent.seq : 0,
  };
};

/** The most recent Next or Skip that has not already been undone. */
export const findUndoTarget = (state: RunState): RunEvent | null => {
  for (let i = state.effectiveEvents.length - 1; i >= 0; i -= 1) {
    const event = state.effectiveEvents[i];
    if (event && isTerminal(event)) return event;
  }
  return null;
};
