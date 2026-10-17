import { useEffect, useState } from 'react';

import type { TimelineEventReplacement, TransitionKind } from '../../domain/types';
import { navigate } from '../router';
import { useApp } from '../store';
import { useElapsed } from '../useElapsed';
import { ClearDataControl } from '../components/ClearDataControl';
import { DayTimeline } from '../components/DayTimeline';
import type { TimelineGap } from '../components/DayTimeline';
import { EmptyState, Screen } from '../components/Screen';
import { GapTaskPanel, TaskDetailsPanel } from '../components/TaskDetailsPanel';
import { OverflowMenu } from '../components/OverflowMenu';

interface SelectedActivity {
  readonly id: string;
  readonly anchorTop: number;
  readonly trigger: HTMLElement;
}

interface SelectedGap extends TimelineGap {
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
    recordGapTask,
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
  const [selectedGap, setSelectedGap] = useState<SelectedGap | null>(null);
  const [showUndo, setShowUndo] = useState(false);
  const [showReorder, setShowReorder] = useState(false);
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
  const isFinalSleep = !nextItem && currentActivity?.id === 'sleep';
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
  const remaining = activeState.orderedItems.slice(
    activeState.nextIndex ?? activeState.orderedItems.length,
  );
  const canChangeNext = status === 'active' && remaining.length > 1;
  const changeNextButton = canChangeNext ? (
    <button
      type="button"
      className="button button--ghost sticky-actions__secondary"
      disabled={busy}
      onClick={() => setShowReorder(true)}
    >
      Change next task
    </button>
  ) : null;
  const undoMenuAction = canUndo ? (
    <button
      type="button"
      className="menu-action"
      data-menu-close="true"
      disabled={busy}
      onClick={() => void handleUndo()}
    >
      Undo last action
    </button>
  ) : null;

  return (
    <Screen
      title={completed ? 'Day complete' : timetable.name}
      hideHeader
      className="screen--active-run"
      bodyClassName="active-run"
    >
      {!completed && (
        <p className="sr-only" aria-live="polite">
          {phase === 'paused'
            ? `${resumeTarget?.label ?? 'Task'} paused`
            : `${currentActivity?.label ?? 'Between tasks'} in progress`}
        </p>
      )}

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
          {
            setSelectedGap(null);
            setSelectedActivity({ id, anchorTop, trigger });
          }
        }
        onSelectGap={(gap, anchorTop, trigger) => {
          setSelectedActivity(null);
          setSelectedGap({ ...gap, anchorTop, trigger });
        }}
        autoFocusCurrent={!completed}
      />

      {completed ? (
        <section className="completion-actions">
          {canUndo && (
            <button
              type="button"
              className="button button--secondary"
              disabled={busy}
              onClick={() => void handleUndo()}
            >
              Undo last action
            </button>
          )}
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
          <div className="sticky-actions">
            {changeNextButton}
            <button
              type="button"
              className="button button--dominant"
              disabled={busy || !nextItem}
              onClick={() => void showUndoAfter(startNext)}
            >
              Start {nextItem?.label ?? 'next task'}
            </button>
            <OverflowMenu className="overflow-menu--footer">
              {undoMenuAction}
              <button
                type="button"
                className="menu-action"
                data-menu-close="true"
                disabled={busy}
                onClick={() => setConfirmingSkipDay(true)}
              >
                Skip day
              </button>
              <ClearDataControl compact />
            </OverflowMenu>
          </div>
        </>
      ) : phase === 'paused' ? (
        <div className="sticky-actions">
          {changeNextButton}
          <button
            type="button"
            className="button button--dominant"
            disabled={busy}
            onClick={() => void showUndoAfter(resume)}
          >
            Resume {resumeTarget?.label ?? 'task'}
          </button>
          <OverflowMenu className="overflow-menu--footer">
            {undoMenuAction}
            <button
              type="button"
              className="menu-action"
              data-menu-close="true"
              disabled={busy}
              onClick={() => void showUndoAfter(endPaused)}
            >
              End {resumeTarget?.label ?? 'task'}
            </button>
            <button
              type="button"
              className="menu-action"
              data-menu-close="true"
              disabled={busy}
              onClick={() => setConfirmingSkipDay(true)}
            >
              Skip day
            </button>
            <ClearDataControl compact />
          </OverflowMenu>
        </div>
      ) : (
        <div className="sticky-actions">
          {changeNextButton}
          <button
            type="button"
            className="button button--dominant"
            disabled={busy}
            onClick={() => void handleAdvance('next')}
          >
            {nextItem
              ? `Next: ${nextItem.label}`
              : isFinalSleep
                ? 'Wake up & finish day'
                : 'Finish day'}
          </button>
          <OverflowMenu className="overflow-menu--footer">
            {undoMenuAction}
            {nextItem && (
              <button
                type="button"
                className="menu-action"
                data-menu-close="true"
                disabled={busy}
                onClick={() => void handleAdvance('finish')}
              >
                Finish current task
              </button>
            )}
            {currentActivity?.kind === 'planned' && (
              <button
                type="button"
                className="menu-action"
                data-menu-close="true"
                disabled={busy}
                onClick={() => void showUndoAfter(pause)}
              >
                Pause current task
              </button>
            )}
            <button
              type="button"
              className="menu-action"
              data-menu-close="true"
              disabled={busy}
              onClick={() => setConfirmingSkipDay(true)}
            >
              Skip day
            </button>
            <ClearDataControl compact />
          </OverflowMenu>
        </div>
      )}

      {showUndo && canUndo && (
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

      {selectedActivity && (
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
          onEditTimes={saveTimeline}
        />
      )}

      {selectedGap && (
        <GapTaskPanel
          gapStart={selectedGap.start}
          gapEnd={selectedGap.end}
          timezone={timetable.timezone}
          anchorTop={selectedGap.anchorTop}
          returnFocus={selectedGap.trigger}
          busy={busy}
          onClose={() => setSelectedGap(null)}
          onAdd={(label) =>
            recordGapTask(label, selectedGap.start, selectedGap.end)
          }
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

      {showReorder && (
        <div
          className="modal-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setShowReorder(false);
          }}
        >
          <section
            className="modal-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="change-next-title"
          >
            <h2 id="change-next-title">Change next task</h2>
            <p className="modal-sheet__meta">This changes the order for today only.</p>
            <div className="task-choice-list">
              {remaining.map((item) => (
                <button
                  type="button"
                  className="button button--secondary"
                  disabled={busy || item.id === nextItem?.id}
                  key={item.id}
                  onClick={() => {
                    void reorderUpcoming(item.id).then(() => setShowReorder(false));
                  }}
                >
                  {item.id === nextItem?.id ? `Next: ${item.label}` : item.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="button button--ghost"
              disabled={busy}
              onClick={() => setShowReorder(false)}
            >
              Cancel
            </button>
          </section>
        </div>
      )}
    </Screen>
  );
};
