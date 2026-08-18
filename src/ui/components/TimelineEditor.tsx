import { useMemo, useState } from 'react';

import { computePlannedSchedule } from '../../domain/analysis';
import { zonedLocalTimeToUtc } from '../../domain/time';
import type { RunEvent, RunState, TimelineEventReplacement } from '../../domain/types';
import {
  formatDeviation,
  formatStopwatch,
  formatTimeInZone,
} from '../format';
import { fromLocalDateTimeValue, toLocalDateTimeValue } from '../timeline';

const SNAP_MS = 5 * 60_000;

interface Segment {
  readonly itemId: string;
  readonly start: RunEvent;
  readonly terminal: RunEvent | null;
}

interface BoundaryControlProps {
  readonly event: RunEvent;
  readonly label: string;
  readonly value: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly axisMinimum: number;
  readonly axisMaximum: number;
  readonly timezone: string;
  readonly onChange: (value: number) => void;
}

const BoundaryControl = ({
  event,
  label,
  value,
  minimum,
  maximum,
  axisMinimum,
  axisMaximum,
  timezone,
  onChange,
}: BoundaryControlProps) => (
  <div className="boundary-control">
    <div className="boundary-control__heading">
      <label htmlFor={`boundary-${event.id}`}>{label}</label>
      <details>
        <summary>{formatTimeInZone(new Date(value), timezone)}</summary>
        <input
          aria-label={`Exact ${label.toLowerCase()} time`}
          type="datetime-local"
          min={toLocalDateTimeValue(new Date(minimum), timezone)}
          max={toLocalDateTimeValue(new Date(maximum), timezone)}
          value={toLocalDateTimeValue(new Date(value), timezone)}
          onChange={(input) => {
            const parsed = fromLocalDateTimeValue(input.target.value, timezone);
            if (parsed) onChange(parsed.getTime());
          }}
        />
      </details>
    </div>
    <input
      id={`boundary-${event.id}`}
      className="boundary-control__range"
      type="range"
      min={axisMinimum}
      max={axisMaximum}
      step={SNAP_MS}
      value={value}
      aria-valuetext={formatTimeInZone(new Date(value), timezone)}
      onChange={(input) => onChange(Number(input.target.value))}
    />
  </div>
);

export interface TimelineEditorProps {
  readonly state: RunState;
  readonly observedAt: Date;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSave: (replacements: readonly TimelineEventReplacement[]) => Promise<boolean>;
}

