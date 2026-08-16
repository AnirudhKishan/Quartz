import {
  deviationTone,
  formatDeviation,
  formatPercent,
  formatTotalPositive,
} from '../format';
import { useApp } from '../store';
import { useAsync } from '../useAsync';
import { EmptyState, ErrorNote, Loading, Screen } from '../components/Screen';

/**
 * The report the spec exists for: which timetable steps most consistently cause
 * the day to deviate, ranked by total overrun across every completed day.
 */
export const TimetableReportScreen = ({ timetableId }: { readonly timetableId: string }) => {
  const { services } = useApp();
  const report = useAsync(
    () => services.reports.loadAggregateReport(timetableId),
    [services, timetableId],
  );

  if (report.status === 'loading') {
    return (
      <Screen title="Steps causing deviation" back={{ label: 'Reports', route: { kind: 'reports' } }}>
        <Loading />
      </Screen>
    );
  }

  if (report.status === 'failed') {
    return (
      <Screen title="Steps causing deviation" back={{ label: 'Reports', route: { kind: 'reports' } }}>
        <ErrorNote error={report.error} />
      </Screen>
    );
  }

  const { value } = report;

  return (
    <Screen
      title="Steps causing deviation"
      subtitle={`${value.timetableName} · ${value.runCount} ${
        value.runCount === 1 ? 'day' : 'days'
      } · versions ${value.versions.join(', ') || '—'}`}
      back={{ label: 'Reports', route: { kind: 'reports' } }}
    >
      <section className="totals">
        <div className="totals__cell">
          <span className="totals__label">Typical day start</span>
          <span className={`totals__value tone--${deviationTone(value.medianDayStartDeviationMs)}`}>
            {formatDeviation(value.medianDayStartDeviationMs)}
          </span>
        </div>
        <div className="totals__cell">
          <span className="totals__label">Typical finish</span>
          <span
            className={`totals__value tone--${deviationTone(value.medianFinalCompletionDeviationMs)}`}
          >
            {formatDeviation(value.medianFinalCompletionDeviationMs)}
          </span>
        </div>
        <div className="totals__cell">
          <span className="totals__label">Total overrun</span>
          <span className="totals__value">
            {formatTotalPositive(value.totalPositiveDurationDeviationMs)}
          </span>
        </div>
      </section>

      {value.items.length === 0 ? (
        <EmptyState>No completed days to measure yet.</EmptyState>
      ) : (
        <ol className="list list--ranked">
          {value.items.map((item, index) => (
            <li className="card" key={item.itemId}>
              <h3 className="card__title">
                <span className="rank">{index + 1}</span> {item.label}
              </h3>
              <p className="card__headline">
                {formatTotalPositive(item.totalPositiveDurationDeviationMs)} over plan
              </p>
              <p className="card__meta">
                Typically{' '}
                <span className={`tone--${deviationTone(item.medianDurationDeviationMs)}`}>
                  {formatDeviation(item.medianDurationDeviationMs, 'longer')}
                </span>{' '}
                and starts{' '}
                <span className={`tone--${deviationTone(item.medianStartDeviationMs)}`}>
                  {formatDeviation(item.medianStartDeviationMs)}
                </span>
              </p>
              <p className="card__meta">
                {item.observations} measured · skipped {item.skipCount} (
                {formatPercent(item.skipRate)})
              </p>
            </li>
          ))}
        </ol>
      )}
      <p className="footnote">
        Skipped steps are never counted as time saved, so skipping cannot improve a step&apos;s
        score.
      </p>
    </Screen>
  );
};
