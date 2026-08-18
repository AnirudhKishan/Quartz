/**
 * Measurement engine.
 *
 * Nothing here is ever persisted. Every number is recomputed from the currently
 * stored timetable definition plus the run's effective event history.
 */

import { reconstructRunState } from './runState';
import { parseClockTime, zonedLocalTimeToUtc } from './time';
import type {
  ActivitySegment,
  Run,
  RunEvent,
  Timetable,
  TimetableItem,
  TrackedOccurrence,
} from './types';

export interface PlannedItem {
  readonly item: TimetableItem;
  readonly index: number;
  readonly plannedStartUtc: Date;
  readonly plannedEndUtc: Date;
  readonly plannedDurationMs: number;
}

/**
 * Resolve every planned time to a UTC instant on the run's local day.
 *
 * A timetable may cross midnight. An item whose planned start is earlier in the
 * day than the previous item's start rolls onto the following calendar day, and
 * an item whose planned end is not after its planned start ends on the day after
 * it starts. Durations are measured between the resolved instants, so a
 * daylight-saving change inside an item is reflected in its planned duration.
 */
export const computePlannedSchedule = (
  timetable: Timetable,
  localDate: string,
): PlannedItem[] => {
  const planned: PlannedItem[] = [];
  let dayOffset = 0;
  let previousStartMinutes = -1;

  timetable.items.forEach((item, index) => {
    const startMinutes = parseClockTime(item.plannedStart);
    const endMinutes = parseClockTime(item.plannedEnd);

    if (startMinutes < previousStartMinutes) dayOffset += 1;
    previousStartMinutes = startMinutes;

    const plannedStartUtc = zonedLocalTimeToUtc(
      localDate,
      startMinutes,
      timetable.timezone,
      dayOffset,
    );
    const plannedEndUtc = zonedLocalTimeToUtc(
      localDate,
      endMinutes,
      timetable.timezone,
      endMinutes <= startMinutes ? dayOffset + 1 : dayOffset,
    );

    planned.push({
      item,
      index,
      plannedStartUtc,
      plannedEndUtc,
      plannedDurationMs: plannedEndUtc.getTime() - plannedStartUtc.getTime(),
    });
  });

  return planned;
};

export interface ItemObservation extends PlannedItem {
  readonly runId: string;
  readonly localDate: string;
  readonly timetableId: string;
  readonly timetableVersion: number;
  /** False when the run never got this far. */
  readonly reached: boolean;
  readonly skipped: boolean;
  readonly actualStart: Date | null;
  readonly actualEnd: Date | null;
  /** Positive means the item started late. Null for skipped or unreached items. */
  readonly startDeviationMs: number | null;
  readonly actualDurationMs: number | null;
  /** Positive means the item took longer than planned. */
  readonly durationDeviationMs: number | null;
  /** Overrun only. Skipped items contribute zero and never offset an overrun. */
  readonly positiveDurationDeviationMs: number;
  readonly executionIndex: number;
  readonly reordered: boolean;
  readonly segments: readonly ActivitySegment[];
  readonly segmentCount: number;
}

export interface InsertedActivityObservation {
  readonly occurrence: TrackedOccurrence;
  readonly segments: readonly ActivitySegment[];
  readonly actualStart: Date;
  readonly actualEnd: Date | null;
  readonly actualDurationMs: number | null;
  readonly segmentCount: number;
}

export interface ChronologicalSegmentObservation extends ActivitySegment {
  readonly occurrence: TrackedOccurrence;
}

export interface BetweenTaskObservation {
  readonly afterItemId: string;
  readonly beforeItemId: string;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly durationMs: number;
}

export interface RunReport {
  readonly run: Run;
  readonly timetable: Timetable;
  readonly observations: readonly ItemObservation[];
  readonly insertedObservations: readonly InsertedActivityObservation[];
  readonly chronologicalSegments: readonly ChronologicalSegmentObservation[];
  /** Actual day start minus the first item's planned start. */
  readonly dayStartDeviationMs: number;
  /** Actual completion minus the last item's planned end; null while active. */
  readonly finalCompletionDeviationMs: number | null;
  readonly reachedCount: number;
  readonly skippedCount: number;
  readonly measuredCount: number;
  readonly skipRate: number;
  readonly totalPositiveDurationDeviationMs: number;
  readonly betweenTasks: readonly BetweenTaskObservation[];
  readonly totalBetweenTasksMs: number;
  readonly totalInsertedDurationMs: number;
  readonly reordered: boolean;
}

