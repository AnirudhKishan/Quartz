/**
 * Timezone-aware conversion between a timetable's planned local times and UTC
 * instants. Implemented on `Intl.DateTimeFormat` so there is no date library
 * dependency and no ambient timezone assumption.
 *
 * Every conversion in the application must go through this module.
 */

import { QuartzError } from './errors';

export interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timezone: string): Intl.DateTimeFormat => {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw new QuartzError('invalid-timetable', `Unknown IANA timezone: ${timezone}`);
  }
  formatterCache.set(timezone, formatter);
  return formatter;
};

export const isValidTimezone = (timezone: string): boolean => {
  try {
    formatterFor(timezone);
    return true;
  } catch {
    return false;
  }
};

/** Wall-clock parts of `instant` as observed in `timezone`. */
export const getLocalParts = (instant: Date, timezone: string): LocalDateParts => {
  const parts = formatterFor(timezone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    if (!found) throw new QuartzError('invalid-timetable', `Missing ${type} for ${timezone}`);
    return Number(found.value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
};

/** Offset in milliseconds that `timezone` is ahead of UTC at `instant`. */
export const getTimezoneOffsetMs = (instant: Date, timezone: string): number => {
  const parts = getLocalParts(instant, timezone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // The formatter does not emit milliseconds, so compare at whole-second resolution.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
};

/** The `YYYY-MM-DD` local calendar date of `instant` in `timezone`. */
export const getLocalDate = (instant: Date, timezone: string): string => {
  const { year, month, day } = getLocalParts(instant, timezone);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
};

const pad = (value: number, length: number): string => String(value).padStart(length, '0');

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

export const parseLocalDate = (localDate: string): { year: number; month: number; day: number } => {
  const match = DATE_PATTERN.exec(localDate);
  if (!match) {
    throw new QuartzError('invalid-timetable', `Local date must be YYYY-MM-DD, got "${localDate}"`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new QuartzError('invalid-timetable', `Local date is not a real date: "${localDate}"`);
  }
  return { year, month, day };
};

/** Minutes since local midnight for an `HH:mm` planned time. */
export const parseClockTime = (clock: string): number => {
  const match = TIME_PATTERN.exec(clock);
  if (!match) {
    throw new QuartzError('invalid-timetable', `Planned time must be HH:mm, got "${clock}"`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new QuartzError('invalid-timetable', `Planned time is out of range: "${clock}"`);
  }
  return hour * 60 + minute;
};

export const formatClockTime = (minutesFromMidnight: number): string => {
  const normalized = ((minutesFromMidnight % 1440) + 1440) % 1440;
  return `${pad(Math.floor(normalized / 60), 2)}:${pad(normalized % 60, 2)}`;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve a wall-clock local time in `timezone` to a UTC instant.
 *
 * `dayOffset` shifts the calendar day forward, which is how planned times that
 * cross midnight are expressed.
 *
 * The offsets in force a day either side of the target are used as candidates,
 * and a candidate is accepted only if it maps back to the requested wall-clock
 * time. That makes daylight-saving handling explicit rather than emergent:
 *
 * - Ambiguous local time (autumn overlap): both candidates are valid and the
 *   earlier instant is returned, i.e. the first time the clock reads that value.
 * - Nonexistent local time (spring-forward gap): no candidate is valid and the
 *   instant the clock jumps to is returned.
 *
 * Both outcomes are deterministic, which is what measurement requires.
 */
export const zonedLocalTimeToUtc = (
  localDate: string,
  minutesFromMidnight: number,
  timezone: string,
  dayOffset = 0,
): Date => {
  const { year, month, day } = parseLocalDate(localDate);
  const target = Date.UTC(year, month - 1, day + dayOffset, 0, 0, 0) + minutesFromMidnight * 60_000;

  const offsetBefore = getTimezoneOffsetMs(new Date(target - ONE_DAY_MS), timezone);
  const offsetAfter = getTimezoneOffsetMs(new Date(target + ONE_DAY_MS), timezone);
  const candidateOffsets =
    offsetBefore === offsetAfter ? [offsetBefore] : [offsetBefore, offsetAfter];

  const valid: number[] = [];
  for (const offset of candidateOffsets) {
    const instant = target - offset;
    if (getTimezoneOffsetMs(new Date(instant), timezone) === offset) valid.push(instant);
  }

  if (valid.length > 0) return new Date(Math.min(...valid));
  return new Date(target - offsetBefore);
};

export const addDaysToLocalDate = (localDate: string, days: number): string => {
  const { year, month, day } = parseLocalDate(localDate);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1, 2)}-${pad(
    shifted.getUTCDate(),
    2,
  )}`;
};
