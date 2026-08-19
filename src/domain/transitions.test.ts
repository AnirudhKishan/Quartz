import { describe, expect, it } from 'vitest';

import { at, simpleTimetable } from '../test/fixtures';
import { RunDriver } from '../test/runDriver';
import { reconstructRunState } from './runState';
import { planTransition, planUndo } from './transitions';
import type { RunEvent } from './types';

const START = at('2026-03-02T00:00:00.000Z'); // 05:30 in Asia/Kolkata

describe('starting a run', () => {
  it('records the plan reference and the actual start of the first item', () => {
    const driver = new RunDriver(simpleTimetable, START);

    expect(driver.run.timetableId).toBe('test-plan');
    expect(driver.run.timetableVersion).toBe(1);
    expect(driver.run.localDate).toBe('2026-03-02');
    expect(driver.run.status).toBe('active');
    expect(driver.events).toHaveLength(1);
    expect(driver.events[0]).toMatchObject({ itemId: 'wake', type: 'started', seq: 1 });
    expect(driver.state.currentItem?.id).toBe('wake');
    expect(driver.state.nextItem?.id).toBe('gym');
    expect(driver.state.canUndo).toBe(false);
  });
});

describe('Next', () => {
  it('completes the current item and starts the next one at the same instant', () => {
    const driver = new RunDriver(simpleTimetable, START).next(at('2026-03-02T00:40:00.000Z'));

    const [, completed, started] = driver.events;
    expect(completed).toMatchObject({ itemId: 'wake', type: 'completed' });
    expect(started).toMatchObject({ itemId: 'gym', type: 'started' });
    expect(completed?.occurredAt.toISOString()).toBe(started?.occurredAt.toISOString());
    expect(completed?.transitionId).toBe(started?.transitionId);
    expect(driver.state.currentItem?.id).toBe('gym');
  });

  it('completes the run on the final item', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .next(at('2026-03-02T00:40:00.000Z'))
      .next(at('2026-03-02T02:00:00.000Z'))
      .next(at('2026-03-02T02:35:00.000Z'));

    expect(driver.run.status).toBe('completed');
    expect(driver.run.completedAt?.toISOString()).toBe('2026-03-02T02:35:00.000Z');
    expect(driver.state.currentItem).toBeNull();
    expect(driver.state.nextItem).toBeNull();
  });
});

describe('Skip', () => {
  it('marks the item skipped and starts the next one at the same instant', () => {
    const driver = new RunDriver(simpleTimetable, START).skip(at('2026-03-02T00:10:00.000Z'));

    const [, skipped, started] = driver.events;
    expect(skipped).toMatchObject({ itemId: 'wake', type: 'skipped' });
    expect(started).toMatchObject({ itemId: 'gym', type: 'started' });
    expect(skipped?.occurredAt.toISOString()).toBe(started?.occurredAt.toISOString());
    expect(driver.state.currentItem?.id).toBe('gym');
  });

  it('completes the run when the final item is skipped', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .next(at('2026-03-02T00:40:00.000Z'))
      .next(at('2026-03-02T02:00:00.000Z'))
      .skip(at('2026-03-02T02:05:00.000Z'));

    expect(driver.run.status).toBe('completed');
    expect(driver.run.completedAt?.toISOString()).toBe('2026-03-02T02:05:00.000Z');
  });
});

