import { computePlannedSchedule } from '../../domain/analysis';
import { formatDeviation, formatStopwatch, formatTimeInZone } from '../format';
import { navigate } from '../router';
import { useApp } from '../store';
import { useElapsed } from '../useElapsed';
import { EmptyState, Screen } from '../components/Screen';

export const ActiveRunScreen = () => {
  const { services, activeState, busy, advance, undo, skipDay, notice, dismissNotice } = useApp();
  const [confirmingSkipDay, setConfirmingSkipDay] = useState(false);
  const elapsed = useElapsed(activeState?.currentItemStartedAt ?? null, services.clock);

  if (!activeState) {
    return (
      <Screen title="No day running" back={{ label: 'Timetables', route: { kind: 'select' } }}>
        <EmptyState>Start a day from the timetable list.</EmptyState>
      </Screen>
    );
  }

  const { run, timetable, currentItem, currentIndex, nextItem, canUndo, status } = activeState;
  const planned = computePlannedSchedule(timetable, run.localDate);

  if (status === 'completed' || !currentItem || currentIndex === null) {
    return (
      <Screen title="Day complete" subtitle={timetable.name}>
        <section className="card card--accent">
          <h2 className="card__title">Every step is recorded</h2>
          <p className="card__meta">
            Finished at{' '}
            {run.completedAt ? formatTimeInZone(run.completedAt, timetable.timezone) : '—'}
          </p>
          <a className="button button--primary" href={`#/reports/run/${encodeURIComponent(run.id)}`}>
            See the report
          </a>
          <button
            type="button"
            className="button button--ghost"
            disabled={busy || !canUndo}
            onClick={() => void undo()}
          >
            Undo last step
          </button>
        </section>
        <nav className="nav">
          <a href="#/">Timetables</a>
          <a href="#/reports">Reports</a>
        </nav>
      </Screen>
    );
  }

  const currentPlan = planned[currentIndex];
  const startDeviation = activeState.currentItemStartedAt && currentPlan
    ? activeState.currentItemStartedAt.getTime() - currentPlan.plannedStartUtc.getTime()
    : null;

  return (
    <Screen title={timetable.name} subtitle={`Step ${currentIndex + 1} of ${timetable.items.length}`}>
      <section className="current" aria-live="polite">
        <h2 className="current__label">{currentItem.label}</h2>
        {currentPlan && (
          <p className="current__planned">
            {`Planned ${formatTimeInZone(currentPlan.plannedStartUtc, timetable.timezone)} – ${formatTimeInZone(currentPlan.plannedEndUtc, timetable.timezone)}`}
          </p>
        )}
        <p className="current__elapsed" aria-label="Time in this step">
          {formatStopwatch(elapsed)}
        </p>
        <p className="current__deviation">{`Started ${formatDeviation(startDeviation)}`}</p>
      </section>

      {notice && (
        <p className="notice" role="status">
          {notice}{' '}
          <button type="button" className="link" onClick={dismissNotice}>
            Dismiss
          </button>
        </p>
      )}

      <section className="actions">
        <button
          type="button"
          className="button button--dominant"
          disabled={busy}
          onClick={() => void advance('next')}
        >
          {nextItem ? 'Next' : 'Finish day'}
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={busy}
          onClick={() => void advance('skip')}
        >
          Skip
        </button>
        <button
          type="button"
          className="button button--ghost"
          disabled={busy || !canUndo}
          onClick={() => void undo()}
        >
          Undo
        </button>
      </section>

      <section className="card">
        {confirmingSkipDay ? (
          <>
            <h3 className="card__title">Stop tracking the whole day?</h3>
            <p className="card__meta">
              Everything recorded today will be excluded from analysis. This cannot be undone.
            </p>
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
            <button
              type="button"
              className="button button--ghost"
              disabled={busy}
              onClick={() => setConfirmingSkipDay(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button button--ghost"
            disabled={busy}
            onClick={() => setConfirmingSkipDay(true)}
          >
            Skip day
          </button>
        )}
      </section>

      <section className="up-next">
        <h3 className="up-next__title">Up next</h3>
        {nextItem ? (
          <p className="up-next__item">
            {nextItem.label}
            <span className="up-next__time">
              {planned[currentIndex + 1]
                ? ` · ${formatTimeInZone(planned[currentIndex + 1]!.plannedStartUtc, timetable.timezone)}`
                : ''}
            </span>
          </p>
        ) : (
          <p className="up-next__item">This is the last step of the day.</p>
        )}      </section>

      <nav className="nav">
        <button type="button" className="link" onClick={() => navigate({ kind: 'reports' })}>
          Reports
        </button>
      </nav>
    </Screen>
  );
};
import { useState } from 'react';
