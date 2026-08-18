import { useEffect, useState } from 'react';

import type { RunEvent, TransitionKind } from '../../domain/types';
import { navigate } from '../router';
import { useApp } from '../store';
import { useElapsed } from '../useElapsed';
import { ClearDataControl } from '../components/ClearDataControl';
import { DayTimeline } from '../components/DayTimeline';
import { EmptyState, Screen } from '../components/Screen';
import { TransitionTimeDialog } from '../components/TransitionTimeDialog';

export const ActiveRunScreen = () => {
  const {
    services,
    activeState,
    busy,
    advance,
    undo,
    correctTransitionTime,
    skipDay,
    notice,
    dismissNotice,
  } = useApp();
  const [confirmingSkipDay, setConfirmingSkipDay] = useState(false);
  const [selectedTransition, setSelectedTransition] = useState<RunEvent | null>(null);
  const [showUndo, setShowUndo] = useState(false);
  const elapsed = useElapsed(activeState?.currentItemStartedAt ?? null, services.clock);

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

  const { run, timetable, status, canUndo, currentItem } = activeState;
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
            : `${currentItem?.label ?? 'Day'} in progress`}
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
          <button type="button" className="link" onClick={dismissNotice}>Dismiss</button>
        </p>
      )}

      <DayTimeline
        state={activeState}
        now={now}
        elapsedMs={elapsed}
        onEditTransition={setSelectedTransition}
        autoFocusCurrent={!completed}
      />

      {completed ? (
        <section className="completion-actions">
          <a className="button button--primary" href={`#/reports/run/${encodeURIComponent(run.id)}`}>
            See the report
          </a>
        </section>
      ) : (
        <div className="sticky-actions">
          <button
            type="button"
            className="button button--dominant"
            disabled={busy}
            onClick={() => void handleAdvance('next')}
          >
            {activeState.nextItem ? 'Next' : 'Finish day'}
          </button>
          <button
            type="button"
            className="button button--secondary"
            disabled={busy}
            onClick={() => void handleAdvance('skip')}
          >
            Skip
          </button>
        </div>
      )}

      {showUndo && canUndo && (
        <div className="undo-toast" role="status">
          <span>{completed ? 'Day completed' : `Moved to ${currentItem?.label ?? 'next item'}`}</span>
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
            if (await correctTransitionTime(selectedTransition.transitionId, correctedAt)) {
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
