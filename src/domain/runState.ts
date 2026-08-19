/**
 * Pure reconstruction of a run from its event history.
 *
 * A planned occurrence may own several active segments. Inserted occurrences
 * are defined by their first started event, which keeps creation and Undo in the
 * same atomic transition.
 */

import { QuartzError } from './errors';
import type {
  ActivitySegment,
  Run,
  RunEvent,
  RunState,
  Timetable,
  TimetableItem,
  TrackedOccurrence,
} from './types';

export const eventId = (runId: string, seq: number): string =>
  `${runId}#${String(seq).padStart(8, '0')}`;

export const sortEvents = (events: readonly RunEvent[]): RunEvent[] =>
  [...events].sort((a, b) => a.seq - b.seq);

const isRecordedIntervalEvent = (event: RunEvent): boolean =>
  event.type === 'recorded-start' || event.type === 'recorded-end';

function corrupt(message: string, details: readonly string[] = []): never {
  throw new QuartzError('corrupt-history', message, details);
}

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
      corrupt(`Undo event ${event.id} does not reference the transition it reverses`);
    }
    const target = byId.get(event.reversesEventId);
    if (!target) {
      corrupt(`Undo event ${event.id} references unknown event ${event.reversesEventId}`);
    }
    if (target.type === 'undo' || target.id !== target.transitionId || target.seq === 1) {
      corrupt(`Undo event ${event.id} must reverse a transition that can be undone`);
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

const plannedOccurrence = (item: TimetableItem): TrackedOccurrence => ({
  id: item.id,
  label: item.label,
  kind: 'planned',
  plannedItemId: item.id,
  insertedOrigin: null,
  resumeTargetId: null,
});

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

  const occurrences = orderedItems.map(plannedOccurrence);
  const occurrenceById = new Map(occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const segments: ActivitySegment[] = [];
  const completed = new Set<string>();
  const skipped = new Set<string>();
  const paused = new Set<string>();

  let plannedCursor = 0;
  let currentActivity: TrackedOccurrence | null = null;
  let openSegmentIndex: number | null = null;
  let resumeTargetId: string | null = null;
  let previousAt = -Infinity;

  const operationalEvents = effectiveEvents.filter((event) => !isRecordedIntervalEvent(event));
  const recordedEvents = effectiveEvents.filter(isRecordedIntervalEvent);

  for (const event of operationalEvents) {
    if (event.occurredAt.getTime() < previousAt) {
      corrupt(`Event ${event.id} occurs before the event that precedes it`);
    }
    previousAt = event.occurredAt.getTime();

    if (event.type === 'started') {
      if (currentActivity !== null || openSegmentIndex !== null) {
        corrupt(`Event ${event.id} starts an activity while another segment is running`);
      }

      const inserted = event.inserted ?? null;
      let occurrence = occurrenceById.get(event.itemId);
      if (inserted) {
        if (occurrence || inserted.label.trim().length === 0) {
          corrupt(`Event ${event.id} has an invalid inserted occurrence definition`);
        }
        if (
          (inserted.origin === 'pause' && inserted.resumeTargetId === null) ||
          (inserted.origin === 'unplanned' && inserted.resumeTargetId !== null)
        ) {
          corrupt(`Event ${event.id} has inconsistent inserted occurrence metadata`);
        }
        if (inserted.resumeTargetId !== null) {
          const target = occurrenceById.get(inserted.resumeTargetId);
          if (!target || target.kind !== 'planned' || !paused.has(target.id)) {
            corrupt(`Event ${event.id} references an activity that is not paused`);
          }
          if (resumeTargetId !== null) {
            corrupt(`Event ${event.id} creates a second resume target`);
          }
          resumeTargetId = target.id;
        }
        occurrence = {
          id: event.itemId,
          label: inserted.label.trim(),
          kind: 'inserted',
          plannedItemId: null,
          insertedOrigin: inserted.origin,
          resumeTargetId: inserted.resumeTargetId,
        };
        occurrences.push(occurrence);
        occurrenceById.set(occurrence.id, occurrence);
      } else {
        if (!occurrence) {
          corrupt(`Event ${event.id} starts unknown occurrence "${event.itemId}"`);
        }
        if (occurrence.kind === 'inserted') {
          corrupt(`Inserted occurrence "${occurrence.id}" cannot be started more than once`);
        }
        if (completed.has(occurrence.id) || skipped.has(occurrence.id)) {
          corrupt(`Event ${event.id} restarts a finished occurrence`);
        }
        if (resumeTargetId !== null) {
          if (event.itemId !== resumeTargetId || !paused.has(event.itemId)) {
            corrupt(`Event ${event.id} does not resume the expected paused occurrence`);
          }
          paused.delete(event.itemId);
          resumeTargetId = null;
        } else {
          const expected = orderedItems[plannedCursor];
          if (!expected || expected.id !== event.itemId || paused.has(event.itemId)) {
            corrupt(
              `Event ${event.id} starts "${event.itemId}" but the planned order expects ` +
                `"${expected?.id ?? 'the end of the day'}"`,
            );
          }
        }
      }

      currentActivity = occurrence;
      segments.push({
        id: event.id,
        occurrenceId: occurrence.id,
        startedAt: event.occurredAt,
        endedAt: null,
        startEventId: event.id,
        endEventId: null,
        endType: null,
      });
      openSegmentIndex = segments.length - 1;
      continue;
    }

    if (event.type === 'ended') {
      if (
        currentActivity?.kind !== 'inserted' ||
        resumeTargetId !== event.itemId ||
        !paused.has(event.itemId)
      ) {
        corrupt(`Event ${event.id} does not end the current paused occurrence`);
      }
      const expected = orderedItems[plannedCursor];
      if (!expected || expected.id !== event.itemId) {
        corrupt(`Event ${event.id} ends a paused occurrence out of planned order`);
      }
      paused.delete(event.itemId);
      completed.add(event.itemId);
      resumeTargetId = null;
      plannedCursor += 1;
      continue;
    }

    if (
      event.type !== 'completed' &&
      event.type !== 'skipped' &&
      event.type !== 'paused'
    ) {
      corrupt(`Event ${event.id} has unsupported type "${event.type}"`);
    }
    if (
      currentActivity === null ||
      currentActivity.id !== event.itemId ||
      openSegmentIndex === null
    ) {
      if (currentActivity !== null && currentActivity.id !== event.itemId) {
        corrupt(
          `Event ${event.id} refers to item "${event.itemId}" but the timetable expects ` +
            `"${currentActivity.id}"`,
        );
      }
      corrupt(`Event ${event.id} does not close the running occurrence`);
    }

    const segment = segments[openSegmentIndex];
    if (!segment) corrupt(`Event ${event.id} cannot find its running segment`);
    segments[openSegmentIndex] = {
      ...segment,
      endedAt: event.occurredAt,
      endEventId: event.id,
      endType: event.type,
    };

    if (event.type === 'paused') {
      if (currentActivity.kind !== 'planned' || resumeTargetId !== null) {
        corrupt(`Event ${event.id} can pause only one planned occurrence`);
      }
      paused.add(currentActivity.id);
    } else if (event.type === 'skipped') {
      if (currentActivity.kind !== 'planned') {
        corrupt(`Event ${event.id} cannot skip an inserted occurrence`);
      }
      const expected = orderedItems[plannedCursor];
      if (!expected || expected.id !== currentActivity.id) {
        corrupt(`Event ${event.id} skips a planned occurrence out of order`);
      }
      skipped.add(currentActivity.id);
      plannedCursor += 1;
    } else {
      completed.add(currentActivity.id);
      if (currentActivity.kind === 'planned') {
        const expected = orderedItems[plannedCursor];
        if (!expected || expected.id !== currentActivity.id) {
          corrupt(`Event ${event.id} completes a planned occurrence out of order`);
        }
        plannedCursor += 1;
      }
    }

    currentActivity = null;
    openSegmentIndex = null;
  }

  const recordedByTransition = new Map<string, RunEvent[]>();
  for (const event of recordedEvents) {
    const group = recordedByTransition.get(event.transitionId) ?? [];
    group.push(event);
    recordedByTransition.set(event.transitionId, group);
  }
  for (const [transitionId, group] of recordedByTransition) {
    const start = group.find((event) => event.type === 'recorded-start');
    const end = group.find((event) => event.type === 'recorded-end');
    const inserted = start?.inserted ?? null;
    if (
      group.length !== 2 ||
      !start ||
      !end ||
      start.id === transitionId ||
      end.id === transitionId ||
      start.itemId !== end.itemId ||
      !inserted ||
      inserted.origin !== 'unplanned' ||
      inserted.resumeTargetId !== null ||
      inserted.label.trim().length === 0 ||
      end.inserted
    ) {
      corrupt(`Recorded interval ${transitionId} is not a valid inserted task`);
    }
    if (
      start.occurredAt.getTime() >= end.occurredAt.getTime() ||
      occurrenceById.has(start.itemId)
    ) {
      corrupt(`Recorded interval ${transitionId} has invalid boundaries`);
    }
    const overlaps = segments.some((segment) => {
      const segmentEnd = segment.endedAt?.getTime() ?? Infinity;
      return (
        start.occurredAt.getTime() < segmentEnd &&
        end.occurredAt.getTime() > segment.startedAt.getTime()
      );
    });
    if (overlaps) {
      corrupt(`Recorded interval ${transitionId} overlaps another activity`);
    }
    const occurrence: TrackedOccurrence = {
      id: start.itemId,
      label: inserted.label.trim(),
      kind: 'inserted',
      plannedItemId: null,
      insertedOrigin: 'unplanned',
      resumeTargetId: null,
    };
    occurrences.push(occurrence);
    occurrenceById.set(occurrence.id, occurrence);
    completed.add(occurrence.id);
    segments.push({
      id: start.id,
      occurrenceId: occurrence.id,
      startedAt: start.occurredAt,
      endedAt: end.occurredAt,
      startEventId: start.id,
      endEventId: end.id,
      endType: 'completed',
    });
  }

  let status: Run['status'];
  let phase: RunState['phase'];
  if (currentActivity !== null) {
    if (resumeTargetId !== null) {
      if (
        currentActivity.kind !== 'inserted' ||
        currentActivity.insertedOrigin !== 'pause' ||
        currentActivity.resumeTargetId !== resumeTargetId
      ) {
        corrupt(`Run ${run.id} has an invalid paused state`);
      }
      status = 'active';
      phase = 'paused';
    } else {
      status = 'active';
      phase = 'running';
    }
  } else if (plannedCursor === orderedItems.length) {
    if (paused.size > 0 || resumeTargetId !== null) {
      corrupt(`Run ${run.id} completes with a paused occurrence`);
    }
    status = 'completed';
    phase = 'completed';
  } else {
    if (paused.size > 0 || resumeTargetId !== null) {
      corrupt(`Run ${run.id} stops between events while an occurrence is paused`);
    }
    status = 'active';
    phase = 'between';
  }

  if (run.status === 'skipped') {
    if (run.completedAt === null) corrupt(`Skipped run ${run.id} has no skip timestamp`);
    status = 'skipped';
    phase = 'completed';
    currentActivity = null;
  } else if (status !== run.status) {
    corrupt(`Run ${run.id} is stored as "${run.status}" but its events describe "${status}"`);
  }
  if (status === 'completed' && run.completedAt === null) {
    corrupt(`Run ${run.id} is completed but has no completion timestamp`);
  }
  if (status === 'active' && run.completedAt !== null) {
    corrupt(`Run ${run.id} is active but has a completion timestamp`);
  }

  const currentItem =
    currentActivity?.plannedItemId === null || currentActivity === null
      ? null
      : (orderedItems.find((item) => item.id === currentActivity.plannedItemId) ?? null);
  const currentIndex = currentItem
    ? orderedItems.findIndex((item) => item.id === currentItem.id)
    : null;
  const resumeTarget =
    resumeTargetId === null ? null : (occurrenceById.get(resumeTargetId) ?? null);
  const nextPlannedIndex =
    currentItem !== null || resumeTarget !== null ? plannedCursor + 1 : plannedCursor;
  const nextIndex = nextPlannedIndex < orderedItems.length ? nextPlannedIndex : null;
  const nextItem = nextIndex === null ? null : (orderedItems[nextIndex] ?? null);
  const openSegment = openSegmentIndex === null ? null : (segments[openSegmentIndex] ?? null);
  const chronologicalSegments = [...segments].sort(
    (left, right) => left.startedAt.getTime() - right.startedAt.getTime(),
  );
  const lastEvent = sorted[sorted.length - 1];
  const state: RunState = {
    run,
    timetable,
    events: sorted,
    effectiveEvents,
    status,
    phase,
    occurrences,
    segments: chronologicalSegments,
    currentActivity,
    currentActivityStartedAt: openSegment?.startedAt ?? null,
    resumeTarget,
    completedOccurrenceIds: [...completed],
    skippedOccurrenceIds: [...skipped],
    orderedItems,
    currentIndex,
    currentItem,
    currentItemStartedAt: currentItem ? (openSegment?.startedAt ?? null) : null,
    nextIndex,
    nextItem,
    canUndo: false,
    lastSeq: lastEvent?.seq ?? 0,
  };
  return { ...state, canUndo: findUndoTarget(state) !== null };
};

/** The first event of the most recent effective transition that can be undone. */
export const findUndoTarget = (state: RunState): RunEvent | null => {
  for (let index = state.effectiveEvents.length - 1; index >= 0; index -= 1) {
    const event = state.effectiveEvents[index];
    if (event?.type === 'recorded-start' || event?.type === 'recorded-end') return null;
    if (event && event.seq > 1 && event.id === event.transitionId) return event;
  }
  return null;
};
