import { getLocalDate } from '../../domain/time';
import type { TimetableSummary } from '../../domain/types';
import { formatLocalDate } from '../format';
import { navigate } from '../router';
import { useApp } from '../store';
import { useAsync } from '../useAsync';
import { EmptyState, ErrorNote, Loading, Screen } from '../components/Screen';

const byNameThenNewest = (a: TimetableSummary, b: TimetableSummary): number =>
  a.name.localeCompare(b.name) || b.version - a.version;

export const SelectionScreen = () => {
  const { services, activeState, busy, startRun, notice, dismissNotice } = useApp();
  const timetables = useAsync(() => services.repository.listTimetables(), [services]);

  const start = async (summary: TimetableSummary) => {
    await startRun({ timetableId: summary.id, version: summary.version });
    navigate({ kind: 'run' });
  };

  return (
    <Screen
      title="Quartz"
      subtitle="Pick the timetable you intend to follow today."
      footer={
        <nav className="nav">
          <a href="#/reports">Reports</a>
          <a href="#/data">Backup</a>
        </nav>
      }
    >
      {activeState && (
        <section className="card card--accent">
          <h2 className="card__title">A day is already running</h2>
          <p className="card__meta">
            {activeState.timetable.name} · {formatLocalDate(activeState.run.localDate)}
          </p>
          <p className="card__meta">
            Finish or complete it before starting another day. Only one run can be active.
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

      {timetables.status === 'loading' && <Loading label="Loading timetables…" />}
      {timetables.status === 'failed' && <ErrorNote error={timetables.error} />}
      {timetables.status === 'ready' && timetables.value.length === 0 && (
        <EmptyState>No timetables are available.</EmptyState>
      )}

      {timetables.status === 'ready' && (
        <ul className="list">
          {[...timetables.value].sort(byNameThenNewest).map((summary) => {
            const localDate = getLocalDate(services.clock.now(), summary.timezone);
            return (
              <li className="card" key={`${summary.id}@${summary.version}`}>
                <h2 className="card__title">
                  {summary.name} <span className="badge">v{summary.version}</span>
                </h2>
                <p className="card__meta">
                  {summary.itemCount} steps · {summary.firstPlannedStart}–{summary.lastPlannedEnd} ·{' '}
                  {summary.timezone}
                </p>
                <p className="card__meta">Day starts {formatLocalDate(localDate)}</p>
                <button
                  type="button"
                  className="button button--primary"
                  disabled={busy || activeState !== null}
                  onClick={() => void start(summary)}
                >
                  Start day
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Screen>
  );
};
