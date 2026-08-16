import {
  deviationTone,
  formatDeviation,
  formatDuration,
  formatLocalDate,
  formatPercent,
  formatTimeInZone,
  formatTotalPositive,
} from '../format';
import { useApp } from '../store';
import { useAsync } from '../useAsync';
import { ErrorNote, Loading, Screen } from '../components/Screen';

export const RunReportScreen = ({ runId }: { readonly runId: string }) => {
  const { services } = useApp();
  const report = useAsync(() => services.reports.loadRunReport(runId), [services, runId]);

  if (report.status === 'loading') {
    return (
      <Screen title="Day report" back={{ label: 'Reports', route: { kind: 'reports' } }}>
        <Loading />
      </Screen>
    );
  }

  if (report.status === 'failed') {
    return (
      <Screen title="Day report" back={{ label: 'Reports', route: { kind: 'reports' } }}>
        <ErrorNote error={report.error} />
      </Screen>
    );
  }

  const { value } = report;
  const zone = value.timetable.timezone;

  return (
    <Screen
      title={formatLocalDate(value.run.localDate)}
      subtitle={`${value.timetable.name} · v${value.run.timetableVersion}`}
      back={{ label: 'Reports', route: { kind: 'reports' } }}
    >
      <section className="totals">
        <div className="totals__cell">
          <span className="totals__label">Day started</span>
          <span className={`totals__value tone--${deviationTone(value.dayStartDeviationMs)}`}>
            {formatDeviation(value.dayStartDeviationMs)}
          </span>
        </div>
        <div className="totals__cell">
          <span className="totals__label">Day finished</span>
          <span className={`totals__value tone--${deviationTone(value.finalCompletionDeviationMs)}`}>
            {formatDeviation(value.finalCompletionDeviationMs)}
          </span>
        </div>
        <div className="totals__cell">
          <span className="totals__label">Total overrun</span>
          <span className="totals__value">
            {formatTotalPositive(value.totalPositiveDurationDeviationMs)}
          </span>
        </div>
        <div className="totals__cell">
          <span className="totals__label">Skipped</span>
          <span className="totals__value">
            {value.skippedCount} of {value.reachedCount} ({formatPercent(value.skipRate)})
          </span>
        </div>
      </section>

      <h2 className="section-title">Steps</h2>
      <ul className="list">
        {value.observations.map((observation) => (
          <li className="card" key={observation.item.id}>
            <h3 className="card__title">
              {observation.item.label}
              {observation.skipped && <span className="badge badge--warn">Skipped</span>}
              {!observation.reached && <span className="badge">Not reached</span>}
            </h3>
            <p className="card__meta">
              Planned {formatTimeInZone(observation.plannedStartUtc, zone)}–
              {formatTimeInZone(observation.plannedEndUtc, zone)} (
              {formatDuration(observation.plannedDurationMs)})
            </p>
            {observation.actualStart && (
              <p className="card__meta">
                Actual {formatTimeInZone(observation.actualStart, zone)}
                {observation.actualEnd ? `–${formatTimeInZone(observation.actualEnd, zone)}` : ''}
                {observation.actualDurationMs !== null
                  ? ` (${formatDuration(observation.actualDurationMs)})`
                  : ''}
              </p>
            )}
            <p className="card__meta">
              <span className={`tone--${deviationTone(observation.startDeviationMs)}`}>
                Start {formatDeviation(observation.startDeviationMs)}
              </span>
              {' · '}
              <span className={`tone--${deviationTone(observation.durationDeviationMs)}`}>
                Duration {formatDeviation(observation.durationDeviationMs, 'longer')}
              </span>
            </p>
          </li>
        ))}
      </ul>
    </Screen>
  );
};
