import { formatDeviation, formatLocalDate, formatTotalPositive } from '../format';
import { useApp } from '../store';
import { useAsync } from '../useAsync';
import { EmptyState, ErrorNote, Loading, Screen } from '../components/Screen';

export const ReportsScreen = () => {
  const { services } = useApp();
  const data = useAsync(
    async () => ({
      runs: await services.reports.listCompletedRuns(),
      timetables: await services.reports.listMeasuredTimetables(),
    }),
    [services],
  );

  return (
    <Screen
      title="Reports"
      subtitle="Measured days and the steps that cause deviation."
      back={{ label: 'Timetables', route: { kind: 'select' } }}
    >
      {data.status === 'loading' && <Loading />}
      {data.status === 'failed' && <ErrorNote error={data.error} />}

      {data.status === 'ready' && (
        <>
          <h2 className="section-title">Across days</h2>
          {data.value.timetables.length === 0 ? (
            <EmptyState>Complete a day to see which steps cause deviation.</EmptyState>
          ) : (
            <ul className="list">
              {data.value.timetables.map((timetable) => (
                <li className="card" key={timetable.id}>
                  <h3 className="card__title">{timetable.name}</h3>
                  <p className="card__meta">
                    {timetable.runCount} completed {timetable.runCount === 1 ? 'day' : 'days'}
                  </p>
                  <a
                    className="button button--secondary"
                    href={`#/reports/timetable/${encodeURIComponent(timetable.id)}`}
                  >
                    Steps causing deviation
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