describe('Undo', () => {
  it('restores the preceding item without rewriting its original start', () => {
    const driver = new RunDriver(simpleTimetable, START).next(at('2026-03-02T00:40:00.000Z'));
    const originalStart = driver.state.currentItemStartedAt;
    expect(originalStart?.toISOString()).toBe('2026-03-02T00:40:00.000Z');

    driver.undo(at('2026-03-02T00:45:00.000Z'));

    expect(driver.state.currentItem?.id).toBe('wake');
    // The restored item keeps the timestamp it originally started at.
    expect(driver.state.currentItemStartedAt?.toISOString()).toBe('2026-03-02T00:00:00.000Z');
  });

  it('appends rather than deleting, so the history stays auditable', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .next(at('2026-03-02T00:40:00.000Z'))
      .undo(at('2026-03-02T00:45:00.000Z'));

    expect(driver.events).toHaveLength(4);
    const undoEvent = driver.events[3] as RunEvent;
    expect(undoEvent.type).toBe('undo');
    expect(undoEvent.reversesEventId).toBe(driver.events[1]?.id);
    expect(driver.state.effectiveEvents).toHaveLength(1);
  });

  it('reverses a skip', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .skip(at('2026-03-02T00:05:00.000Z'))
      .undo(at('2026-03-02T00:06:00.000Z'));

    expect(driver.state.currentItem?.id).toBe('wake');
    expect(driver.state.effectiveEvents.some((event) => event.type === 'skipped')).toBe(false);
  });

  it('reopens a run that had just been completed', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .next(at('2026-03-02T00:40:00.000Z'))
      .next(at('2026-03-02T02:00:00.000Z'))
      .next(at('2026-03-02T02:35:00.000Z'));
    expect(driver.run.status).toBe('completed');

    driver.undo(at('2026-03-02T02:36:00.000Z'));

    expect(driver.run.status).toBe('active');
    expect(driver.run.completedAt).toBeNull();
    expect(driver.state.currentItem?.id).toBe('breakfast');
  });

  it('steps back through successive transitions', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .next(at('2026-03-02T00:40:00.000Z'))
      .next(at('2026-03-02T02:00:00.000Z'));
    expect(driver.state.currentItem?.id).toBe('breakfast');

    driver.undo(at('2026-03-02T02:01:00.000Z'));
    expect(driver.state.currentItem?.id).toBe('gym');

    driver.undo(at('2026-03-02T02:02:00.000Z'));
    expect(driver.state.currentItem?.id).toBe('wake');
    expect(driver.state.canUndo).toBe(false);
  });

  it('refuses to undo the start of the run', () => {
    const driver = new RunDriver(simpleTimetable, START);
    expect(() => driver.undo(at('2026-03-02T00:01:00.000Z'))).toThrow(/no Next or Skip left/);
  });
});

describe('preconditions', () => {
  it('rejects a second press that repeats an already-applied transition', () => {
    const driver = new RunDriver(simpleTimetable, START);
    const stale = driver.state;
    driver.next(at('2026-03-02T00:40:00.000Z'));

    // The same press replayed against storage that has already moved on.
    expect(() =>
      planTransition(simpleTimetable, driver.run, driver.events, {
        runId: driver.run.id,
        kind: 'next',
        occurredAt: at('2026-03-02T00:40:00.000Z'),
        expectedItemId: stale.currentItem!.id,
        expectedSeq: stale.lastSeq,
      }),
    ).toThrow(/moved on before this action was applied/);

    expect(driver.events).toHaveLength(3);
  });

  it('rejects advancing a completed run', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .next(at('2026-03-02T00:40:00.000Z'))
      .next(at('2026-03-02T02:00:00.000Z'))
      .next(at('2026-03-02T02:35:00.000Z'));

    expect(() =>
      planTransition(simpleTimetable, driver.run, driver.events, {
        runId: driver.run.id,
        kind: 'next',
        occurredAt: at('2026-03-02T03:00:00.000Z'),
        expectedItemId: 'breakfast',
        expectedSeq: driver.state.lastSeq,
      }),
    ).toThrow(/already been completed/);
  });

  it('clamps a backwards clock so a history can never describe negative time', () => {
    const driver = new RunDriver(simpleTimetable, START).next(at('2026-03-02T00:40:00.000Z'));
    driver.next(at('2026-03-02T00:10:00.000Z'));

    const gym = driver.state.effectiveEvents.find(
      (event) => event.itemId === 'gym' && event.type === 'completed',
    );
    expect(gym?.occurredAt.toISOString()).toBe('2026-03-02T00:40:00.000Z');
  });
});

