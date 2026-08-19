import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

import type { RunState } from '../../domain/types';
import type { TimelineEventReplacement } from '../../domain/types';
import { zonedLocalTimeToUtc } from '../../domain/time';
import { formatStopwatch, formatTimeInZone } from '../format';

const formatDateTimeInput = (date: Date, timezone: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`;
};

const parseDateTimeInput = (value: string, timezone: string): Date | null => {
  const [localDate, clock] = value.split('T');
  const [hour, minute] = clock?.split(':').map(Number) ?? [];
  if (!localDate || hour === undefined || minute === undefined) return null;
  return zonedLocalTimeToUtc(localDate, hour * 60 + minute, timezone);
};

export interface TaskDetailsPanelProps {
  readonly state: RunState;
  readonly activityId: string;
  readonly anchorTop: number;
  readonly returnFocus: HTMLElement | null;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onReorder?: (itemId: string) => Promise<void>;
  readonly onPause?: () => Promise<void>;
  readonly onStartUnplanned?: (label: string) => Promise<void>;
  readonly onSkip?: () => Promise<void>;
  readonly onEditTimes?: (
    replacements: readonly TimelineEventReplacement[],
  ) => Promise<boolean>;
}

export const TaskDetailsPanel = ({
  state,
  activityId,
  anchorTop,
  returnFocus,
  busy,
  onClose,
  onReorder,
  onPause,
  onStartUnplanned,
  onSkip,
  onEditTimes,
}: TaskDetailsPanelProps) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const swipeStart = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  const returnFocusRef = useRef(returnFocus);
  onCloseRef.current = onClose;
  returnFocusRef.current = returnFocus;
  const [composing, setComposing] = useState(false);
  const [editingTimes, setEditingTimes] = useState(false);
  const [label, setLabel] = useState('Between tasks');
  const [timeValues, setTimeValues] = useState<Record<string, string>>({});
  const [timeError, setTimeError] = useState<string | null>(null);
  const closeAndRestore = useCallback(() => {
    onCloseRef.current();
    window.setTimeout(() => returnFocusRef.current?.focus(), 0);
  }, []);
  const occurrence = state.occurrences.find((candidate) => candidate.id === activityId);
  const segments = useMemo(
    () => state.segments.filter((segment) => segment.occurrenceId === activityId),
    [activityId, state.segments],
  );

  useEffect(() => {
    closeRef.current?.focus();
  }, [activityId]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeAndRestore();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const controls = [
        ...panelRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ];
      const firstControl = controls[0];
      const lastControl = controls[controls.length - 1];
      if (!firstControl || !lastControl) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === firstControl || !panelRef.current.contains(active))) {
        event.preventDefault();
        lastControl.focus();
      } else if (!event.shiftKey && (active === lastControl || !panelRef.current.contains(active))) {
        event.preventDefault();
        firstControl.focus();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [closeAndRestore]);

  useEffect(() => {
    if (!composing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [composing]);

  useEffect(() => {
    const values: Record<string, string> = {};
    segments.forEach((segment) => {
      values[segment.startEventId] = formatDateTimeInput(
        segment.startedAt,
        state.timetable.timezone,
      );
      if (segment.endEventId && segment.endedAt) {
        values[segment.endEventId] = formatDateTimeInput(
          segment.endedAt,
          state.timetable.timezone,
        );
      }
    });
    setTimeValues(values);
    setEditingTimes(false);
    setTimeError(null);
  }, [activityId, segments, state.timetable.timezone]);

  if (!occurrence) return null;
  const plannedItem =
    occurrence.plannedItemId === null
      ? null
      : state.timetable.items.find((item) => item.id === occurrence.plannedItemId) ?? null;
  const first = segments[0];
  const last = segments[segments.length - 1];
  const current = state.currentActivity?.id === occurrence.id;
  const paused = state.resumeTarget?.id === occurrence.id;
  const skipped = state.skippedOccurrenceIds.includes(occurrence.id);
  const completed = state.completedOccurrenceIds.includes(occurrence.id);
  const upcoming = occurrence.kind === 'planned' && segments.length === 0;
  const stateLabel = current
    ? 'Current'
    : paused
      ? 'Paused'
      : skipped
        ? 'Skipped'
        : completed
          ? 'Completed'
          : upcoming
            ? 'Upcoming'
            : 'Recorded';
  const canReorder =
    upcoming && state.nextItem?.id !== occurrence.id && onReorder !== undefined;
  const canActOnCurrent =
    current && occurrence.kind === 'planned' && state.phase === 'running';
  return (
    <div
      className="task-details-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeAndRestore();
      }}
    >
      <section
        ref={panelRef}
        className="task-details"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-details-title"
        style={
          {
            '--anchor-top': `${Math.max(16, Math.min(anchorTop, window.innerHeight - 360))}px`,
          } as CSSProperties
        }
        onPointerDown={(event) => {
          swipeStart.current = event.clientY;
        }}
        onPointerUp={(event) => {
          if (swipeStart.current !== null && event.clientY - swipeStart.current > 90) {
            closeAndRestore();
          }
          swipeStart.current = null;
        }}
      >
        <div className="task-details__grabber" aria-hidden="true" />
        <header className="task-details__header">
          <div>
            <span className="task-details__state">{stateLabel}</span>
            <h2 id="task-details-title">{occurrence.label}</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="task-details__close"
            aria-label="Close task details"
            onClick={closeAndRestore}
          >
            ×
          </button>
        </header>

        <dl className="task-details__times">
          {plannedItem && (
            <>
              <dt>Planned</dt>
              <dd>
                {plannedItem.plannedStart}–{plannedItem.plannedEnd}
              </dd>
            </>
          )}
          {first && (
            <>
              <dt>Actual</dt>
              <dd>
                {formatTimeInZone(first.startedAt, state.timetable.timezone)}
                {last?.endedAt
                  ? `–${formatTimeInZone(last.endedAt, state.timetable.timezone)}`
                  : '–now'}
              </dd>
            </>
          )}
          {segments.length > 1 && (
            <>
              <dt>Segments</dt>
              <dd>{segments.length}</dd>
            </>
          )}
          {first && last?.endedAt && (
            <>
              <dt>Active time</dt>
              <dd>
                {formatStopwatch(
                  segments.reduce(
                    (total, segment) =>
                      total +
                      (segment.endedAt
                        ? segment.endedAt.getTime() - segment.startedAt.getTime()
                        : 0),
                    0,
                  ),
                )}
              </dd>
            </>
          )}
        </dl>

        {editingTimes ? (
          <form
            className="task-time-editor"
            onSubmit={(event) => {
              event.preventDefault();
              if (!onEditTimes) return;
              const replacements: TimelineEventReplacement[] = [];
              for (const segment of segments) {
                const boundaries = [
                  {
                    eventId: segment.startEventId,
                    original: segment.startedAt,
                  },
                  ...(segment.endEventId && segment.endedAt
                    ? [{ eventId: segment.endEventId, original: segment.endedAt }]
                    : []),
                ];
                for (const boundary of boundaries) {
                  const parsed = parseDateTimeInput(
                    timeValues[boundary.eventId] ?? '',
                    state.timetable.timezone,
                  );
                  if (!parsed) {
                    setTimeError('Choose a valid date and time.');
                    return;
                  }
                  if (
                    timeValues[boundary.eventId] !==
                    formatDateTimeInput(boundary.original, state.timetable.timezone)
                  ) {
                    replacements.push({
                      eventId: boundary.eventId,
                      expectedOccurredAt: boundary.original,
                      occurredAt: parsed,
                    });
                  }
                }
              }
              if (replacements.length === 0) {
                setEditingTimes(false);
                return;
              }
              setTimeError(null);
              void onEditTimes(replacements).then((saved) => {
                if (saved) closeAndRestore();
                else setTimeError('These times overlap another task. Choose times in the available range.');
              });
            }}
          >
            {segments.map((segment, index) => (
              <fieldset className="task-time-editor__segment" key={segment.id}>
                {segments.length > 1 && <legend>Segment {index + 1}</legend>}
                <label className="field">
                  <span>{segments.length > 1 ? `Segment ${index + 1} start` : 'Start'}</span>
                  <input
                    type="datetime-local"
                    step="60"
                    value={timeValues[segment.startEventId] ?? ''}
                    disabled={busy}
                    onChange={(event) =>
                      setTimeValues((current) => ({
                        ...current,
                        [segment.startEventId]: event.target.value,
                      }))
                    }
                  />
                </label>
                {segment.endEventId && segment.endedAt && (
                  <label className="field">
                    <span>{segments.length > 1 ? `Segment ${index + 1} end` : 'End'}</span>
                    <input
                      type="datetime-local"
                      step="60"
                      value={timeValues[segment.endEventId] ?? ''}
                      disabled={busy}
                      onChange={(event) =>
                        setTimeValues((current) => ({
                          ...current,
                          [segment.endEventId!]: event.target.value,
                        }))
                      }
                    />
                  </label>
                )}
              </fieldset>
            ))}
            {timeError && (
              <p className="task-time-editor__error" role="alert">
                {timeError}
              </p>
            )}
            <div className="task-composer__actions">
              <button
                type="button"
                className="button button--ghost"
                disabled={busy}
                onClick={() => {
                  setEditingTimes(false);
                  setTimeError(null);
                }}
              >
                Cancel
              </button>
              <button type="submit" className="button button--primary" disabled={busy}>
                Save times
              </button>
            </div>
          </form>
        ) : composing ? (
          <form
            className="task-composer"
            onSubmit={(event) => {
              event.preventDefault();
              if (label.trim().length === 0 || !onStartUnplanned) return;
              void onStartUnplanned(label).then(closeAndRestore);
            }}
          >
            <label className="field">
              <span>Task name</span>
              <input
                ref={inputRef}
                value={label}
                disabled={busy}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <div className="task-composer__actions">
              <button
                type="button"
                className="button button--ghost"
                disabled={busy}
                onClick={() => {
                  setLabel('Between tasks');
                  setComposing(false);
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="button button--primary"
                disabled={busy || label.trim().length === 0}
              >
                Start
              </button>
            </div>
          </form>
        ) : (
          <div className="task-details__actions">
            {canReorder && (
              <button
                type="button"
                className="button button--primary"
                disabled={busy}
                onClick={() => void onReorder(occurrence.id).then(closeAndRestore)}
              >
                Do this next
              </button>
            )}
            {canReorder && <p>Changes today only.</p>}
            {canActOnCurrent && onPause && (
              <button
                type="button"
                className="button button--secondary"
                disabled={busy}
                onClick={() => void onPause().then(closeAndRestore)}
              >
                Pause
              </button>
            )}
            {canActOnCurrent && onStartUnplanned && (
              <button
                type="button"
                className="button button--secondary"
                disabled={busy}
                onClick={() => setComposing(true)}
              >
                Start another task
              </button>
            )}
            {canActOnCurrent && onSkip && (
              <button
                type="button"
                className="button button--ghost"
                disabled={busy}
                onClick={() => void onSkip().then(closeAndRestore)}
              >
                Skip current task
              </button>
            )}
            {segments.length > 0 && onEditTimes && (
              <button
                type="button"
                className="button button--ghost"
                disabled={busy}
                onClick={() => {
                  setComposing(false);
                  setEditingTimes(true);
                }}
              >
                Edit times
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
};

export interface GapTaskPanelProps {
  readonly gapStart: Date;
  readonly gapEnd: Date;
  readonly timezone: string;
  readonly anchorTop: number;
  readonly returnFocus: HTMLElement | null;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onAdd: (label: string) => Promise<boolean>;
}

export const GapTaskPanel = ({
  gapStart,
  gapEnd,
  timezone,
  anchorTop,
  returnFocus,
  busy,
  onClose,
  onAdd,
}: GapTaskPanelProps) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState('Between tasks');
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => {
    onClose();
    window.setTimeout(() => returnFocus?.focus(), 0);
  }, [onClose, returnFocus]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const controls = [
        ...panelRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      const firstControl = controls[0];
      const lastControl = controls[controls.length - 1];
      if (!firstControl || !lastControl) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === firstControl || !panelRef.current.contains(active))) {
        event.preventDefault();
        lastControl.focus();
      } else if (!event.shiftKey && (active === lastControl || !panelRef.current.contains(active))) {
        event.preventDefault();
        firstControl.focus();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [close]);

  return (
    <div
      className="task-details-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={panelRef}
        className="task-details"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gap-task-title"
        style={
          {
            '--anchor-top': `${Math.max(16, Math.min(anchorTop, window.innerHeight - 300))}px`,
          } as CSSProperties
        }
      >
        <div className="task-details__grabber" aria-hidden="true" />
        <header className="task-details__header">
          <div>
            <span className="task-details__state">Between tasks</span>
            <h2 id="gap-task-title">Add a task</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="task-details__close"
            aria-label="Close gap task"
            onClick={close}
          >
            ×
          </button>
        </header>
        <p className="task-details__gap-time">
          {formatTimeInZone(gapStart, timezone)}–{formatTimeInZone(gapEnd, timezone)}
        </p>
        <form
          className="task-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (label.trim().length === 0) return;
            const nextCard =
              returnFocus
                ?.closest('li')
                ?.nextElementSibling?.querySelector<HTMLElement>('.timeline-item__card') ?? null;
            setError(null);
            void onAdd(label).then((saved) => {
              if (!saved) {
                setError('This gap changed before the task was added.');
                return;
              }
              onClose();
              window.setTimeout(() => nextCard?.focus(), 0);
            });
          }}
        >
          <label className="field">
            <span>Task name</span>
            <input
              ref={inputRef}
              value={label}
              disabled={busy}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          {error && (
            <p className="task-time-editor__error" role="alert">
              {error}
            </p>
          )}
          <div className="task-composer__actions">
            <button type="button" className="button button--ghost" disabled={busy} onClick={close}>
              Cancel
            </button>
            <button
              type="submit"
              className="button button--primary"
              disabled={busy || label.trim().length === 0}
            >
              Add task
            </button>
          </div>
        </form>
      </section>
    </div>
  );
};