export const buildRunReport = (
  timetable: Timetable,
  run: Run,
  events: readonly RunEvent[],
): RunReport => {
  const state = reconstructRunState(timetable, run, events);
  const planned = computePlannedSchedule(timetable, run.localDate);
  const plannedById = new Map(planned.map((item) => [item.item.id, item]));
  const occurrenceById = new Map(
    state.occurrences.map((occurrence) => [occurrence.id, occurrence]),
  );
  const segmentsByOccurrence = new Map<string, ActivitySegment[]>();
  state.segments.forEach((segment) => {
    const list = segmentsByOccurrence.get(segment.occurrenceId) ?? [];
    list.push(segment);
    segmentsByOccurrence.set(segment.occurrenceId, list);
  });
  const completedIds = new Set(state.completedOccurrenceIds);
  const skippedIds = new Set(state.skippedOccurrenceIds);

  const observations: ItemObservation[] = state.orderedItems.map((item, executionIndex) => {
    const plan = plannedById.get(item.id);
    if (!plan) throw new Error(`Missing planned item ${item.id}`);
    const segments = segmentsByOccurrence.get(item.id) ?? [];
    const actualStart = segments[0]?.startedAt ?? null;
    const reached = segments.length > 0;
    const skipped = skippedIds.has(item.id);
    const finished = completedIds.has(item.id);
    const lastSegment = segments[segments.length - 1];
    const actualEnd = finished && !skipped ? (lastSegment?.endedAt ?? null) : null;
    const measurable = reached && !skipped;
    const reordered = executionIndex !== plan.index;
    const firstSegmentIndex = state.segments.findIndex(
      (segment) => segment.occurrenceId === item.id,
    );
    const precedingSegment =
      firstSegmentIndex > 0 ? state.segments[firstSegmentIndex - 1] : undefined;
    const precededByInserted =
      precedingSegment !== undefined &&
      occurrenceById.get(precedingSegment.occurrenceId)?.kind === 'inserted';
    const startDeviationMs =
      measurable && actualStart && !reordered && !precededByInserted
        ? actualStart.getTime() - plan.plannedStartUtc.getTime()
        : null;
    const actualDurationMs =
      measurable && finished && segments.every((segment) => segment.endedAt !== null)
        ? segments.reduce(
            (total, segment) =>
              total + (segment.endedAt!.getTime() - segment.startedAt.getTime()),
            0,
          )
        : null;
    const durationDeviationMs =
      actualDurationMs === null ? null : actualDurationMs - plan.plannedDurationMs;

    return {
      ...plan,
      runId: run.id,
      localDate: run.localDate,
      timetableId: timetable.id,
      timetableVersion: timetable.version,
      reached,
      skipped,
      actualStart,
      actualEnd,
      startDeviationMs,
      actualDurationMs,
      durationDeviationMs,
      positiveDurationDeviationMs:
        durationDeviationMs !== null && durationDeviationMs > 0 ? durationDeviationMs : 0,
      executionIndex,
      reordered,
      segments,
      segmentCount: segments.length,
    };
  });

  const betweenTasks: BetweenTaskObservation[] = [];
  state.segments.forEach((segment, index) => {
    if (!segment.endedAt) return;
    const next = state.segments[index + 1];
    if (!next) return;
    const durationMs = next.startedAt.getTime() - segment.endedAt.getTime();
    if (durationMs <= 0) return;
    betweenTasks.push({
      afterItemId: segment.occurrenceId,
      beforeItemId: next.occurrenceId,
      startedAt: segment.endedAt,
      endedAt: next.startedAt,
      durationMs,
    });
  });

  const insertedObservations: InsertedActivityObservation[] = state.occurrences
    .filter((occurrence) => occurrence.kind === 'inserted')
    .map((occurrence) => {
      const segments = segmentsByOccurrence.get(occurrence.id) ?? [];
      const first = segments[0];
      if (!first) throw new Error(`Inserted occurrence ${occurrence.id} has no segment`);
      const finished = completedIds.has(occurrence.id);
      const last = segments[segments.length - 1];
      const actualEnd = finished ? (last?.endedAt ?? null) : null;
      const actualDurationMs =
        finished && segments.every((segment) => segment.endedAt !== null)
          ? segments.reduce(
              (total, segment) =>
                total + (segment.endedAt!.getTime() - segment.startedAt.getTime()),
              0,
            )
          : null;
      return {
        occurrence,
        segments,
        actualStart: first.startedAt,
        actualEnd,
        actualDurationMs,
        segmentCount: segments.length,
      };
    });
  const chronologicalSegments: ChronologicalSegmentObservation[] = state.segments.map(
    (segment) => {
      const occurrence = occurrenceById.get(segment.occurrenceId);
      if (!occurrence) throw new Error(`Segment ${segment.id} has no occurrence`);
      return { ...segment, occurrence };
    },
  );

  const firstPlanned = planned[0];
  const lastPlanned = planned[planned.length - 1];

  const reachedCount = observations.filter((o) => o.reached).length;
  const skippedCount = observations.filter((o) => o.skipped).length;
  const measuredCount = observations.filter((o) => o.durationDeviationMs !== null).length;

  return {
    run,
    timetable,
    observations,
    insertedObservations,
    chronologicalSegments,
    dayStartDeviationMs: firstPlanned
      ? run.startedAt.getTime() - firstPlanned.plannedStartUtc.getTime()
      : 0,
    finalCompletionDeviationMs:
      run.completedAt && lastPlanned
        ? run.completedAt.getTime() - lastPlanned.plannedEndUtc.getTime()
        : null,
    reachedCount,
    skippedCount,
    measuredCount,
    skipRate: reachedCount === 0 ? 0 : skippedCount / reachedCount,
    totalPositiveDurationDeviationMs: observations.reduce(
      (total, o) => total + o.positiveDurationDeviationMs,
      0,
    ),
    betweenTasks,
    totalBetweenTasksMs: betweenTasks.reduce((total, gap) => total + gap.durationMs, 0),
    totalInsertedDurationMs: insertedObservations.reduce(
      (total, observation) => total + (observation.actualDurationMs ?? 0),
      0,
    ),
    reordered: observations.some((observation) => observation.reordered),
  };
};

