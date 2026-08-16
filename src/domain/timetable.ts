/**
 * Runtime validation for timetable definitions.
 *
 * Bundled JSON is untrusted input: it is authored by hand and may also arrive
 * through a backup file. Every rule the specification states is enforced here so
 * a malformed plan can never reach storage or the measurement engine.
 */

import { QuartzError } from './errors';
import { formatClockTime, isValidTimezone, parseClockTime } from './time';
import type { Timetable, TimetableItem, TimetableSummary } from './types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const validateItem = (
  raw: unknown,
  index: number,
  errors: string[],
  seenItemIds: Set<string>,
): TimetableItem | null => {
  const at = `items[${index}]`;
  if (!isRecord(raw)) {
    errors.push(`${at} must be an object`);
    return null;
  }

  const { id, label, plannedStart, plannedEnd } = raw;

  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    errors.push(`${at}.id must be a lowercase kebab-case string`);
  } else if (seenItemIds.has(id)) {
    errors.push(`${at}.id "${id}" is duplicated; item IDs must be unique within a timetable`);
  } else {
    seenItemIds.add(id);
  }

  if (typeof label !== 'string' || label.trim().length === 0) {
    errors.push(`${at}.label must be a non-empty string`);
  }

  let startMinutes: number | null = null;
  let endMinutes: number | null = null;
  try {
    if (typeof plannedStart !== 'string') throw new QuartzError('invalid-timetable', 'not a string');
    startMinutes = parseClockTime(plannedStart);
  } catch {
    errors.push(`${at}.plannedStart must be an HH:mm time`);
  }
  try {
    if (typeof plannedEnd !== 'string') throw new QuartzError('invalid-timetable', 'not a string');
    endMinutes = parseClockTime(plannedEnd);
  } catch {
    errors.push(`${at}.plannedEnd must be an HH:mm time`);
  }

  if (startMinutes !== null && endMinutes !== null && startMinutes === endMinutes) {
    errors.push(
      `${at} has a zero-length planned duration (${formatClockTime(startMinutes)}); ` +
        'planned durations must be positive',
    );
  }

  if (errors.length > 0) return null;

  return {
    id: id as string,
    label: (label as string).trim(),
    plannedStart: plannedStart as string,
    plannedEnd: plannedEnd as string,
  };
};

/** Parse and validate a timetable definition, or throw an explicit error. */
export const parseTimetable = (raw: unknown, source = 'timetable'): Timetable => {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    throw new QuartzError('invalid-timetable', `${source} must be a JSON object`);
  }

  const { id, name, version, timezone, items } = raw;

  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    errors.push('id must be a lowercase kebab-case string');
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    errors.push('name must be a non-empty string');
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    errors.push('version must be an integer of at least 1');
  }
  if (typeof timezone !== 'string' || !isValidTimezone(timezone)) {
    errors.push(`timezone must be a valid IANA timezone, got ${JSON.stringify(timezone)}`);
  }
  if (!Array.isArray(items) || items.length === 0) {
    errors.push('items must be a non-empty ordered array');
  }

  const parsedItems: TimetableItem[] = [];
  if (Array.isArray(items)) {
    const seenItemIds = new Set<string>();
    items.forEach((item, index) => {
      const parsed = validateItem(item, index, errors, seenItemIds);
      if (parsed) parsedItems.push(parsed);
    });
  }

  if (errors.length > 0) {
    throw new QuartzError('invalid-timetable', `${source} is not a valid timetable`, errors);
  }

  return {
    id: id as string,
    name: (name as string).trim(),
    version: version as number,
    timezone: timezone as string,
    items: parsedItems,
  };
};

export const timetableKey = (id: string, version: number): string => `${id}@${version}`;

export const toSummary = (timetable: Timetable): TimetableSummary => {
  const first = timetable.items[0];
  const last = timetable.items[timetable.items.length - 1];
  return {
    id: timetable.id,
    name: timetable.name,
    version: timetable.version,
    timezone: timetable.timezone,
    itemCount: timetable.items.length,
    firstPlannedStart: first ? first.plannedStart : '00:00',
    lastPlannedEnd: last ? last.plannedEnd : '00:00',
  };
};

export const findItemIndex = (timetable: Timetable, itemId: string): number =>
  timetable.items.findIndex((item) => item.id === itemId);

/**
 * Reject a set of definitions that contains the same `(id, version)` twice.
 * Two definitions sharing a key would make historical runs ambiguous.
 */
export const assertUniqueVersions = (timetables: readonly Timetable[]): void => {
  const seen = new Map<string, Timetable>();
  for (const timetable of timetables) {
    const key = timetableKey(timetable.id, timetable.version);
    if (seen.has(key)) {
      throw new QuartzError(
        'invalid-timetable',
        `Duplicate timetable definition for ${key}`,
        ['Each (id, version) pair must appear exactly once.'],
      );
    }
    seen.set(key, timetable);
  }
};

/** Structural equality, used to detect an attempt to change a published version. */
export const timetablesEqual = (a: Timetable, b: Timetable): boolean =>
  a.id === b.id &&
  a.version === b.version &&
  a.name === b.name &&
  a.timezone === b.timezone &&
  a.items.length === b.items.length &&
  a.items.every((item, index) => {
    const other = b.items[index];
    return (
      other !== undefined &&
      item.id === other.id &&
      item.label === other.label &&
      item.plannedStart === other.plannedStart &&
      item.plannedEnd === other.plannedEnd
    );
  });
