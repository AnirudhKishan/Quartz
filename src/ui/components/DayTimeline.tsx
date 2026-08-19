import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { buildRunReport } from '../../domain/analysis';
import { zonedLocalTimeToUtc } from '../../domain/time';
import type {
  ActivitySegment,
  RunState,
  TimelineEventReplacement,
  TrackedOccurrence,
} from '../../domain/types';
import {
  deviationTone,
  formatDeviation,
  formatStopwatch,
  formatTimeInZone,
} from '../format';
import {
  locateTimelineClock,
  locateTimelineClockCard,
  moveTimelineBoundary,
  timelineDragTime,
  timelineEditDurationHeight,
  timelineEditSectionHeight,
  timelineSectionHeight,
  type TimelineDraftSegment,
} from '../timeline';

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
  readonly onSaveTimeline?: (
    replacements: readonly TimelineEventReplacement[],
  ) => Promise<boolean>;
  readonly onEditingChange?: (editing: boolean) => void;
  readonly busy?: boolean;
  readonly autoFocusCurrent?: boolean;
  readonly constrainHeight?: boolean;
}

interface BoundaryHandleProps {
  readonly edge: 'start' | 'end';
  readonly value: number;
  readonly label: string;
  readonly magnetic: boolean;
  readonly getScrollPosition: () => number;
  readonly autoScroll: (clientY: number) => void;
  readonly onMove: (rawValue: number) => void;
}