describe('reconstruction of an invalid history', () => {
  const build = (mutate: (events: RunEvent[]) => RunEvent[]) => {
    const driver = new RunDriver(simpleTimetable, START).next(at('2026-03-02T00:40:00.000Z'));
    return () => reconstructRunState(simpleTimetable, driver.run, mutate([...driver.events]));
  };

  it('rejects a gap in the event sequence', () => {
    expect(build((events) => [events[0]!, events[2]!])).toThrow(/not contiguous/);
  });

  it('accepts an event that ends an item before the next one starts', () => {
    const driver = new RunDriver(simpleTimetable, START).finish(
      at('2026-03-02T00:40:00.000Z'),
    );
    expect(driver.state.phase).toBe('between');
    expect(driver.state.nextItem?.id).toBe('gym');
  });

  it('rejects an event for the wrong item', () => {
    expect(
      build((events) => [events[0]!, { ...events[1]!, itemId: 'breakfast' }, events[2]!]),
    ).toThrow(/but the timetable expects/);
  });

  it('rejects an undo that references an unknown event', () => {
    expect(
      build((events) => [
        ...events,
        {
          id: `${events[0]!.runId}#00000004`,
          runId: events[0]!.runId,
          itemId: 'wake',
          type: 'undo',
          occurredAt: at('2026-03-02T01:00:00.000Z'),
          reversesEventId: 'does-not-exist',
          transitionId: `${events[0]!.runId}#00000004`,
          seq: 4,
        },
      ]),
    ).toThrow(/references unknown event/);
  });

  it('rejects a stored status that disagrees with the events', () => {
    const driver = new RunDriver(simpleTimetable, START);
    expect(() =>
      reconstructRunState(
        simpleTimetable,
        { ...driver.run, status: 'completed', completedAt: START },
        driver.events,
      ),
    ).toThrow(/stored as "completed" but its events describe "active"/);
  });

  it('rejects a run measured against a different timetable version', () => {
    const driver = new RunDriver(simpleTimetable, START);
    expect(() =>
      reconstructRunState(
        { ...simpleTimetable, version: 9 },
        driver.run,
        driver.events,
      ),
    ).toThrow(/but was given test-plan@9/);
  });

  it('rejects an undo of an undo', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .next(at('2026-03-02T00:40:00.000Z'))
      .undo(at('2026-03-02T00:45:00.000Z'));
    const undoEvent = driver.events[3]!;

    expect(() =>
      reconstructRunState(simpleTimetable, driver.run, [
        ...driver.events,
        {
          ...undoEvent,
          id: `${driver.run.id}#00000005`,
          transitionId: `${driver.run.id}#00000005`,
          reversesEventId: undoEvent.id,
          seq: 5,
        },
      ]),
    ).toThrow(/must reverse a transition that can be undone/);
  });
});

