/**
 * Versioned backup document.
 *
 * A backup is the only way data survives an uninstall, a cleared origin, or a
 * lost device, so it must round-trip everything and must never be applied
 * partially. Validation happens in full before any write.
 */

import { QuartzError } from './errors';
import { reconstructRunState } from './runState';
import { assertUniqueVersions, parseTimetable, timetableKey } from './timetable';
import type { Run, RunEvent, Timetable } from './types';

export const BACKUP_FORMAT = 'quartz.backup';
export const BACKUP_VERSION = 1;

export interface BackupData {
  readonly timetables: readonly Timetable[];
  readonly runs: readonly Run[];
  readonly events: readonly RunEvent[];
}

export interface BackupDocument extends BackupData {
  readonly format: typeof BACKUP_FORMAT;
  readonly version: number;
  readonly exportedAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toIso = (value: Date): string => value.toISOString();

const parseInstant = (value: unknown, at: string, errors: string[]): Date | null => {
  if (typeof value !== 'string') {
    errors.push(`${at} must be an ISO 8601 timestamp string`);
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    errors.push(`${at} is not a valid timestamp: "${value}"`);
    return null;
  }
  return parsed;
};

export const createBackupDocument = (data: BackupData, exportedAt: Date): unknown => ({
  format: BACKUP_FORMAT,
  version: BACKUP_VERSION,
  exportedAt: toIso(exportedAt),
  timetables: data.timetables,
  runs: data.runs.map((run) => ({
    ...run,
    startedAt: toIso(run.startedAt),
    completedAt: run.completedAt ? toIso(run.completedAt) : null,
  })),
  events: data.events.map((event) => ({
    ...event,
    occurredAt: toIso(event.occurredAt),
  })),
});

const EVENT_TYPES = new Set(['started', 'completed', 'skipped', 'undo']);

/**
 * Validate an untrusted backup document completely.
 *
 * Structure, referential integrity, and every event history are checked. A
 * document that would not reconstruct is rejected before it can replace data.
 */
export const parseBackupDocument = (raw: unknown): BackupData => {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    throw new QuartzError('invalid-backup', 'The backup file must contain a JSON object.');
  }
  if (raw.format !== BACKUP_FORMAT) {
    throw new QuartzError(
      'invalid-backup',
      'This file is not a Quartz backup.',
      [`Expected format "${BACKUP_FORMAT}" but found ${JSON.stringify(raw.format)}.`],
    );
  }
  if (raw.version !== BACKUP_VERSION) {
    throw new QuartzError(
      'invalid-backup',
      `Unsupported backup version ${String(raw.version)}.`,
      [`This build can restore backup version ${BACKUP_VERSION}.`],
    );
  }
  if (!Array.isArray(raw.timetables) || !Array.isArray(raw.runs) || !Array.isArray(raw.events)) {
    throw new QuartzError(
      'invalid-backup',
      'The backup must contain timetables, runs, and events arrays.',
    );
  }

  const timetables: Timetable[] = [];
  raw.timetables.forEach((entry, index) => {
    try {
      timetables.push(parseTimetable(entry, `timetables[${index}]`));
    } catch (error) {
      if (error instanceof QuartzError) {
        errors.push(error.message, ...error.details);
      } else {
        errors.push(`timetables[${index}] could not be read`);
      }
    }
  });
  try {
    assertUniqueVersions(timetables);
  } catch (error) {
    if (error instanceof QuartzError) errors.push(error.message);
  }

  const timetableIndex = new Map(timetables.map((t) => [timetableKey(t.id, t.version), t]));