export const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (lower === undefined || upper === undefined) return null;
  return (lower + upper) / 2;
};

export interface ItemAggregate {
  readonly itemId: string;
  readonly label: string;
  /** Non-skipped observations with a measurable duration. */
  readonly observations: number;
  readonly medianStartDeviationMs: number | null;
  readonly medianDurationDeviationMs: number | null;
  readonly totalPositiveDurationDeviationMs: number;
  readonly skipCount: number;
  readonly skipRate: number;
}

export interface AggregateReport {
  readonly timetableId: string;
  readonly timetableName: string;
  readonly runCount: number;
  readonly versions: readonly number[];
  /** Ranked by total positive duration deviation, descending. */
  readonly items: readonly ItemAggregate[];
  readonly totalPositiveDurationDeviationMs: number;
  readonly medianDayStartDeviationMs: number | null;
  readonly medianFinalCompletionDeviationMs: number | null;
}

interface Bucket {
  label: string;
  latestVersion: number;
  startDeviations: number[];
  durationDeviations: number[];
  totalPositive: number;
  skipCount: number;
  firstSeenIndex: number;
}

/**
 * Combine runs of the same timetable ID, grouped by stable item ID so an item
 * keeps its history across timetable versions.
 */
export const buildAggregateReport = (
  timetableId: string,
  timetableName: string,
  reports: readonly RunReport[],
): AggregateReport => {
  const buckets = new Map<string, Bucket>();
  const versions = new Set<number>();

  reports.forEach((report) => {
    versions.add(report.timetable.version);
    report.observations.forEach((observation) => {
      if (!observation.reached) return;

      let bucket = buckets.get(observation.item.id);
      if (!bucket) {
        bucket = {
          label: observation.item.label,
          latestVersion: observation.timetableVersion,
          startDeviations: [],
          durationDeviations: [],
          totalPositive: 0,
          skipCount: 0,
          firstSeenIndex: observation.index,
        };
        buckets.set(observation.item.id, bucket);
      }

      // The newest version wins the display label.
      if (observation.timetableVersion >= bucket.latestVersion) {
        bucket.latestVersion = observation.timetableVersion;
        bucket.label = observation.item.label;
      }

      if (observation.skipped) {
        bucket.skipCount += 1;
        return;
      }
      if (observation.startDeviationMs !== null) {
        bucket.startDeviations.push(observation.startDeviationMs);
      }
      if (observation.durationDeviationMs !== null) {
        bucket.durationDeviations.push(observation.durationDeviationMs);
        bucket.totalPositive += observation.positiveDurationDeviationMs;
      }
    });
  });

  const items: ItemAggregate[] = [...buckets.entries()].map(([itemId, bucket]) => {
    const observations = bucket.durationDeviations.length;
    const denominator = observations + bucket.skipCount;
    return {
      itemId,
      label: bucket.label,
      observations,
      medianStartDeviationMs: median(bucket.startDeviations),
      medianDurationDeviationMs: median(bucket.durationDeviations),
      totalPositiveDurationDeviationMs: bucket.totalPositive,
      skipCount: bucket.skipCount,
      skipRate: denominator === 0 ? 0 : bucket.skipCount / denominator,
    };
  });

  // "Steps causing deviation": items that repeatedly overrun rank highest.
  items.sort((a, b) => {
    if (b.totalPositiveDurationDeviationMs !== a.totalPositiveDurationDeviationMs) {
      return b.totalPositiveDurationDeviationMs - a.totalPositiveDurationDeviationMs;
    }
    const bMedian = b.medianDurationDeviationMs ?? -Infinity;
    const aMedian = a.medianDurationDeviationMs ?? -Infinity;
    if (bMedian !== aMedian) return bMedian - aMedian;
    return a.itemId.localeCompare(b.itemId);
  });

  const completed = reports.filter((report) => report.finalCompletionDeviationMs !== null);

  return {
    timetableId,
    timetableName,
    runCount: reports.length,
    versions: [...versions].sort((a, b) => a - b),
    items,
    totalPositiveDurationDeviationMs: reports.reduce(
      (total, report) => total + report.totalPositiveDurationDeviationMs,
      0,
    ),
    medianDayStartDeviationMs: median(reports.map((report) => report.dayStartDeviationMs)),
    medianFinalCompletionDeviationMs: median(
      completed.map((report) => report.finalCompletionDeviationMs as number),
    ),
  };
};
