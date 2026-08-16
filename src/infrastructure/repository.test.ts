import { beforeEach, describe, expect, it } from 'vitest';

import { sequentialIdGenerator } from '../domain/clock';
import { simpleTimetable, simpleTimetableV2 } from '../test/fixtures';
import type { TimetableRepository } from '../application/repository';
import { IndexedDbRepository } from './indexedDbRepository';
import { InMemoryRepository } from './memoryRepository';

const START = new Date('2026-03-02T00:00:00.000Z');
const ref = { timetableId: 'test-plan', version: 1 };

let databaseCounter = 0;

const adapters: { name: string; create: () => TimetableRepository }[] = [
  {
    name: 'InMemoryRepository',
    create: () => new InMemoryRepository(sequentialIdGenerator()),
  },
  {
    name: 'IndexedDbRepository',
    create: () => {
      databaseCounter += 1;
      return new IndexedDbRepository(`quartz-test-${databaseCounter}`, sequentialIdGenerator());
    },
  },
];

describe.each(adapters)('$name satisfies the repository contract', ({ create }) => {
  let repository: TimetableRepository;

  beforeEach(async () => {
    repository = create();
    await repository.saveTimetable(simpleTimetable);
    await repository.saveTimetable(simpleTimetableV2);
  });

  const advance = async (kind: 'next' | 'skip', occurredAt: Date) => {
    const run = await repository.getActiveRun();
    if (!run) throw new Error('no active run');
    const events = await repository.getRunEvents(run.id);
    const last = events[events.length - 1];
    const state = events.filter((event) => event.type !== 'undo');
    const currentItemId = state[state.length - 1]?.itemId ?? '';
    await repository.appendTransition({
      runId: run.id,
      kind,
      occurredAt,
      expectedItemId: currentItemId,
      expectedSeq: last?.seq ?? 0,
    });
  };

  it('lists bundled timetables with their versions', async () => {
    const summaries = await repository.listTimetables();
    expect(summaries.map((summary) => `${summary.id}@${summary.version}`)).toEqual([
      'test-plan@1',
      'test-plan@2',
    ]);
  });

  it('records the run reference and the first item start atomically', async () => {
    const run = await repository.createRun(ref, START);

    expect(run).toMatchObject({
      timetableId: 'test-plan',
      timetableVersion: 1,
      localDate: '2026-03-02',
      status: 'active',
    });
    const events = await repository.getRunEvents(run.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ itemId: 'wake', type: 'started', seq: 1 });
  });

  it('prevents a second run from starting while one is active', async () => {
    await repository.createRun(ref, START);
    await expect(repository.createRun(ref, START)).rejects.toThrow(/already in progress/);
    expect(await repository.listRuns()).toHaveLength(1);
  });

  it('applies Next as a single atomic write', async () => {
    const run = await repository.createRun(ref, START);
    await advance('next', new Date('2026-03-02T00:30:00.000Z'));

    const events = await repository.getRunEvents(run.id);
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({ itemId: 'wake', type: 'completed' });
    expect(events[2]).toMatchObject({ itemId: 'gym', type: 'started' });
    expect(events[1]?.occurredAt.getTime()).toBe(events[2]?.occurredAt.getTime());
  });

  it('rejects a repeated tap without writing anything', async () => {
    const run = await repository.createRun(ref, START);
    const command = {
      runId: run.id,
      kind: 'next' as const,
      occurredAt: new Date('2026-03-02T00:30:00.000Z'),
      expectedItemId: 'wake',
      expectedSeq: 1,
    };

    await repository.appendTransition(command);
    await expect(repository.appendTransition(command)).rejects.toThrow(/moved on/);

    expect(await repository.getRunEvents(run.id)).toHaveLength(3);
  });

  it('rejects concurrent presses so only one transition is recorded', async () => {
    const run = await repository.createRun(ref, START);
    const command = {
      runId: run.id,
      kind: 'next' as const,
      occurredAt: new Date('2026-03-02T00:30:00.000Z'),
      expectedItemId: 'wake',
      expectedSeq: 1,
    };

    const results = await Promise.allSettled([
      repository.appendTransition(command),
      repository.appendTransition({ ...command, kind: 'skip' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await repository.getRunEvents(run.id)).toHaveLength(3);
  });

  it('completes the run on the final Next', async () => {
    const run = await repository.createRun(ref, START);
    await advance('next', new Date('2026-03-02T00:30:00.000Z'));
    await advance('next', new Date('2026-03-02T02:00:00.000Z'));
    await advance('next', new Date('2026-03-02T02:35:00.000Z'));

    const stored = await repository.getRun(run.id);
    expect(stored?.status).toBe('completed');
    expect(stored?.completedAt?.toISOString()).toBe('2026-03-02T02:35:00.000Z');
    expect(await repository.getActiveRun()).toBeNull();
    expect(await repository.listCompletedRuns()).toHaveLength(1);
  });

  it('undoes the most recent transition and reopens a completed run', async () => {
    const run = await repository.createRun(ref, START);
    await advance('next', new Date('2026-03-02T00:30:00.000Z'));
    await advance('next', new Date('2026-03-02T02:00:00.000Z'));
    await advance('next', new Date('2026-03-02T02:35:00.000Z'));

    await repository.undoLastTransition(run.id, new Date('2026-03-02T02:36:00.000Z'));

    const reopened = await repository.getRun(run.id);
    expect(reopened?.status).toBe('active');
    expect(reopened?.completedAt).toBeNull();
    expect(await repository.getActiveRun()).not.toBeNull();
  });

  it('refuses to undo past the start of the run', async () => {
    const run = await repository.createRun(ref, START);
    await expect(repository.undoLastTransition(run.id, START)).rejects.toThrow(
      /no Next or Skip left/,
    );
    expect(await repository.getRunEvents(run.id)).toHaveLength(1);
  });

  it('freezes a timetable version once a run has used it', async () => {
    await repository.createRun(ref, START);
    const changed = { ...simpleTimetable, name: 'Renamed plan' };

    await expect(repository.saveTimetable(changed)).rejects.toThrow(/cannot be changed/);
    expect((await repository.getTimetable('test-plan', 1)).name).toBe('Test plan');
  });

  it('allows re-seeding an identical definition', async () => {
    await repository.createRun(ref, START);
    await expect(repository.saveTimetable(simpleTimetable)).resolves.toBeUndefined();
  });

  it('exports and restores the whole database', async () => {
    const run = await repository.createRun(ref, START);
    await advance('next', new Date('2026-03-02T00:30:00.000Z'));
    const exported = await repository.exportAll();

    const restored = create();
    await restored.replaceAll(exported);

    expect((await restored.listTimetables()).length).toBe(2);
    expect((await restored.getRunEvents(run.id)).length).toBe(3);
    expect((await restored.getActiveRun())?.id).toBe(run.id);
  });

  it('replaces rather than merges on restore', async () => {
    await repository.createRun(ref, START);
    await repository.replaceAll({ timetables: [simpleTimetable], runs: [], events: [] });

    expect(await repository.listRuns()).toEqual([]);
    expect(await repository.getActiveRun()).toBeNull();
    expect(await repository.listTimetables()).toHaveLength(1);
  });
});

describe('IndexedDbRepository durability', () => {
  it('restores the active run through a fresh connection', async () => {
    const name = `quartz-durability-${Date.now()}`;
    const first = new IndexedDbRepository(name, sequentialIdGenerator());
    await first.saveTimetable(simpleTimetable);
    const run = await first.createRun(ref, START);
    await first.appendTransition({
      runId: run.id,
      kind: 'next',
      occurredAt: new Date('2026-03-02T00:30:00.000Z'),
      expectedItemId: 'wake',
      expectedSeq: 1,
    });
    first.close();

    // A new connection stands in for a page refresh or a browser restart.
    const second = new IndexedDbRepository(name, sequentialIdGenerator());
    const active = await second.getActiveRun();

    expect(active?.id).toBe(run.id);
    const events = await second.getRunEvents(run.id);
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({ itemId: 'gym', type: 'started' });
    second.close();
  });

  it('reports an explicit failure when IndexedDB is unavailable', async () => {
    const repository = new IndexedDbRepository('quartz-missing', sequentialIdGenerator(), null);
    await expect(repository.listTimetables()).rejects.toThrow(/cannot reach the browser database/);
  });
});
