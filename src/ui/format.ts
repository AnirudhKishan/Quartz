/** Presentation helpers. These never make measurement decisions. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A duration such as "1h 15m" or "45s". Always non-negative. */
export const formatDuration = (ms: number): string => {
  const total = Math.abs(Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) return `${hours}h ${String(mins).padStart(2, '0')}m`;
  if (mins > 0) return `${mins}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
};

/** A running clock such as "01:23:45", used for elapsed time. */
export const formatStopwatch = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const body = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${body}` : body;
};

/** A signed deviation such as "12m late", "5m early", or "on time". */
export const formatDeviation = (ms: number | null, unit: 'late' | 'longer' = 'late'): string => {
  if (ms === null) return '—';
  if (Math.abs(ms) < 30_000) return unit === 'late' ? 'on time' : 'as planned';
  const opposite = unit === 'late' ? 'early' : 'shorter';
  return `${formatDuration(ms)} ${ms > 0 ? unit : opposite}`;
};

export type DeviationTone = 'over' | 'under' | 'neutral';

export const deviationTone = (ms: number | null): DeviationTone => {
  if (ms === null || Math.abs(ms) < 30_000) return 'neutral';
  return ms > 0 ? 'over' : 'under';
};

/** Wall-clock time of an instant, read in the timetable's timezone. */
export const formatTimeInZone = (instant: Date, timezone: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);

/** A `YYYY-MM-DD` local date rendered as "Mon 2 Mar 2026". */
export const formatLocalDate = (localDate: string): string => {
  const [year, month, day] = localDate.split('-').map(Number);
  if (!year || !month || !day) return localDate;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, day)));
};

export const formatPercent = (rate: number): string => `${Math.round(rate * 100)}%`;

export const formatTotalPositive = (ms: number): string =>
  ms < MINUTE ? 'none' : formatDuration(ms);

export const millisecondsPerHour = HOUR;
