import { Fragment, useLayoutEffect, useMemo, useRef } from 'react';

import { buildRunReport, computePlannedSchedule } from '../../domain/analysis';
import type { ActivitySegment, RunState, TrackedOccurrence } from '../../domain/types';
import {
  deviationTone,
  formatDeviation,
  formatStopwatch,
  formatTimeInZone,
} from '../format';
import { locateTimelineClock, timelineSectionHeight } from '../timeline';

export interface TimelineGap {
  readonly start: Date;
  readonly end: Date;
}

export interface DayTimelineProps {
  readonly state: RunState;
  readonly now: Date;
  readonly elapsedMs?: number;
  readonly selectedActivityId?: string | null;
  readonly onSelectActivity?: (
    activityId: string,
    anchorTop: number,
    trigger: HTMLElement,
  ) => void;
  readonly onSelectGap?: (
    gap: TimelineGap,
    anchorTop: number,
    trigger: HTMLElement,
  ) => void;
  readonly autoFocusCurrent?: boolean;
  readonly constrainHeight?: boolean;
}

const occurrenceFor = (state: RunState, id: string): TrackedOccurrence => {
  const occurrence = state.occurrences.find((candidate) => candidate.id === id);
  if (!occurrence) throw new Error(`Missing occurrence ${id}`);
  return occurrence;
};