export const TimelineEditor = ({
  state,
  observedAt,
  busy,
  onCancel,
  onSave,
}: TimelineEditorProps) => {
  const editableEvents = state.effectiveEvents.filter((event) => event.type !== 'undo');
  const [draft, setDraft] = useState(
    () => new Map(editableEvents.map((event) => [event.id, event.occurredAt.getTime()])),
  );
  const [saving, setSaving] = useState(false);
  const timezone = state.timetable.timezone;
  const dayMinimum = zonedLocalTimeToUtc(state.run.localDate, 0, timezone).getTime();
  const dayMaximum = observedAt.getTime();
  const planned = useMemo(
    () =>
      new Map(
        computePlannedSchedule(state.timetable, state.run.localDate).map((item) => [
          item.item.id,
          item,
        ]),
      ),
    [state],
  );
  const segments = useMemo(() => {
    const result: Segment[] = [];
    editableEvents.forEach((event, index) => {
      if (event.type !== 'started') return;
      const next = editableEvents[index + 1];
      result.push({
        itemId: event.itemId,
        start: event,
        terminal:
          next && next.itemId === event.itemId && (next.type === 'completed' || next.type === 'skipped')
            ? next
            : null,
      });
    });
    return result;
  }, [editableEvents]);

  const valueFor = (event: RunEvent): number =>
    draft.get(event.id) ?? event.occurredAt.getTime();
  const boundsFor = (event: RunEvent): readonly [number, number] => {
    const index = editableEvents.findIndex((candidate) => candidate.id === event.id);
    const previous = editableEvents[index - 1];
    const next = editableEvents[index + 1];
    return [
      previous ? valueFor(previous) : dayMinimum,
      next ? valueFor(next) : dayMaximum,
    ];
  };
  const setEventTime = (event: RunEvent, value: number) => {
    const [minimum, maximum] = boundsFor(event);
    const bounded = Math.min(maximum, Math.max(minimum, value));
    setDraft((current) => new Map(current).set(event.id, bounded));
  };

  const changed = editableEvents.filter(
    (event) => valueFor(event) !== event.occurredAt.getTime(),
  );
  const gaps = segments.flatMap((segment, index) => {
    const next = segments[index + 1];
    if (!segment.terminal || !next) return [];
    const start = valueFor(segment.terminal);
    const end = valueFor(next.start);
    return end > start ? [{ after: segment, before: next, start, end }] : [];
  });
  const gapTotal = gaps.reduce((total, gap) => total + gap.end - gap.start, 0);

  return (
    <section className="timeline-editor" aria-label="Edit actual timeline">
      <header className="timeline-editor__header">
        <div>
          <h2>Editing actual timeline</h2>
          <p>Drag a handle in five-minute steps, or tap its time for an exact value.</p>
        </div>
        <button type="button" className="button button--ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </header>

      <ol className="timeline-editor__segments">
        {segments.map((segment, index) => {
          const item = state.timetable.items.find((candidate) => candidate.id === segment.itemId);
          const plan = planned.get(segment.itemId);
          const startValue = valueFor(segment.start);
          const endValue = segment.terminal ? valueFor(segment.terminal) : observedAt.getTime();
          const duration = Math.max(0, endValue - startValue);
          const deviation = plan ? duration - plan.plannedDurationMs : null;
          const next = segments[index + 1];
          const hasAlignedNext =
            segment.terminal &&
            next &&
            valueFor(segment.terminal) === valueFor(next.start);

          return (
            <li className="timeline-editor__segment" key={segment.itemId}>
              <div className="timeline-editor__segment-heading">
                <h3>{item?.label ?? segment.itemId}</h3>
                <span>{formatStopwatch(duration)}</span>
              </div>
              {plan && (
                <p>
                  Estimated {formatStopwatch(plan.plannedDurationMs)} ·{' '}
                  {formatDeviation(deviation, 'longer')}
                </p>
              )}
              <BoundaryControl
                event={segment.start}
                label="Start"
                value={startValue}
                minimum={boundsFor(segment.start)[0]}
                maximum={boundsFor(segment.start)[1]}
                axisMinimum={dayMinimum}
                axisMaximum={dayMaximum}
                timezone={timezone}
                onChange={(value) => setEventTime(segment.start, value)}
              />
              {segment.terminal && (
                <BoundaryControl
                  event={segment.terminal}
                  label={segment.terminal.type === 'skipped' ? 'Skipped' : 'End'}
                  value={valueFor(segment.terminal)}
                  minimum={boundsFor(segment.terminal)[0]}
                  maximum={boundsFor(segment.terminal)[1]}
                  axisMinimum={dayMinimum}
                  axisMaximum={dayMaximum}
                  timezone={timezone}
                  onChange={(value) => setEventTime(segment.terminal!, value)}
                />
              )}
              {hasAlignedNext && (
                <button
                  type="button"
                  className="timeline-editor__add-gap"
                  disabled={valueFor(next.start) >= boundsFor(next.start)[1]}
                  onClick={() => setEventTime(next.start, valueFor(next.start) + SNAP_MS)}
                >
                  Add between tasks
                </button>
              )}
              {gaps
                .filter((gap) => gap.after.itemId === segment.itemId)
                .map((gap) => (
                  <div className="timeline-editor__gap" key={`${gap.after.itemId}-${gap.before.itemId}`}>
                    <strong>Between tasks · {formatStopwatch(gap.end - gap.start)}</strong>
                    <span>
                      {formatTimeInZone(new Date(gap.start), timezone)}–
                      {formatTimeInZone(new Date(gap.end), timezone)}
                    </span>
                  </div>
                ))}
            </li>
          );
        })}
      </ol>

      <footer className="timeline-editor__footer">
        <div>
          <strong>{changed.length} boundary {changed.length === 1 ? 'change' : 'changes'}</strong>
          <span>Between tasks: {formatStopwatch(gapTotal)}</span>
        </div>
        <button
          type="button"
          className="button button--primary"
          disabled={busy || saving || changed.length === 0}
          onClick={() => {
            setSaving(true);
            void onSave(
              changed.map((event) => ({
                eventId: event.id,
                expectedOccurredAt: event.occurredAt,
                occurredAt: new Date(valueFor(event)),
              })),
            ).finally(() => setSaving(false));
          }}
        >
          Save changes
        </button>
      </footer>
    </section>
  );
};