const BoundaryHandle = ({
  edge,
  value,
  label,
  magnetic,
  getScrollPosition,
  autoScroll,
  onMove,
}: BoundaryHandleProps) => {
  const drag = useRef<{
    pointerId: number;
    y: number;
    value: number;
    scrollPosition: number;
  } | null>(null);
  return (
    <button
      type="button"
      className={`timeline-edge timeline-edge--${edge}${magnetic ? ' timeline-edge--magnetic' : ''}`}
      aria-label={label}
      aria-valuetext={new Date(value).toISOString()}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId,
          y: event.clientY,
          value,
          scrollPosition: getScrollPosition(),
        };
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        autoScroll(event.clientY);
        onMove(
          timelineDragTime(
            active.value,
            event.clientY - active.y,
            getScrollPosition() - active.scrollPosition,
          ),
        );
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId === event.pointerId) drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        onMove(value + (event.key === 'ArrowUp' ? -1 : 1) * 5 * 60_000);
      }}
    >
      <span aria-hidden="true" />
    </button>
  );
};

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
  onSaveTimeline,
  onEditingChange,
  busy = false,
  autoFocusCurrent = false,
  constrainHeight = true,
}: DayTimelineProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const longPress = useRef<{
    timer: number;
    x: number;
    y: number;
    segmentId: string;
    target: HTMLElement;
  } | null>(null);
  const selectionTimer = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Map<string, number>>(() => new Map());
  const [activeEdge, setActiveEdge] = useState<string | null>(null);
  const [magneticEdge, setMagneticEdge] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [clockCards, setClockCards] = useState<
    readonly { itemId: string; key: string; height: number }[]
  >([]);
  const report = useMemo(
    () => buildRunReport(state.timetable, state.run, state.events),
    [state],
  );
  const clockPosition = useMemo(
    () =>
      state.status === 'active'
        ? locateTimelineClock(
            report.observations.map((observation) => ({
              id: observation.item.id,
              durationMs: observation.plannedDurationMs,
            })),
            now.getTime() - state.run.startedAt.getTime(),
          )
        : null,
    [now, report.observations, state.run.startedAt, state.status],
  );
  const renderedClockPosition = useMemo(
    () =>
      clockPosition
        ? locateTimelineClockCard(
            clockCards
              .filter((card) => card.itemId === clockPosition.id)
              .map((card) => ({ key: card.key, height: card.height })),
            clockPosition.fraction,
          )
        : null,
    [clockCards, clockPosition],
  );
  const eventById = useMemo(
    () => new Map(state.effectiveEvents.map((event) => [event.id, event])),
    [state.effectiveEvents],
  );
  const originalTimes = useMemo(() => {
    const values = new Map<string, number>();
    state.segments.forEach((segment) => {
      values.set(segment.startEventId, segment.startedAt.getTime());
      if (segment.endEventId && segment.endedAt) {
        values.set(segment.endEventId, segment.endedAt.getTime());
      }
    });
    return values;
  }, [state.segments]);
  const lockedEventTimes = useMemo(
    () =>
      state.effectiveEvents
        .filter((event) => !originalTimes.has(event.id))
        .map((event) => event.occurredAt.getTime()),
    [originalTimes, state.effectiveEvents],
  );
  const valueFor = useCallback(
    (eventId: string, fallback: Date): number =>
      draft.get(eventId) ?? originalTimes.get(eventId) ?? fallback.getTime(),
    [draft, originalTimes],
  );
  const draftSegments = useMemo<TimelineDraftSegment[]>(
    () =>
      state.segments.map((segment) => ({
        startEventId: segment.startEventId,
        endEventId: segment.endEventId,
        start: valueFor(segment.startEventId, segment.startedAt),
        end:
          segment.endEventId && segment.endedAt
            ? valueFor(segment.endEventId, segment.endedAt)
            : null,
      })),
    [state.segments, valueFor],
  );
  const dayMinimum = zonedLocalTimeToUtc(
    state.run.localDate,
    0,
    state.timetable.timezone,
  ).getTime();

  const beginEdit = useCallback(
    (segmentId: string, target: HTMLElement) => {
      if (!onSaveTimeline) return;
      cardRefs.current.set(segmentId, target);
      setDraft(new Map(originalTimes));
      setEditingSegmentId(segmentId);
      setSaveError(null);
      onEditingChange?.(true);
    },
    [onSaveTimeline, onEditingChange, originalTimes],
  );

  const cancelEdit = useCallback(() => {
    const segmentId = editingSegmentId;
    setEditingSegmentId(null);
    setDraft(new Map());
    setActiveEdge(null);
    setMagneticEdge(null);
    setSaveError(null);
    onEditingChange?.(false);
    if (segmentId) {
      window.setTimeout(() => cardRefs.current.get(segmentId)?.focus(), 0);
    }
  }, [editingSegmentId, onEditingChange]);

  useEffect(() => {
    if (!editingSegmentId) return undefined;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelEdit();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [cancelEdit, editingSegmentId]);

  useEffect(
    () => () => {
      if (longPress.current) window.clearTimeout(longPress.current.timer);
      if (selectionTimer.current) window.clearTimeout(selectionTimer.current);
    },
    [],
  );

  useLayoutEffect(() => {
    if (!autoFocusCurrent || !clockRef.current || editingSegmentId) return;
    clockRef.current.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [autoFocusCurrent, editingSegmentId, renderedClockPosition?.key]);

  useLayoutEffect(() => {
    if (!editingSegmentId) return;
    cardRefs.current.get(editingSegmentId)?.scrollIntoView?.({ block: 'start' });
  }, [editingSegmentId]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || editingSegmentId) return undefined;
    const elements = [
      ...container.querySelectorAll<HTMLElement>(
        '[data-planned-item-id][data-clock-card-key]',
      ),
    ];
    const measure = () => {
      const next = elements.map((element) => ({
        itemId: element.dataset.plannedItemId ?? '',
        key: element.dataset.clockCardKey ?? '',
        height: element.getBoundingClientRect().height,
      }));
      setClockCards((current) =>
        current.length === next.length &&
        current.every(
          (card, index) =>
            card.itemId === next[index]?.itemId &&
            card.key === next[index]?.key &&
            card.height === next[index]?.height,
        )
          ? current
          : next,
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [editingSegmentId, report.observations, state.segments]);

  const scrollContainer = useCallback(() => {
    const container = containerRef.current;
    return container && container.scrollHeight > container.clientHeight + 1 ? container : null;
  }, []);

  const getScrollPosition = useCallback(
    () => scrollContainer()?.scrollTop ?? window.scrollY,
    [scrollContainer],
  );

  const autoScroll = useCallback(
    (clientY: number) => {
      const container = scrollContainer();
      const top = container?.getBoundingClientRect().top ?? 0;
      const bottom = container?.getBoundingClientRect().bottom ?? window.innerHeight;
      if (clientY < top + 80) (container ?? window).scrollBy(0, -12);
      if (clientY > bottom - 80) (container ?? window).scrollBy(0, 12);
    },
    [scrollContainer],
  );

  const select = (activityId: string, target: HTMLElement) => {
    onSelectActivity?.(activityId, target.getBoundingClientRect().top, target);
  };

  const moveBoundary = (segmentIndex: number, edge: 'start' | 'end', rawValue: number) => {
    const segment = state.segments[segmentIndex];
    if (!segment) return;
    const key = `${segment.id}:${edge}`;
    const originalBoundary =
      edge === 'start' ? segment.startedAt.getTime() : segment.endedAt?.getTime();
    const lockedBefore =
      originalBoundary === undefined
        ? undefined
        : lockedEventTimes
            .filter((value) => value <= originalBoundary)
            .reduce<number | undefined>(
              (closest, value) => (closest === undefined || value > closest ? value : closest),
              undefined,
            );
    const lockedAfter =
      originalBoundary === undefined
        ? undefined
        : lockedEventTimes
            .filter((value) => value >= originalBoundary)
            .reduce<number | undefined>(
              (closest, value) => (closest === undefined || value < closest ? value : closest),
              undefined,
            );
    const result = moveTimelineBoundary(
      draftSegments,
      segmentIndex,
      edge,
      rawValue,
      dayMinimum,
      now.getTime(),
      { minimum: lockedBefore, maximum: lockedAfter },
    );
    setDraft((current) => {
      const next = new Map(current);
      result.updates.forEach((value, eventId) => next.set(eventId, value));
      return next;
    });
    setActiveEdge(key);
    setMagneticEdge(result.magnetic ? key : null);
  };

  const changedEvents = [...originalTimes.entries()].flatMap(([eventId, original]) => {
    const value = draft.get(eventId) ?? original;
    const event = eventById.get(eventId);
    return value !== original && event
      ? [
          {
            eventId,
            expectedOccurredAt: event.occurredAt,
            occurredAt: new Date(value),
          },
        ]
      : [];
  });

  const renderCard = (
    segment: ActivitySegment,
    segmentIndex: number,
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
    const itemState = segment.endType === 'skipped'
      ? 'skipped'
      : current
        ? 'current'
        : paused
          ? 'paused'
          : occurrence.kind === 'inserted'
            ? 'unplanned'
            : 'completed';
    const draftSegment = draftSegments[segmentIndex]!;
    const previous = draftSegments[segmentIndex - 1];
    const next = draftSegments[segmentIndex + 1];
    const showTopBoundary =
      editingSegmentId !== null && (!previous || previous.end !== draftSegment.start);
    const showSharedTop =
      editingSegmentId !== null && previous?.end === draftSegment.start;
    const showBottomBoundary =
      editingSegmentId !== null &&
      draftSegment.end !== null &&
      (!next || next.start !== draftSegment.end);
    const previousSegment = state.segments[segmentIndex - 1];
    const topBoundaryActive =
      activeEdge === `${segment.id}:start` ||
      (showSharedTop &&
        previousSegment !== undefined &&
        activeEdge === `${previousSegment.id}:end`);
    const bottomBoundaryActive = activeEdge === `${segment.id}:end`;
    const isEditing = editingSegmentId === segment.id;
    const duration =
      draftSegment.end === null
        ? Math.max(0, now.getTime() - draftSegment.start)
        : Math.max(0, draftSegment.end - draftSegment.start);
    const sectionHeight = editingSegmentId
      ? timelineEditSectionHeight(duration)
      : timelineSectionHeight(
          plan ? plan.plannedDurationMs / Math.max(1, occurrenceSegments.length) : 15 * 60_000,
        );
    const ownsClock =
      !editingSegmentId && renderedClockPosition?.key === segment.id;
    const isPrimaryPlannedCard = plan !== undefined && occurrenceSegmentIndex === 1;

    return (
      <li
        className={`timeline-item timeline-item--${itemState}${selectedActivityId === occurrence.id ? ' timeline-item--selected' : ''}${isEditing ? ' timeline-item--editing' : ''}`}
        style={
          editingSegmentId
            ? { height: `${sectionHeight}px` }
            : { minHeight: `${sectionHeight}px` }
        }
        key={segment.id}
      >
        {(showTopBoundary || showSharedTop) && (
          <div
            className={`timeline-boundary timeline-boundary--top${topBoundaryActive ? ' timeline-boundary--active' : ''}`}
          >
            <time>{formatTimeInZone(new Date(draftSegment.start), state.timetable.timezone)}</time>
          </div>
        )}
        <span className="timeline-item__rail" aria-hidden="true">
          <span className="timeline-item__node" />
        </span>
        <article
          className="timeline-item__card"
          data-planned-item-id={isPrimaryPlannedCard ? plan.item.id : undefined}
          data-clock-card-key={isPrimaryPlannedCard ? segment.id : undefined}
          tabIndex={0}
          aria-describedby={`timeline-help-${segment.id}`}
          ref={(node) => {
            if (node) cardRefs.current.set(segment.id, node);
            else cardRefs.current.delete(segment.id);
          }}
          onClick={(event) => {
            if (editingSegmentId || suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            if (selectionTimer.current) window.clearTimeout(selectionTimer.current);
            const target = event.currentTarget;
            selectionTimer.current = window.setTimeout(
              () => select(occurrence.id, target),
              220,
            );
          }}
          onDoubleClick={(event) => {
            if (selectionTimer.current) window.clearTimeout(selectionTimer.current);
            event.preventDefault();
            beginEdit(segment.id, event.currentTarget);
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            beginEdit(segment.id, event.currentTarget);
          }}
          onPointerDown={(event) => {
            if (editingSegmentId || event.pointerType === 'mouse') return;
            const target = event.currentTarget;
            longPress.current = {
              timer: window.setTimeout(() => {
                suppressClick.current = true;
                navigator.vibrate?.(12);
                beginEdit(segment.id, target);
                longPress.current = null;
              }, 500),
              x: event.clientX,
              y: event.clientY,
              segmentId: segment.id,
              target,
            };
          }}
          onPointerMove={(event) => {
            const press = longPress.current;
            if (
              press &&
              (Math.abs(event.clientX - press.x) > 8 || Math.abs(event.clientY - press.y) > 8)
            ) {
              window.clearTimeout(press.timer);
              longPress.current = null;
            }
          }}
          onPointerUp={() => {
            if (!longPress.current) return;
            window.clearTimeout(longPress.current.timer);
            longPress.current = null;
          }}
          onPointerCancel={() => {
            if (!longPress.current) return;
            window.clearTimeout(longPress.current.timer);
            longPress.current = null;
          }}
        >
          <span id={`timeline-help-${segment.id}`} className="sr-only">
            Press Enter or Space to edit recorded boundaries. Use the details button for task
            actions.
          </span>
          {isEditing && (
            <BoundaryHandle
              edge="start"
              value={draftSegment.start}
              label={`Adjust ${occurrence.label} segment start`}
              magnetic={magneticEdge === `${segment.id}:start`}
              getScrollPosition={getScrollPosition}
              autoScroll={autoScroll}
              onMove={(value) => moveBoundary(segmentIndex, 'start', value)}
            />
          )}
          <div className="timeline-item__card-content">
            <div className="timeline-item__heading">
              <h2>{occurrence.label}</h2>
              <div className="timeline-item__heading-actions">
                <span className="timeline-item__state">{itemState}</span>
                {!editingSegmentId && onSelectActivity && (
                  <button
                    type="button"
                    className="timeline-item__details"
                    aria-label={`Open ${occurrence.label} details`}
                    onClick={(event) => {
                      event.stopPropagation();
                      select(occurrence.id, event.currentTarget.closest('article')!);
                    }}
                  >
                    ›
                  </button>
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
            {!editingSegmentId && (
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
            )}
            {plan &&
              occurrenceSegmentIndex === occurrenceSegments.length &&
              plan.durationDeviationMs !== null &&
              !editingSegmentId && (
                <p
                  className={`timeline-item__actual tone--${deviationTone(plan.durationDeviationMs)}`}
                >
                  Duration {formatDeviation(plan.durationDeviationMs, 'longer')}
                  {plan.segmentCount > 1 ? ` · ${plan.segmentCount} segments` : ''}
                </p>
              )}
            {current && !editingSegmentId && (
              <p className="timeline-item__elapsed" aria-label="Time in this step">
                {formatStopwatch(elapsedMs)}
              </p>
            )}
            {isEditing && (
              <p className="timeline-item__elapsed">{formatStopwatch(duration)}</p>
            )}
          </div>
          {isEditing && segment.endEventId && draftSegment.end !== null && (
            <BoundaryHandle
              edge="end"
              value={draftSegment.end}
              label={`Adjust ${occurrence.label} segment end`}
              magnetic={magneticEdge === `${segment.id}:end`}
              getScrollPosition={getScrollPosition}
              autoScroll={autoScroll}
              onMove={(value) => moveBoundary(segmentIndex, 'end', value)}
            />
          )}
          {ownsClock && renderedClockPosition && (
            <div
              ref={clockRef}
              className="timeline-now"
              aria-label="Current time"
              data-clock-fraction={renderedClockPosition.fraction}
              style={{ top: `${renderedClockPosition.fraction * 100}%` }}
            >
              <time>{formatTimeInZone(now, state.timetable.timezone)}</time>
            </div>
          )}
        </article>
        {showBottomBoundary && draftSegment.end !== null && (
          <div
            className={`timeline-boundary timeline-boundary--bottom${bottomBoundaryActive ? ' timeline-boundary--active' : ''}`}
          >
            <time>{formatTimeInZone(new Date(draftSegment.end), state.timetable.timezone)}</time>
          </div>
        )}
      </li>
    );
  };

  const upcoming = report.observations.filter(
    (observation) =>
      observation.segments.length === 0 &&
      !state.skippedOccurrenceIds.includes(observation.item.id),
  );

  return (
    <>
      <div
        className={`day-timeline${constrainHeight ? '' : ' day-timeline--unconstrained'}${editingSegmentId ? ' day-timeline--editing' : ''}`}
        ref={containerRef}
        aria-label="Timetable day"
      >
        <ol className="day-timeline__list">
          {state.segments.map((segment, index) => {
            const occurrence = occurrenceFor(state, segment.occurrenceId);
            const draftSegment = draftSegments[index]!;
            const next = draftSegments[index + 1];
            const gap =
              draftSegment.end !== null && next && next.start > draftSegment.end
                ? { start: draftSegment.end, end: next.start }
                : null;
            return (
              <Fragment key={segment.id}>
                {renderCard(segment, index, occurrence)}
                {gap && (
                  <li
                    className="timeline-gap"
                    style={
                      editingSegmentId
                        ? {
                            height: `${timelineEditDurationHeight(
                              gap.end - gap.start,
                            )}px`,
                          }
                        : undefined
                    }
                  >
                    <span>Between tasks</span>
                    <strong>{formatStopwatch(gap.end - gap.start)}</strong>
                    {!editingSegmentId && (
                      <time>
                        {formatTimeInZone(new Date(gap.start), state.timetable.timezone)}–
                        {formatTimeInZone(new Date(gap.end), state.timetable.timezone)}
                      </time>
                    )}
                  </li>
                )}
              </Fragment>
            );
          })}
          {upcoming.map((observation) => (
            <li
              className={`timeline-item timeline-item--upcoming${selectedActivityId === observation.item.id ? ' timeline-item--selected' : ''}`}
              key={`upcoming-${observation.item.id}`}
              style={{ minHeight: `${timelineSectionHeight(observation.plannedDurationMs)}px` }}
            >
              <span className="timeline-item__rail" aria-hidden="true">
                <span className="timeline-item__node" />
              </span>
              <article
                className="timeline-item__card"
                data-planned-item-id={observation.item.id}
                data-clock-card-key={`upcoming:${observation.item.id}`}
                tabIndex={0}
                onClick={(event) => select(observation.item.id, event.currentTarget)}
              >
                <div className="timeline-item__heading">
                  <h2>{observation.item.label}</h2>
                  <div className="timeline-item__heading-actions">
                    <span className="timeline-item__state">upcoming</span>
                    {onSelectActivity && (
                      <button
                        type="button"
                        className="timeline-item__details"
                        aria-label={`Open ${observation.item.label} details`}
                        onClick={(event) => {
                          event.stopPropagation();
                          select(observation.item.id, event.currentTarget.closest('article')!);
                        }}
                      >
                        ›
                      </button>
                    )}
                  </div>
                </div>
                <p className="timeline-item__planned">
                  Planned {observation.item.plannedStart}–{observation.item.plannedEnd}
                </p>
                {observation.reordered && (
                  <p className="timeline-item__reordered">Order changed for today</p>
                )}
                {!editingSegmentId &&
                  renderedClockPosition?.key === `upcoming:${observation.item.id}` && (
                  <div
                    ref={clockRef}
                    className="timeline-now"
                    aria-label="Current time"
                    data-clock-fraction={renderedClockPosition.fraction}
                    style={{ top: `${renderedClockPosition.fraction * 100}%` }}
                  >
                    <time>{formatTimeInZone(now, state.timetable.timezone)}</time>
                  </div>
                )}
              </article>
            </li>
          ))}
        </ol>
      </div>

      {editingSegmentId && (
        <div className="timeline-draft-bar" role="status">
          <div>
            <strong>{changedEvents.length} changed</strong>
            <span>{activeEdge ? 'Boundary selected' : 'Drag an edge'}</span>
          </div>
          {saveError && <span className="timeline-draft-bar__error">{saveError}</span>}
          <button type="button" className="button button--ghost" disabled={busy} onClick={cancelEdit}>
            Cancel
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={busy || changedEvents.length === 0}
            onClick={() => {
              setSaveError(null);
              void onSaveTimeline?.(changedEvents).then((saved) => {
                if (saved) cancelEdit();
                else setSaveError('Could not save these boundaries.');
              });
            }}
          >
            Save
          </button>
        </div>
      )}
    </>
  );
};
