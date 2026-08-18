import { Fragment, useLayoutEffect, useMemo, useRef } from 'react';

import { buildRunReport } from '../../domain/analysis';
import type { RunEvent, RunState } from '../../domain/types';
import {
  deviationTone,
  formatDeviation,
  formatStopwatch,
  formatTimeInZone,
} from '../format';
import { instantFraction, timelineSectionHeight } from '../timeline';

export interface DayTimelineProps {
  readonly state: RunState;
  readonly now: Date;
  readonly elapsedMs?: number;
  readonly onEditTransition?: (transition: RunEvent) => void;
  readonly onReorder?: (itemId: string) => void;
  readonly autoFocusCurrent?: boolean;
}

type ItemState = 'completed' | 'current' | 'upcoming' | 'skipped';

export const DayTimeline = ({
  state,
  now,
  elapsedMs = 0,
  onEditTransition,
  onReorder,
  autoFocusCurrent = false,
}: DayTimelineProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLLIElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const report = useMemo(
    () => buildRunReport(state.timetable, state.run, state.events),
    [state],
  );
  const terminals = useMemo(
    () =>
      new Map(
        state.effectiveEvents
          .filter((event) => event.type === 'completed' || event.type === 'skipped')
          .map((event) => [event.itemId, event]),
      ),
    [state.effectiveEvents],
  );
  const initialStart = state.effectiveEvents.find(
    (event) => event.seq === 1 && event.type === 'started',
  );
  const gaps = useMemo(
    () => new Map(report.betweenTasks.map((gap) => [gap.afterItemId, gap])),
    [report.betweenTasks],
  );
  const plannedMarkerIndex = report.observations.findIndex((observation, index) => {
    const value = now.getTime();
    const isLast = index === report.observations.length - 1;
    return (
      value >= observation.plannedStartUtc.getTime() &&
      (value < observation.plannedEndUtc.getTime() ||
        (isLast && value <= observation.plannedEndUtc.getTime()))
    );
  });
  const markerIndex = report.reordered && state.phase === 'running'
    ? state.currentIndex ?? -1
    : plannedMarkerIndex;

  useLayoutEffect(() => {
    if (!autoFocusCurrent || !currentRef.current) return;
    const container = containerRef.current;
    const current = currentRef.current;
    const marker = markerRef.current;
    if (!container || typeof container.scrollTo !== 'function') {
      current.scrollIntoView?.({ block: 'center' });
      return;
    }

    const currentTop = current.offsetTop;
    const currentBottom = currentTop + current.offsetHeight;
    const markerTop = marker
      ? (marker.parentElement?.offsetTop ?? 0) + marker.offsetTop
      : currentTop;
    const focusTop = Math.min(currentTop, markerTop);
    const focusBottom = Math.max(currentBottom, markerTop);
    if (focusBottom - focusTop > container.clientHeight) {
      current.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      return;
    }
    container.scrollTo({
      top: Math.max(0, (focusTop + focusBottom - container.clientHeight) / 2),
      behavior: 'smooth',
    });
  }, [autoFocusCurrent, state.currentIndex]);

  return (
    <div className="day-timeline" ref={containerRef} aria-label="Timetable day">
      <ol className="day-timeline__list">
        {report.observations.map((observation, index) => {
          const terminal = terminals.get(observation.item.id) ?? null;
          const itemState: ItemState = observation.skipped
            ? 'skipped'
            : state.status === 'active' && state.currentIndex === index
              ? 'current'
              : terminal
                ? 'completed'
                : 'upcoming';
          const nowFraction =
            markerIndex !== index
              ? null
              : report.reordered && state.currentItemStartedAt
                ? Math.min(
                    1,
                    Math.max(
                      0,
                      (now.getTime() - state.currentItemStartedAt.getTime()) /
                        observation.plannedDurationMs,
                    ),
                  )
                : instantFraction(observation, now);
          const isCurrentMarker = nowFraction !== null;
          const sectionHeight = timelineSectionHeight(observation.plannedDurationMs);

          const gap = gaps.get(observation.item.id);
          return (
            <Fragment key={observation.item.id}>
            <li
              className={`timeline-item timeline-item--${itemState}`}
              ref={itemState === 'current' ? currentRef : undefined}
              style={{ minHeight: `${sectionHeight}px` }}
            >
              <span className="timeline-item__rail" aria-hidden="true">
                <span className="timeline-item__node" />
              </span>
              <article className="timeline-item__card">
                <div className="timeline-item__heading">
                  <h2>{observation.item.label}</h2>
                  <span className="timeline-item__state">{itemState}</span>
                </div>
                <p className="timeline-item__planned">
                  Planned {observation.item.plannedStart}–{observation.item.plannedEnd}
                </p>
                {observation.reordered && (
                  <p className="timeline-item__reordered">Order changed for today</p>
                )}
                {index === 0 && initialStart && onEditTransition && (
                  <button
                    type="button"
                    className="timeline-item__boundary"
                    onClick={() => onEditTransition(initialStart)}
                  >
                    {formatTimeInZone(initialStart.occurredAt, state.timetable.timezone)}
                    <span>Edit start</span>
                  </button>
                )}
                {observation.actualStart && !observation.skipped && (
                  <>
                    <p className="timeline-item__actual">
                      Actual {formatTimeInZone(observation.actualStart, state.timetable.timezone)}
                      {observation.actualEnd
                        ? `–${formatTimeInZone(observation.actualEnd, state.timetable.timezone)}`
                        : ''}
                      {' · '}
                      <span className={`tone--${deviationTone(observation.startDeviationMs)}`}>
                        {formatDeviation(observation.startDeviationMs)}
                      </span>
                    </p>
                    {observation.durationDeviationMs !== null && (
                      <p className={`timeline-item__actual tone--${deviationTone(observation.durationDeviationMs)}`}>
                        Duration {formatDeviation(observation.durationDeviationMs, 'longer')}
                      </p>
                    )}
                  </>
                )}
                {itemState === 'current' && (
                  <p className="timeline-item__elapsed" aria-label="Time in this step">
                    {formatStopwatch(elapsedMs)}
                  </p>
                )}
                {observation.skipped && terminal && (
                  <p className="timeline-item__actual">
                    Skipped at {formatTimeInZone(terminal.occurredAt, state.timetable.timezone)}
                  </p>
                )}
                {terminal && onEditTransition && (
                  <button
                    type="button"
                    className="timeline-item__boundary"
                    onClick={() => onEditTransition(terminal)}
                  >
                    {formatTimeInZone(terminal.occurredAt, state.timetable.timezone)}
                    <span>Edit time</span>
                  </button>
                )}
                {itemState === 'upcoming' &&
                  onReorder &&
                  state.nextIndex !== index && (
                    <button
                      type="button"
                      className="timeline-item__reorder"
                      onClick={() => onReorder(observation.item.id)}
                    >
                      Do this next
                    </button>
                  )}
              </article>
              {isCurrentMarker && (
                <div
                  className="timeline-now"
                  ref={markerRef}
                  style={{ top: `${nowFraction * sectionHeight}px` }}
                >
                  <time>{formatTimeInZone(now, state.timetable.timezone)}</time>
                </div>
              )}
            </li>
            {gap && (
              <li className="timeline-gap">
                <span>Between tasks</span>
                <strong>{formatStopwatch(gap.durationMs)}</strong>
                <time>
                  {formatTimeInZone(gap.startedAt, state.timetable.timezone)}–
                  {formatTimeInZone(gap.endedAt, state.timetable.timezone)}
                </time>
              </li>
            )}
            </Fragment>
          );
        })}
      </ol>
    </div>
  );
};