describe('between tasks and today order', () => {
  it('finishes, starts later, and supports two-step undo', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .finish(at('2026-03-02T00:30:00.000Z'))
      .startNext(at('2026-03-02T00:45:00.000Z'));

    expect(driver.state.phase).toBe('running');
    expect(driver.state.currentItem?.id).toBe('gym');
    driver.undo(at('2026-03-02T00:46:00.000Z'));
    expect(driver.state.phase).toBe('between');
    driver.undo(at('2026-03-02T00:47:00.000Z'));
    expect(driver.state.phase).toBe('running');
    expect(driver.state.currentItem?.id).toBe('wake');
  });

  it('moves only an upcoming item into the next position', () => {
    const driver = new RunDriver(simpleTimetable, START).reorder('breakfast');
    expect(driver.state.orderedItems.map((item) => item.id)).toEqual([
      'wake',
      'breakfast',
      'gym',
    ]);
    driver.next(at('2026-03-02T00:30:00.000Z'));
    expect(driver.state.currentItem?.id).toBe('breakfast');
    expect(() => driver.reorder('wake')).toThrow(/not started/);
  });

  it('moves both sides of a shared boundary atomically', () => {
    const driver = new RunDriver(simpleTimetable, START).next(
      at('2026-03-02T00:30:00.000Z'),
    );
    driver.edit(
      [
        {
          eventId: driver.events[2]!.id,
          expectedOccurredAt: driver.events[2]!.occurredAt,
          occurredAt: at('2026-03-02T00:40:00.000Z'),
        },
      ],
      at('2026-03-02T01:00:00.000Z'),
    );
    expect(driver.events[1]?.occurredAt.toISOString()).toBe('2026-03-02T00:40:00.000Z');
    expect(driver.events[2]?.occurredAt.toISOString()).toBe('2026-03-02T00:40:00.000Z');
  });

  it('reports an invalid prospective edit without treating stored history as corrupt', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .finish(at('2026-03-02T00:30:00.000Z'))
      .startNext(at('2026-03-02T00:45:00.000Z'));

    try {
      driver.edit(
        [
          {
            eventId: driver.events[2]!.id,
            expectedOccurredAt: driver.events[2]!.occurredAt,
            occurredAt: at('2026-03-02T00:20:00.000Z'),
          },
        ],
        at('2026-03-02T01:00:00.000Z'),
      );
      throw new Error('Expected the overlapping edit to be rejected');
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid-transition-time' });
    }
  });

  it('fills an exact recorded gap with a completed inserted task', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .finish(at('2026-03-02T00:30:00.000Z'))
      .startNext(at('2026-03-02T00:45:00.000Z'))
      .recordGap(
        'Phone call',
        at('2026-03-02T00:30:00.000Z'),
        at('2026-03-02T00:45:00.000Z'),
        at('2026-03-02T01:00:00.000Z'),
      );

    expect(driver.events.slice(-2).map((event) => event.type)).toEqual([
      'recorded-start',
      'recorded-end',
    ]);
    expect(driver.state.segments.map((segment) => segment.startedAt.toISOString())).toEqual([
      '2026-03-02T00:00:00.000Z',
      '2026-03-02T00:30:00.000Z',
      '2026-03-02T00:45:00.000Z',
    ]);
    expect(driver.state.occurrences.find((occurrence) => occurrence.label === 'Phone call')).toMatchObject({
      kind: 'inserted',
      insertedOrigin: 'unplanned',
    });
  });

  it('rejects a stale or non-gap interval', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .finish(at('2026-03-02T00:30:00.000Z'))
      .startNext(at('2026-03-02T00:45:00.000Z'));

    expect(() =>
      driver.recordGap(
        'Too short',
        at('2026-03-02T00:35:00.000Z'),
        at('2026-03-02T00:45:00.000Z'),
        at('2026-03-02T01:00:00.000Z'),
      ),
    ).toThrow(/gap no longer exists/);
  });

  it('keeps later operational transitions monotonic after appending a historical gap', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .finish(at('2026-03-02T00:30:00.000Z'))
      .startNext(at('2026-03-02T00:45:00.000Z'))
      .recordGap(
        'Between tasks',
        at('2026-03-02T00:30:00.000Z'),
        at('2026-03-02T00:45:00.000Z'),
        at('2026-03-02T01:00:00.000Z'),
      )
      .next(at('2026-03-02T00:40:00.000Z'));

    const gymEnd = driver.state.segments.find(
      (segment) => segment.occurrenceId === 'gym',
    )?.endedAt;
    expect(gymEnd?.toISOString()).toBe('2026-03-02T00:45:00.000Z');
    expect(driver.state.currentItem?.id).toBe('breakfast');
  });

  it('does not let Undo cross a recorded historical interval', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .finish(at('2026-03-02T00:30:00.000Z'))
      .startNext(at('2026-03-02T00:45:00.000Z'))
      .recordGap(
        'Between tasks',
        at('2026-03-02T00:30:00.000Z'),
        at('2026-03-02T00:45:00.000Z'),
        at('2026-03-02T01:00:00.000Z'),
      );

    expect(driver.state.canUndo).toBe(false);
    expect(() => driver.undo(at('2026-03-02T01:01:00.000Z'))).toThrow(/no Next or Skip left/);
  });

  it('can undo new operational transitions without crossing a recorded interval', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .finish(at('2026-03-02T00:30:00.000Z'))
      .startNext(at('2026-03-02T00:45:00.000Z'))
      .recordGap(
        'Between tasks',
        at('2026-03-02T00:30:00.000Z'),
        at('2026-03-02T00:45:00.000Z'),
        at('2026-03-02T01:00:00.000Z'),
      )
      .next(at('2026-03-02T02:00:00.000Z'));

    expect(driver.state.canUndo).toBe(true);
    driver.undo(at('2026-03-02T02:01:00.000Z'));
    expect(driver.state.currentItem?.id).toBe('gym');
    expect(driver.state.canUndo).toBe(false);
  });
});

