import { useEffect } from 'react';

import { formatDeviation, formatLocalDate, formatTotalPositive } from '../format';
import { useApp } from '../store';
import { useAsync } from '../useAsync';
import { EmptyState, ErrorNote, Loading, Screen } from '../components/Screen';

export const ReportsScreen = () => {
  const { services, telemetry } = useApp();
  const data = useAsync(
    async () => ({
      runs: await services.reports.listCompletedRuns(),
      timetables: await services.reports.listMeasuredTimetables(),
    }),
    [services],
  );

  useEffect(() => {
    if (data.status !== 'ready') return;
    telemetry.trackEvent('reports_overview_viewed', {
      completedRunCount: data.value.runs.length,
      measuredTimetableCount: data.value.timetables.length,
      totalSkippedCount: data.value.runs.reduce((total, run) => total + run.skippedCount, 0),
      totalOverrunMs: data.value.runs.reduce(
        (total, run) => total + run.totalPositiveDurationDeviationMs,
        0,
      ),
    });
  }, [data, telemetry]);

  return (
    <Screen
      title="Reports"
      subtitle="Measured days and evidence-based time budgets."
      back={{ label: 'Timetables', route: { kind: 'select' } }}
    >
      {data.status === 'loading' && <Loading />}
      {data.status === 'failed' && <ErrorNote error={data.error} />}

      {data.status === 'ready' && (
        <>
          <h2 className="section-title">Across days</h2>
          {data.value.timetables.length === 0 ? (
            <EmptyState>Complete a day to review its recorded time budgets.</EmptyState>
          ) : (
            <ul className="list">
              {data.value.timetables.map((timetable) => (
                <li className="card" key={timetable.id}>
                  <h3 className="card__title">{timetable.name}</h3>
                  <p className="card__meta">
                    {timetable.runCount} completed {timetable.runCount === 1 ? 'day' : 'days'}
                    {' · '}
                    {timetable.versions.length === 1
                      ? `version ${timetable.versions[0]}`
                      : `versions ${timetable.versions.join(', ')}`}
                  </p>
                  <a
                    className="button button--secondary"
                    href={`#/reports/timetable/${encodeURIComponent(timetable.id)}`}
                  >
                    Time budget review
                  </a>
                </li>
              ))}
            </ul>
          )}

          <h2 className="section-title">Completed days</h2>
          {data.value.runs.length === 0 ? (
            <EmptyState>No days have been completed yet.</EmptyState>
          ) : (
            <ul className="list">
              {data.value.runs.map((summary) => (
                <li className="card" key={summary.run.id}>
                  <h3 className="card__title">{formatLocalDate(summary.run.localDate)}</h3>
                  <p className="card__meta">
                    {summary.timetableName} · v{summary.run.timetableVersion}
                  </p>
                  <p className="card__meta">
                    Started {formatDeviation(summary.dayStartDeviationMs)} · finished{' '}
                    {formatDeviation(summary.finalCompletionDeviationMs)}
                  </p>
                  <p className="card__meta">
                    Overrun {formatTotalPositive(summary.totalPositiveDurationDeviationMs)} ·{' '}
                    {summary.skippedCount} skipped
                  </p>
                  <a
                    className="button button--secondary"
                    href={`#/reports/run/${encodeURIComponent(summary.run.id)}`}
                  >
                    Open day
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Screen>
  );
};