export const DayTimeline = ({
  state,
  now,
  elapsedMs = 0,
  selectedActivityId = null,
  onSelectActivity,
  onSelectGap,
  autoFocusCurrent = false,
  constrainHeight = true,
}: DayTimelineProps) => {
  const clockRef = useRef<HTMLDivElement>(null);
  const report = useMemo(
    () => buildRunReport(state.timetable, state.run, state.events),
    [state],
  );
  const plannedSchedule = useMemo(
    () => computePlannedSchedule(state.timetable, state.run.localDate),
    [state.run.localDate, state.timetable],
  );
  const clockPosition = useMemo(() => {
    const origin = plannedSchedule[0]?.plannedStartUtc;
    if (state.status !== 'active' || !origin) return null;
    return locateTimelineClock(
      plannedSchedule.map((planned) => ({
        id: planned.item.id,
        durationMs: planned.plannedDurationMs,
      })),
      now.getTime() - origin.getTime(),
    );
  }, [now, plannedSchedule, state.status]);

  useLayoutEffect(() => {
    if (!autoFocusCurrent || !clockRef.current) return;
    clockRef.current.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [autoFocusCurrent, clockPosition?.id]);

  const select = (activityId: string, target: HTMLElement) => {
    onSelectActivity?.(activityId, target.getBoundingClientRect().top, target);
  };

  const renderCard = (
    segment: ActivitySegment,
    occurrence: TrackedOccurrence,
  ) => {
    const plan = report.observations.find(
      (observation) => observation.item.id === occurrence.plannedItemId,
    );
    const occurrenceSegments = state.segments.filter(
      (candidate) => candidate.occurrenceId === occurrence.id,
    );
    const occurrenceSegmentIndex =
      occurrenceSegments.findIndex((candidate) => candidate.id === segment.id) + 1;
    const current = segment.endEventId === null && state.currentActivity?.id === occurrence.id;
    const paused =
      segment.endType === 'paused' &&
      state.resumeTarget?.id === occurrence.id &&
      segment.id === occurrenceSegments[occurrenceSegments.length - 1]?.id;
    const itemState =
      segment.endType === 'skipped'
        ? 'skipped'
        : current
          ? 'current'
          : paused
            ? 'paused'
            : occurrence.kind === 'inserted'
              ? 'unplanned'
              : 'completed';
    const duration = Math.max(
      0,
      (segment.endedAt ?? now).getTime() - segment.startedAt.getTime(),
    );
    const sectionHeight = timelineSectionHeight(
      plan ? plan.plannedDurationMs / Math.max(1, occurrenceSegments.length) : duration,
    );
    const clockSegment =
      plan?.item.id === clockPosition?.id && clockPosition
        ? Math.min(
            occurrenceSegments.length - 1,
            Math.floor(Math.max(0, clockPosition.fraction) * occurrenceSegments.length),
          )
        : null;
    const ownsClock = occurrenceSegmentIndex - 1 === clockSegment;
    const clockFraction =
      clockPosition && clockSegment !== null
        ? clockPosition.fraction * occurrenceSegments.length - clockSegment
        : null;

    return (
      <li
        className={`timeline-item timeline-item--${itemState}${
          selectedActivityId === occurrence.id ? ' timeline-item--selected' : ''
        }`}
        style={{ minHeight: `${sectionHeight}px` }}
        key={segment.id}
      >
        <span className="timeline-item__rail" aria-hidden="true">
          <span className="timeline-item__node" />
        </span>
        <article
          className="timeline-item__card"
          role="button"
          tabIndex={0}
          aria-label={`Open ${occurrence.label} details`}
          onClick={(event) => select(occurrence.id, event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            select(occurrence.id, event.currentTarget);
          }}
        >
          <div className="timeline-item__heading">
            <h2>{occurrence.label}</h2>
            <div className="timeline-item__heading-actions">
              <span className="timeline-item__state">{itemState}</span>
              {onSelectActivity && (
                <span className="timeline-item__chevron" aria-hidden="true">
                  ›
                </span>
              )}
            </div>
          </div>
          {plan && (
            <p className="timeline-item__planned">
              Planned {plan.item.plannedStart}–{plan.item.plannedEnd}
            </p>
          )}
          {occurrence.kind === 'inserted' && (
            <p className="timeline-item__planned">Unplanned activity</p>
          )}
          {occurrenceSegments.length > 1 && (
            <p className="timeline-item__segment-count">
              Segment {occurrenceSegmentIndex} of {occurrenceSegments.length}
            </p>
          )}
          <p className="timeline-item__actual">
            Actual {formatTimeInZone(segment.startedAt, state.timetable.timezone)}
            {segment.endedAt
              ? `–${formatTimeInZone(segment.endedAt, state.timetable.timezone)}`
              : ''}
            {segment.endedAt ? ` · ${formatStopwatch(duration)}` : ''}
            {plan &&
              occurrenceSegmentIndex === 1 &&
              plan.startDeviationMs !== null && (
                <>
                  {' · '}
                  <span className={`tone--${deviationTone(plan.startDeviationMs)}`}>
                    {formatDeviation(plan.startDeviationMs)}
                  </span>
                </>
              )}
          </p>
          {plan &&
            occurrenceSegmentIndex === occurrenceSegments.length &&
            plan.durationDeviationMs !== null && (
              <p
                className={`timeline-item__actual tone--${deviationTone(
                  plan.durationDeviationMs,
                )}`}
              >
                Duration {formatDeviation(plan.durationDeviationMs, 'longer')}
                {plan.segmentCount > 1 ? ` · ${plan.segmentCount} segments` : ''}
              </p>
            )}
          {current && (
            <p className="timeline-item__elapsed" aria-label="Time in this step">
              {formatStopwatch(elapsedMs)}
            </p>
          )}
          {ownsClock && clockPosition && clockFraction !== null && (
            <div
              ref={clockRef}
              className="timeline-now"
              aria-label="Current time"
              data-clock-fraction={clockFraction}
              style={{ top: `${clockFraction * 100}%` }}
            >
              <time>{formatTimeInZone(now, state.timetable.timezone)}</time>
            </div>
          )}
        </article>
      </li>
    );
  };

  const upcoming = report.observations.filter(
    (observation) =>
      observation.segments.length === 0 &&
      !state.skippedOccurrenceIds.includes(observation.item.id),
  );

  return (
    <div
      className={`day-timeline${constrainHeight ? '' : ' day-timeline--unconstrained'}`}
      aria-label="Timetable day"
    >
      <ol className="day-timeline__list">
        {state.segments.map((segment, index) => {
          const occurrence = occurrenceFor(state, segment.occurrenceId);
          const next = state.segments[index + 1];
          const gap =
            segment.endedAt && next && next.startedAt.getTime() > segment.endedAt.getTime()
              ? { start: segment.endedAt, end: next.startedAt }
              : null;
          return (
            <Fragment key={segment.id}>
              {renderCard(segment, occurrence)}
              {gap && (
                <li className="timeline-gap">
                  <button
                    type="button"
                    className="timeline-gap__add"
                    aria-label={`Add a task between ${formatTimeInZone(
                      gap.start,
                      state.timetable.timezone,
                    )} and ${formatTimeInZone(gap.end, state.timetable.timezone)}`}
                    onClick={(event) =>
                      onSelectGap?.(
                        gap,
                        event.currentTarget.getBoundingClientRect().top,
                        event.currentTarget,
                      )
                    }
                  >
                    <span className="timeline-gap__plus" aria-hidden="true">
                      +
                    </span>
                    <span>Between tasks</span>
                    <time>
                      {formatTimeInZone(gap.start, state.timetable.timezone)}–
                      {formatTimeInZone(gap.end, state.timetable.timezone)}
                    </time>
                  </button>
                </li>
              )}
            </Fragment>
          );
        })}
        {upcoming.map((observation) => (
          <li
            className={`timeline-item timeline-item--upcoming${
              selectedActivityId === observation.item.id ? ' timeline-item--selected' : ''
            }`}
            key={`upcoming-${observation.item.id}`}
            style={{ minHeight: `${timelineSectionHeight(observation.plannedDurationMs)}px` }}
          >
            <span className="timeline-item__rail" aria-hidden="true">
              <span className="timeline-item__node" />
            </span>
            <article
              className="timeline-item__card"
              role="button"
              tabIndex={0}
              aria-label={`Open ${observation.item.label} details`}
              onClick={(event) => select(observation.item.id, event.currentTarget)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                select(observation.item.id, event.currentTarget);
              }}
            >
              <div className="timeline-item__heading">
                <h2>{observation.item.label}</h2>
                <div className="timeline-item__heading-actions">
                  <span className="timeline-item__state">upcoming</span>
                  {onSelectActivity && (
                    <span className="timeline-item__chevron" aria-hidden="true">
                      ›
                    </span>
                  )}
                </div>
              </div>
              <p className="timeline-item__planned">
                Planned {observation.item.plannedStart}–{observation.item.plannedEnd}
              </p>
              {observation.reordered && (
                <p className="timeline-item__reordered">Order changed for today</p>
              )}
              {observation.item.id === clockPosition?.id && (
                <div
                  ref={clockRef}
                  className="timeline-now"
                  aria-label="Current time"
                  data-clock-fraction={clockPosition.fraction}
                  style={{ top: `${clockPosition.fraction * 100}%` }}
                >
                  <time>{formatTimeInZone(now, state.timetable.timezone)}</time>
                </div>
              )}
            </article>
          </li>
        ))}
      </ol>
    </div>
  );
};
