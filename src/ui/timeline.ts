const MIN_SECTION_HEIGHT = 96;
const MAX_SECTION_HEIGHT = 190;

export const timelineSectionHeight = (plannedDurationMs: number): number => {
  const minutes = Math.max(1, plannedDurationMs / 60_000);
  return Math.round(
    Math.min(MAX_SECTION_HEIGHT, Math.max(MIN_SECTION_HEIGHT, 45 + Math.sqrt(minutes) * 7)),
  );
};

export interface TimelineClockInterval {
  readonly id: string;
  readonly durationMs: number;
}

export interface TimelineClockPosition {
  readonly id: string;
  readonly fraction: number;
}

export const locateTimelineClock = (
  intervals: readonly TimelineClockInterval[],
  elapsedMs: number,
): TimelineClockPosition | null => {
  if (intervals.length === 0) return null;
  let remaining = Math.max(0, elapsedMs);

  for (let index = 0; index < intervals.length; index += 1) {
    const interval = intervals[index];
    if (!interval) continue;
    const durationMs = Math.max(1, interval.durationMs);
    const last = index === intervals.length - 1;
    if (remaining < durationMs || last) {
      return { id: interval.id, fraction: remaining / durationMs };
    }
    remaining -= durationMs;
  }

  return null;
};
