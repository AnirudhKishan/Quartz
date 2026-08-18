import { describe, expect, it } from 'vitest';

import { BackupService } from '../application/backupService';
import { InMemoryRepository } from '../infrastructure/memoryRepository';
import { sequentialIdGenerator } from './clock';
import { simpleTimetable } from '../test/fixtures';
import { RunDriver } from '../test/runDriver';
import { createBackupDocument, parseBackupDocument } from './backup';

const START = new Date('2026-03-02T00:00:00.000Z');

const populatedRepository = async () => {
  const repository = new InMemoryRepository(sequentialIdGenerator());
  await repository.saveTimetable(simpleTimetable);
  const run = await repository.createRun({ timetableId: 'test-plan', version: 1 }, START);
  await repository.appendTransition({
    runId: run.id,
    kind: 'next',
    occurredAt: new Date('2026-03-02T00:30:00.000Z'),
    expectedItemId: 'wake',
    expectedSeq: 1,
  });
  return { repository, run };
};

const validDocument = () => {
  const driver = new RunDriver(simpleTimetable, START).next(new Date('2026-03-02T00:30:00.000Z'));
  return createBackupDocument(
    { timetables: [simpleTimetable], runs: [driver.run], events: driver.events },
    new Date('2026-03-02T03:00:00.000Z'),
  ) as Record<string, unknown>;
};

describe('parseBackupDocument', () => {
  it('round-trips timetables, runs, and events', () => {
    const parsed = parseBackupDocument(validDocument());

    expect(parsed.timetables).toHaveLength(1);
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.events).toHaveLength(3);
    expect(parsed.runs[0]?.startedAt.toISOString()).toBe('2026-03-02T00:00:00.000Z');
    expect(parsed.events[0]?.occurredAt).toBeInstanceOf(Date);
  });

  it('rejects a file that is not a Quartz backup', () => {
    expect(() => parseBackupDocument({ format: 'something-else', version: 1 })).toThrow(
      /not a Quartz backup/,
    );
  });

  it('rejects an unsupported backup version', () => {
    expect(() => parseBackupDocument({ ...validDocument(), version: 99 })).toThrow(
      /Unsupported backup version 99/,
    );
  });

  it('restores version 1 runs in original timetable order', () => {
    const document = validDocument();
    const runs = (document.runs as Record<string, unknown>[]).map(
      ({ executionOrder: _executionOrder, ...run }) => run,
    );
    const parsed = parseBackupDocument({ ...document, version: 1, runs });
    expect(parsed.runs[0]?.executionOrder).toBeNull();
  });

  it('rejects a run whose timetable version is missing', () => {
    expect(() => parseBackupDocument({ ...validDocument(), timetables: [] })).toThrow(
      /not valid/,
    );
  });

  it('rejects duplicate event IDs', () => {
    const document = validDocument();
    const events = document.events as unknown[];
    expect(() =>
      parseBackupDocument({ ...document, events: [...events, events[0]] }),
    ).toThrow(/not valid/);
  });

  it('rejects an event history that cannot be reconstructed', () => {
    const document = validDocument();
    const events = (document.events as Record<string, unknown>[]).map((event, index) =>
      index === 1 ? { ...event, type: 'started' } : event,
    );
    expect(() => parseBackupDocument({ ...document, events })).toThrow(
      /cannot be reconstructed/,
    );
  });

  it('rejects a backup containing more than one active run', () => {
    const document = validDocument();
    const runs = document.runs as Record<string, unknown>[];
    const firstRun = runs[0]!;
    expect(() =>
      parseBackupDocument({
        ...document,
        runs: [firstRun, { ...firstRun, id: 'run-other' }],
      }),
    ).toThrow(/more than one active run/);
  });

  it('rejects a malformed timestamp', () => {
    const document = validDocument();
    const runs = document.runs as Record<string, unknown>[];
    expect(() =>
      parseBackupDocument({ ...document, runs: [{ ...runs[0], startedAt: 'not-a-date' }] }),
    ).toThrow(/not valid/);
  });
});

describe('BackupService', () => {
  it('exports a document that can be restored into an empty repository', async () => {
    const { repository, run } = await populatedRepository();
    const service = new BackupService(repository);
    const json = await service.exportToJson();

    const target = new InMemoryRepository(sequentialIdGenerator());
    const targetService = new BackupService(target);
    const preview = targetService.preview(json);

    expect(preview).toMatchObject({ timetableCount: 1, runCount: 1, eventCount: 3, hasActiveRun: true });
    await targetService.restore(preview);

    expect((await target.getActiveRun())?.id).toBe(run.id);
    expect(await target.getRunEvents(run.id)).toHaveLength(3);
  });

  it('leaves existing data untouched when the file is invalid', async () => {
    const { repository, run } = await populatedRepository();
    const service = new BackupService(repository);

    expect(() => service.preview('{ not json')).toThrow(/not valid JSON/);
    expect(() => service.preview('{"format":"quartz.backup","version":1}')).toThrow(
      /must contain timetables/,
    );

    expect((await repository.getActiveRun())?.id).toBe(run.id);
    expect(await repository.getRunEvents(run.id)).toHaveLength(3);
  });

  it('names the file with the backup version', async () => {
    const { repository } = await populatedRepository();
    const service = new BackupService(repository, { now: () => new Date('2026-03-02T04:05:06Z') });

    expect(service.suggestedFileName()).toBe('quartz-backup-v2-2026-03-02T04-05-06.json');
  });
});
