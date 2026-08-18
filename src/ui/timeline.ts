import type { PlannedItem } from '../domain/analysis';

const MIN_SECTION_HEIGHT = 96;
const MAX_SECTION_HEIGHT = 190;
export const TIMELINE_SNAP_MS = 5 * 60_000;
const MAGNETIC_RANGE_MS = 3 * 60_000;

export const timelineSectionHeight = (plannedDurationMs: number): number => {
  const minutes = Math.max(1, plannedDurationMs / 60_000);
  return Math.round(
    Math.min(MAX_SECTION_HEIGHT, Math.max(MIN_SECTION_HEIGHT, 45 + Math.sqrt(minutes) * 7)),
  );
};

export const instantFraction = (plan: PlannedItem, instant: Date): number | null => {
  const start = plan.plannedStartUtc.getTime();
  const end = plan.plannedEndUtc.getTime();
  const value = instant.getTime();
  if (value < start || value > end) return null;
  return Math.min(1, Math.max(0, (value - start) / (end - start)));
};

export interface TimelineDraftSegment {
  readonly startEventId: string;
  readonly endEventId: string | null;
  readonly start: number;
  readonly end: number | null;
}

export interface BoundaryMove {
  readonly updates: ReadonlyMap<string, number>;
  readonly magnetic: boolean;
}

export interface BoundaryLimits {
  readonly minimum?: number;
  readonly maximum?: number;
}

const snapToGrid = (value: number): number =>
  Math.round(value / TIMELINE_SNAP_MS) * TIMELINE_SNAP_MS;

/**
 * Move one segment edge while preserving chronological segment order.
 *
 * Moving toward a neighbor snaps to it. Crossing it carries only that immediate
 * edge, which resizes the adjacent segment instead of creating an overlap.
 */
export const moveTimelineBoundary = (
  segments: readonly TimelineDraftSegment[],
  segmentIndex: number,
  edge: 'start' | 'end',
  rawValue: number,
  dayMinimum: number,
  observedAt: number,
  limits: BoundaryLimits = {},
): BoundaryMove => {
  const segment = segments[segmentIndex];
  if (!segment) return { updates: new Map(), magnetic: false };
  const updates = new Map<string, number>();
  let value = snapToGrid(rawValue);
  let magnetic = false;

  if (edge === 'start') {
    const previous = segments[segmentIndex - 1];
    const maximum = Math.min(segment.end ?? observedAt, limits.maximum ?? Infinity);
    const minimum = Math.max(previous?.start ?? dayMinimum, limits.minimum ?? -Infinity);
    value = Math.min(maximum, Math.max(minimum, value));
    if (previous?.end !== null && previous?.end !== undefined) {
      if (Math.abs(value - previous.end) <= MAGNETIC_RANGE_MS) {
        value = previous.end;
        magnetic = true;
      } else if (value < previous.end && previous.endEventId) {
        updates.set(previous.endEventId, value);
      }
    }
    updates.set(segment.startEventId, value);
    return { updates, magnetic };
  }

  if (!segment.endEventId || segment.end === null) {
    return { updates, magnetic };
  }
  const next = segments[segmentIndex + 1];
  const minimum = Math.max(segment.start, limits.minimum ?? -Infinity);
  const maximum = Math.min(next?.end ?? observedAt, limits.maximum ?? Infinity);
  value = Math.min(maximum, Math.max(minimum, value));
  if (next) {
    if (Math.abs(value - next.start) <= MAGNETIC_RANGE_MS) {
      value = next.start;
      magnetic = true;
    } else if (value > next.start) {
      updates.set(next.startEventId, value);
    }
  }
  updates.set(segment.endEventId, value);
  return { updates, magnetic };
};