  const runs: Run[] = [];
  const seenRunIds = new Set<string>();
  raw.runs.forEach((entry, index) => {
    const at = `runs[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const { id, timetableId, timetableVersion, localDate, status } = entry;
    if (typeof id !== 'string' || id.length === 0) errors.push(`${at}.id must be a string`);
    else if (seenRunIds.has(id)) errors.push(`${at}.id "${id}" is duplicated`);
    else seenRunIds.add(id);

    if (typeof timetableId !== 'string') errors.push(`${at}.timetableId must be a string`);
    if (typeof timetableVersion !== 'number' || !Number.isInteger(timetableVersion)) {
      errors.push(`${at}.timetableVersion must be an integer`);
    }
    if (typeof localDate !== 'string') errors.push(`${at}.localDate must be a string`);
    if (status !== 'active' && status !== 'completed') {
      errors.push(`${at}.status must be "active" or "completed"`);
    }

    const startedAt = parseInstant(entry.startedAt, `${at}.startedAt`, errors);
    const completedAt =
      entry.completedAt === null || entry.completedAt === undefined
        ? null
        : parseInstant(entry.completedAt, `${at}.completedAt`, errors);

    if (
      typeof timetableId === 'string' &&
      typeof timetableVersion === 'number' &&
      !timetableIndex.has(timetableKey(timetableId, timetableVersion))
    ) {
      errors.push(
        `${at} references timetable ${timetableId}@${timetableVersion}, which the backup omits`,
      );
    }

    if (startedAt && typeof id === 'string') {
      runs.push({
        id,
        timetableId: timetableId as string,
        timetableVersion: timetableVersion as number,
        localDate: localDate as string,
        startedAt,
        completedAt,
        status: status as Run['status'],
      });
    }
  });

  const events: RunEvent[] = [];
  const seenEventIds = new Set<string>();
  raw.events.forEach((entry, index) => {
    const at = `events[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const { id, runId, itemId, type, transitionId, seq, reversesEventId } = entry;
    if (typeof id !== 'string' || id.length === 0) errors.push(`${at}.id must be a string`);
    else if (seenEventIds.has(id)) errors.push(`${at}.id "${id}" is duplicated`);
    else seenEventIds.add(id);

    if (typeof runId !== 'string' || !seenRunIds.has(runId)) {
      errors.push(`${at}.runId must reference a run in this backup`);
    }
    if (typeof itemId !== 'string') errors.push(`${at}.itemId must be a string`);
    if (typeof type !== 'string' || !EVENT_TYPES.has(type)) {
      errors.push(`${at}.type must be started, completed, skipped, or undo`);
    }
    if (typeof transitionId !== 'string') errors.push(`${at}.transitionId must be a string`);
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
      errors.push(`${at}.seq must be a positive integer`);
    }
    if (reversesEventId !== null && typeof reversesEventId !== 'string') {
      errors.push(`${at}.reversesEventId must be a string or null`);
    }

    const occurredAt = parseInstant(entry.occurredAt, `${at}.occurredAt`, errors);
    if (occurredAt && typeof id === 'string') {
      events.push({
        id,
        runId: runId as string,
        itemId: itemId as string,
        type: type as RunEvent['type'],
        occurredAt,
        reversesEventId: (reversesEventId ?? null) as string | null,
        transitionId: transitionId as string,
        seq: seq as number,
      });
    }
  });

  if (errors.length > 0) {
    throw new QuartzError('invalid-backup', 'The backup file is not valid.', errors);
  }

  // Every run must still reconstruct. This is the strongest guarantee available
  // and it reuses exactly the reducer the application runs against.
  const activeRuns = runs.filter((run) => run.status === 'active');
  if (activeRuns.length > 1) {
    throw new QuartzError('invalid-backup', 'The backup contains more than one active run.');
  }

  for (const run of runs) {
    const timetable = timetableIndex.get(timetableKey(run.timetableId, run.timetableVersion));
    if (!timetable) continue;
    const runEvents = events.filter((event) => event.runId === run.id);
    try {
      reconstructRunState(timetable, run, runEvents);
    } catch (error) {
      const detail = error instanceof QuartzError ? [error.message, ...error.details] : [];
      throw new QuartzError(
        'invalid-backup',
        `Run ${run.id} in the backup has an event history that cannot be reconstructed.`,
        detail,
      );
    }
  }

  return { timetables, runs, events };
};
