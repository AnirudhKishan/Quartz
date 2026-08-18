import { useEffect, useState } from 'react';

import type { TimelineEventReplacement, TransitionKind } from '../../domain/types';
import { navigate } from '../router';
import { useApp } from '../store';
import { useElapsed } from '../useElapsed';
import { ClearDataControl } from '../components/ClearDataControl';
import { DayTimeline } from '../components/DayTimeline';
import { EmptyState, Screen } from '../components/Screen';
import { TaskDetailsPanel } from '../components/TaskDetailsPanel';

interface SelectedActivity {
  readonly id: string;
  readonly anchorTop: number;
  readonly trigger: HTMLElement;
}

export const ActiveRunScreen = () => {
  const {
    services,
    activeState,
    busy,
    advance,
    startNext,
    startUnplanned,
    pause,
    resume,
    endPaused,
    reorderUpcoming,
    undo,
    editTimeline,
    skipDay,
    notice,
    dismissNotice,
  } = useApp();
  const [confirmingSkipDay, setConfirmingSkipDay] = useState(false);
  const [selectedActivity, setSelectedActivity] = useState<SelectedActivity | null>(null);
  const [showUndo, setShowUndo] = useState(false);
  const [editingTimeline, setEditingTimeline] = useState(false);
  const betweenStartedAt =
    activeState?.phase === 'between'
      ? [...activeState.effectiveEvents]
          .reverse()
          .find(
            (event) =>
              event.type === 'completed' ||
              event.type === 'skipped' ||
              event.type === 'paused',
          )?.occurredAt ?? null
      : null;
  const elapsed = useElapsed(
    activeState?.phase === 'between'
      ? betweenStartedAt
      : activeState?.currentActivityStartedAt ?? null,
    services.clock,
  );

  useEffect(() => {
    if (!showUndo) return undefined;
    const timer = window.setTimeout(() => setShowUndo(false), 8_000);
    return () => window.clearTimeout(timer);
  }, [showUndo]);

  if (!activeState) {
    return (
      <Screen title="No day running" back={{ label: 'Timetables', route: { kind: 'select' } }}>
        <EmptyState>Start a day from the timetable list.</EmptyState>
      </Screen>
    );
  }

  const {
    run,
    timetable,
    status,
    phase,
    canUndo,
    currentActivity,
    resumeTarget,
    nextItem,
  } = activeState;
  const completed = status === 'completed';
  const now = services.clock.now();

  const showUndoAfter = async (action: () => Promise<void>) => {
    await action();
    setShowUndo(true);
  };
  const handleAdvance = (kind: TransitionKind) =>
    showUndoAfter(() => advance(kind));
  const handleUndo = async () => {
    await undo();
    setShowUndo(false);
  };
  const saveTimeline = async (replacements: readonly TimelineEventReplacement[]) =>
    editTimeline(replacements);

  return (
    <Screen
      title={completed ? 'Day complete' : timetable.name}
      subtitle={`${run.localDate} · ${timetable.timezone}`}
      footer={
        <nav className="nav">
          <button type="button" className="link" onClick={() => navigate({ kind: 'reports' })}>
            Reports
          </button>
        </nav>
      }
    >
      <div className="day-toolbar">
        <span>
          {completed
            ? 'Every step is recorded.'
            : phase === 'between'
              ? 'Between tasks'
              : phase === 'paused'
                ? `${resumeTarget?.label ?? 'Task'} paused`
                : `${currentActivity?.label ?? 'Day'} in progress`}
        </span>
        <details className="overflow-menu">
          <summary aria-label="More actions">
            <span className="sr-only">More actions</span>
            <span aria-hidden="true">•••</span>
          </summary>
          <div className="overflow-menu__panel">
            {!completed && (
              <button
                type="button"
                className="menu-action"
                disabled={busy}
                onClick={() => setConfirmingSkipDay(true)}
              >
                Skip day
              </button>
            )}
            <ClearDataControl compact />
          </div>
        </details>
      </div>

      {notice && (
        <p className="notice" role="status">
          {notice}{' '}
          <button type="button" className="link" onClick={dismissNotice}>
            Dismiss
          </button>
        </p>
      )}

      <DayTimeline
        state={activeState}
        now={now}
        elapsedMs={elapsed}
        selectedActivityId={selectedActivity?.id}
        onSelectActivity={(id, anchorTop, trigger) =>
          setSelectedActivity({ id, anchorTop, trigger })
        }
        onSaveTimeline={saveTimeline}
        onEditingChange={(editing) => {
          setEditingTimeline(editing);
          if (editing) setSelectedActivity(null);
        }}
        busy={busy}
        autoFocusCurrent={!completed}
      />

      {editingTimeline ? null : completed ? (
        <section className="completion-actions">
          <a className="button button--primary" href={`#/reports/run/${encodeURIComponent(run.id)}`}>
            See the report
          </a>
        </section>
      ) : phase === 'between' ? (
        <>
          <section className="between-summary" aria-live="polite">
            <span>Between tasks</span>
            <strong>
              {Math.floor(elapsed / 60_000)}:
              {String(Math.floor(elapsed / 1000) % 60).padStart(2, '0')}
            </strong>
            <small>This time is reported separately.</small>
          </section>
          <div className="sticky-actions sticky-actions--single">
            <button
              type="button"
              className="button button--dominant"
              disabled={busy || !nextItem}
              onClick={() => void showUndoAfter(startNext)}
            >
              Start {nextItem?.label ?? 'next task'}
            </button>
          </div>
        </>
      ) : phase === 'paused' ? (
        <div className="sticky-actions">
          <button
            type="button"
            className="button button--dominant"
            disabled={busy}
            onClick={() => void showUndoAfter(resume)}
          >
            Resume {resumeTarget?.label ?? 'task'}
          </button>
          <button
            type="button"
            className="button button--secondary"
            disabled={busy}
            onClick={() => void showUndoAfter(endPaused)}
          >
            End {resumeTarget?.label ?? 'task'}
          </button>
        </div>
      ) : (
        <div className="sticky-actions">
          <button
            type="button"
            className="button button--dominant"
            disabled={busy}
            onClick={() => void handleAdvance('next')}
          >
            {nextItem ? 'Next' : 'Finish day'}
          </button>
          {nextItem && (
            <button
              type="button"
              className="button button--secondary"
              disabled={busy}
              onClick={() => void handleAdvance('finish')}
            >
              Finish
            </button>
          )}
        </div>
      )}

      {showUndo && canUndo && !editingTimeline && (
        <div
          className={`undo-toast${phase === 'between' ? ' undo-toast--between' : ''}`}
          role="status"
        >
          <span>
            {completed
              ? 'Day completed'
              : phase === 'paused'
                ? `${resumeTarget?.label ?? 'Task'} paused`
                : phase === 'between'
                  ? 'Task finished'
                  : `Now tracking ${currentActivity?.label ?? 'the day'}`}
          </span>
          <button type="button" className="link" disabled={busy} onClick={() => void handleUndo()}>
            Undo
          </button>
          <button
            type="button"
            className="undo-toast__dismiss"
            aria-label="Dismiss Undo"
            onClick={() => setShowUndo(false)}
          >
            ×
          </button>
        </div>
      )}

      {selectedActivity && !editingTimeline && (
        <TaskDetailsPanel
          state={activeState}
          activityId={selectedActivity.id}
          anchorTop={selectedActivity.anchorTop}
          returnFocus={selectedActivity.trigger}
          busy={busy}
          onClose={() => setSelectedActivity(null)}
          onReorder={(itemId) => reorderUpcoming(itemId)}
          onPause={() => showUndoAfter(pause)}
          onStartUnplanned={(label) => showUndoAfter(() => startUnplanned(label))}
          onSkip={() => handleAdvance('skip')}
        />
      )}

      {confirmingSkipDay && (
        <div className="modal-backdrop">
          <section
            className="modal-sheet"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="skip-day-title"
          >
            <h2 id="skip-day-title">Stop tracking the whole day?</h2>
            <p className="modal-sheet__meta">
              Everything recorded today will be excluded from analysis. This cannot be undone.
            </p>
            <div className="modal-sheet__actions">
              <button
                type="button"
                className="button button--ghost"
                disabled={busy}
                onClick={() => setConfirmingSkipDay(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button--secondary"
                disabled={busy}
                onClick={() => {
                  void skipDay().then((skipped) => {
                    if (skipped) navigate({ kind: 'select' });
                  });
                }}
              >
                Confirm skip day
              </button>
            </div>
          </section>
        </div>
      )}
    </Screen>
  );
};
