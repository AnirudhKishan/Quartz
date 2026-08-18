import { useEffect, useState } from 'react';

import type { RunEvent, TransitionKind } from '../../domain/types';
import { navigate } from '../router';
import { useApp } from '../store';
import { useElapsed } from '../useElapsed';
import { ClearDataControl } from '../components/ClearDataControl';
import { DayTimeline } from '../components/DayTimeline';
import { EmptyState, Screen } from '../components/Screen';
import { TransitionTimeDialog } from '../components/TransitionTimeDialog';
import { TimelineEditor } from '../components/TimelineEditor';

export const ActiveRunScreen = () => {
  const {
    services,
    activeState,
    busy,
    advance,
    startNext,
    reorderUpcoming,
    undo,
    correctTransitionTime,
    editTimeline,
    skipDay,
    notice,
    dismissNotice,
  } = useApp();
  const [confirmingSkipDay, setConfirmingSkipDay] = useState(false);
  const [selectedTransition, setSelectedTransition] = useState<RunEvent | null>(null);
  const [showUndo, setShowUndo] = useState(false);
  const [editingTimeline, setEditingTimeline] = useState(false);
  const betweenStartedAt =
    activeState?.phase === 'between'
      ? [...activeState.effectiveEvents]
          .reverse()
          .find((event) => event.type === 'completed' || event.type === 'skipped')
          ?.occurredAt ?? null
      : null;
  const elapsed = useElapsed(
    activeState?.phase === 'between'
      ? betweenStartedAt
      : activeState?.currentItemStartedAt ?? null,
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

  const { run, timetable, status, phase, canUndo, currentItem, nextItem } = activeState;
  const completed = status === 'completed';
  const now = services.clock.now();

  const handleAdvance = async (kind: TransitionKind) => {
    await advance(kind);
    setShowUndo(true);
  };

  const handleUndo = async () => {
    await undo();
    setShowUndo(false);
  };

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
              : `${currentItem?.label ?? 'Day'} in progress`}
        </span>
        {!editingTimeline && (
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() => {
              setShowUndo(false);
              setEditingTimeline(true);
            }}
          >
            Edit timeline
          </button>
        )}
        <details className="overflow-menu">
          <summary aria-label="More actions">
            <span className="sr-only">More actions</span>
            <span aria-hidden="true">•••</span>
          </summary>
          <div className="overflow-menu__panel">
            {!completed && (
              <>
              {phase === 'running' && (
                <button
                  type="button"
                  className="menu-action"
                  disabled={busy}
                  onClick={() => void handleAdvance('skip')}
                >
                  Skip current task
                </button>
              )}
              <button
                type="button"
                className="menu-action"
                disabled={busy}
                onClick={() => setConfirmingSkipDay(true)}
              >
                Skip day
              </button>
              </>
            )}
            <ClearDataControl compact />
          </div>
        </details>
      </div>

      {notice && (
        <p className="notice" role="status">
          {notice}{' '}
          <button type="button" className="link" onClick={dismissNotice}>Dismiss</button>
        </p>
      )}

      {editingTimeline ? (
        <TimelineEditor
          state={activeState}
          observedAt={now}
          busy={busy}
          onCancel={() => setEditingTimeline(false)}
          onSave={async (replacements) => {
            const saved = await editTimeline(replacements);
            if (saved) setEditingTimeline(false);
            return saved;
          }}
        />
      ) : (
        <DayTimeline
          state={activeState}
          now={now}
          elapsedMs={elapsed}
          onEditTransition={setSelectedTransition}
          onReorder={(itemId) => void reorderUpcoming(itemId)}
          autoFocusCurrent={!completed}
        />
      )}

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
            <strong>{Math.floor(elapsed / 60_000)}:{String(Math.floor(elapsed / 1000) % 60).padStart(2, '0')}</strong>
            <small>This time is reported separately.</small>
          </section>
          <div className="sticky-actions sticky-actions--single">
            <button
              type="button"
              className="button button--dominant"
              disabled={busy || !nextItem}
              onClick={() => {
                void startNext().then(() => setShowUndo(true));
              }}
            >
              Start {nextItem?.label ?? 'next task'}
            </button>
          </div>
        </>
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

      {showUndo && canUndo && (
        <div
          className={`undo-toast${phase === 'between' ? ' undo-toast--between' : ''}`}
          role="status"
        >
          <span>
            {completed
              ? 'Day completed'
              : phase === 'between'
                ? 'Task finished'
                : `Moved to ${currentItem?.label ?? 'next item'}`}
          </span>
          <button type="button" className="link" disabled={busy} onClick={() => void handleUndo()}>
            Undo
          </button>
          <button type="button" className="undo-toast__dismiss" aria-label="Dismiss Undo" onClick={() => setShowUndo(false)}>
            ×
          </button>
        </div>
      )}

      {selectedTransition && (
        <TransitionTimeDialog
          state={activeState}
          transition={selectedTransition}
          observedAt={now}
          busy={busy}
          onClose={() => setSelectedTransition(null)}
          onSave={async (correctedAt) => {
            if (
              await correctTransitionTime(
                selectedTransition.transitionId,
                selectedTransition.occurredAt,
                correctedAt,
              )
            ) {
              setSelectedTransition(null);
            }
          }}
        />
      )}

      {confirmingSkipDay && (
        <div className="modal-backdrop">
          <section className="modal-sheet" role="alertdialog" aria-modal="true" aria-labelledby="skip-day-title">
            <h2 id="skip-day-title">Stop tracking the whole day?</h2>
            <p className="modal-sheet__meta">
              Everything recorded today will be excluded from analysis. This cannot be undone.
            </p>
            <div className="modal-sheet__actions">
              <button type="button" className="button button--ghost" disabled={busy} onClick={() => setConfirmingSkipDay(false)}>
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
