import { useState } from 'react';

import { getLocalDate } from '../../domain/time';
import { isTimetableEligible } from '../../domain/timetable';
import type { Timetable } from '../../domain/types';
import { formatLocalDate } from '../format';
import { navigate } from '../router';
import { useApp } from '../store';
import { EmptyState, Screen } from '../components/Screen';

const byName = (a: Timetable, b: Timetable): number => a.name.localeCompare(b.name);

export const SelectionScreen = () => {
  const {
    services,
    timetables,
    dayDecision,
    activeState,
    busy,
    startRun,
    skipDay,
    notice,
    dismissNotice,
  } = useApp();
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  const now = services.clock.now();
  const eligible = timetables.filter((timetable) => isTimetableEligible(timetable, now));
  const timezone = timetables[0]?.timezone;
  const localDate = timezone ? getLocalDate(now, timezone) : null;
  const active = activeState?.status === 'active' ? activeState : null;

  const start = async (timetable: Timetable) => {
    await startRun({ timetableId: timetable.id, version: timetable.version });
    navigate({ kind: 'run' });
  };

  const confirmSkip = async () => {
    if (await skipDay()) setConfirmingSkip(false);
  };

  return (
    <Screen
      title="Quartz"
      subtitle="Pick the plan you intend to follow today."
      footer={
        <nav className="nav">
          <a href="#/reports">Reports</a>
          <a href="#/data">Backup</a>
        </nav>
      }
    >
      {active && (
        <section className="card card--accent">
          <h2 className="card__title">A day is already running</h2>
          <p className="card__meta">
            {active.timetable.name} · {formatLocalDate(active.run.localDate)}
          </p>
          <p className="card__meta">
            Finish it or skip the day before starting another plan.
          </p>
          <a className="button button--primary" href="#/run">
            Resume day
          </a>
        </section>
      )}

      {notice && (
        <p className="notice" role="status">
          {notice}{' '}
          <button type="button" className="link" onClick={dismissNotice}>
            Dismiss
          </button>
        </p>
      )}

      {dayDecision ? (
        <section className="card card--accent">
          <h2 className="card__title">No tracking today</h2>
          <p className="card__meta">
            {formatLocalDate(dayDecision.localDate)} was skipped. Its activity is excluded from
            analysis.
          </p>
        </section>
      ) : eligible.length === 0 && !active ? (
        <EmptyState>
          No plan is scheduled for {localDate ? formatLocalDate(localDate) : 'today'}. Quartz will
          not track this day.
        </EmptyState>
      ) : (
        <>
          <ul className="list">
            {[...eligible].sort(byName).map((timetable) => (
              <li className="card" key={timetable.id}>
                <h2 className="card__title">{timetable.name}</h2>
                <p className="card__meta">
                  {timetable.items.length} steps ·{' '}
                  {timetable.items[0]?.plannedStart ===
                  timetable.items[timetable.items.length - 1]?.plannedEnd
                    ? 'full day'
                    : `${timetable.items[0]?.plannedStart}–${timetable.items[timetable.items.length - 1]?.plannedEnd}`}{' '}
                  · {timetable.timezone}
                </p>
                {localDate && (
                  <p className="card__meta">Day starts {formatLocalDate(localDate)}</p>
                )}
                <button
                  type="button"
                  className="button button--primary"
                  disabled={busy || active !== null}
                  onClick={() => void start(timetable)}
                >
                  Start day
                </button>
              </li>
            ))}
          </ul>

          {!active && (
            <section className="card">
              {confirmingSkip ? (
                <>
                  <h2 className="card__title">Skip tracking for the whole day?</h2>
                  <p className="card__meta">
                    Quartz will record no measurements for today. This cannot be undone.
                  </p>
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={busy}
                    onClick={() => void confirmSkip()}
                  >
                    Confirm skip day
                  </button>
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={busy}
                    onClick={() => setConfirmingSkip(false)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={busy}
                  onClick={() => setConfirmingSkip(true)}
                >
                  Skip day
                </button>
              )}
            </section>
          )}
        </>
      )}
    </Screen>
  );
};