describe('inserted activities and segmented tasks', () => {
  it('starts an unplanned task atomically and Undo removes it', () => {
    const driver = new RunDriver(simpleTimetable, START).startUnplanned(
      'Phone call',
      at('2026-03-02T00:20:00.000Z'),
    );

    expect(driver.state.currentActivity).toMatchObject({
      label: 'Phone call',
      kind: 'inserted',
      insertedOrigin: 'unplanned',
    });
    expect(driver.state.nextItem?.id).toBe('gym');
    expect(driver.state.segments).toHaveLength(2);
    expect(driver.state.segments[0]?.endedAt?.toISOString()).toBe(
      '2026-03-02T00:20:00.000Z',
    );

    driver.undo(at('2026-03-02T00:21:00.000Z'));
    expect(driver.state.currentActivity?.id).toBe('wake');
    expect(driver.state.occurrences.some((occurrence) => occurrence.label === 'Phone call')).toBe(
      false,
    );
  });

  it('pauses and resumes the same planned occurrence as another segment', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .pause(at('2026-03-02T00:20:00.000Z'))
      .resume(at('2026-03-02T00:30:00.000Z'));

    expect(driver.state.phase).toBe('running');
    expect(driver.state.currentActivity?.id).toBe('wake');
    expect(driver.state.segments.map((segment) => segment.occurrenceId)).toEqual([
      'wake',
      expect.stringContaining(':occurrence'),
      'wake',
    ]);
    expect(driver.state.segments[0]?.endType).toBe('paused');
    expect(driver.state.nextItem?.id).toBe('gym');
  });

  it('supports repeated pauses without duplicating the planned occurrence', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .pause(at('2026-03-02T00:10:00.000Z'))
      .resume(at('2026-03-02T00:15:00.000Z'))
      .pause(at('2026-03-02T00:20:00.000Z'));

    expect(driver.state.phase).toBe('paused');
    expect(driver.state.resumeTarget?.id).toBe('wake');
    expect(driver.state.occurrences.filter((occurrence) => occurrence.id === 'wake')).toHaveLength(
      1,
    );
    expect(
      driver.state.occurrences.filter((occurrence) => occurrence.insertedOrigin === 'pause'),
    ).toHaveLength(2);
  });

  it('undoes Resume back to the same paused interruption', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .pause(at('2026-03-02T00:20:00.000Z'))
      .resume(at('2026-03-02T00:30:00.000Z'))
      .undo(at('2026-03-02T00:31:00.000Z'));

    expect(driver.state.phase).toBe('paused');
    expect(driver.state.currentActivity?.label).toBe('Between tasks');
    expect(driver.state.resumeTarget?.id).toBe('wake');
  });

  it('ends a paused task without ending its running interruption', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .pause(at('2026-03-02T00:20:00.000Z'))
      .endPaused(at('2026-03-02T00:30:00.000Z'));

    expect(driver.state.phase).toBe('running');
    expect(driver.state.currentActivity?.label).toBe('Between tasks');
    expect(driver.state.resumeTarget).toBeNull();
    expect(driver.state.nextItem?.id).toBe('gym');
    expect(driver.state.segments[0]?.endedAt?.toISOString()).toBe(
      '2026-03-02T00:20:00.000Z',
    );

    driver.next(at('2026-03-02T00:35:00.000Z'));
    expect(driver.state.currentActivity?.id).toBe('gym');
  });

  it('undoes End back to the paused state', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .pause(at('2026-03-02T00:20:00.000Z'))
      .endPaused(at('2026-03-02T00:30:00.000Z'))
      .undo(at('2026-03-02T00:31:00.000Z'));

    expect(driver.state.phase).toBe('paused');
    expect(driver.state.resumeTarget?.id).toBe('wake');
  });
});

describe('planUndo', () => {
  it('targets the most recent transition that has not already been reversed', () => {
    const driver = new RunDriver(simpleTimetable, START)
      .next(at('2026-03-02T00:40:00.000Z'))
      .next(at('2026-03-02T02:00:00.000Z'));

    const planned = planUndo(
      simpleTimetable,
      driver.run,
      driver.events,
      at('2026-03-02T02:10:00.000Z'),
    );
    expect(planned.events[0]?.reversesEventId).toBe(driver.events[3]?.id);
  });
});
