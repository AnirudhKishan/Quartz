import { useEffect } from 'react';

import type { BudgetReviewItem } from '../../domain/analysis';
import type { TimeBudgetReview } from '../../application/reportService';
import { formatLocalDate, formatWholeMinutes } from '../format';
import { navigate } from '../router';
import { useApp } from '../store';
import { useAsync } from '../useAsync';
import { EmptyState, ErrorNote, Loading, Screen } from '../components/Screen';

const statusLabel = (status: BudgetReviewItem['status']): string => {
  switch (status) {
    case 'review-budget':
      return 'Review budget';
    case 'consider-buffer':
      return 'Consider a buffer';
    case 'no-increase':
      return 'No increase suggested';
    case 'variable-plan':
      return 'Variable planned duration';
    default:
      return 'Not enough evidence';
  }
};

const increaseFromPlan = (budget: number, planned: number): string =>
  `+${formatWholeMinutes(budget - planned)}`;

const Evidence = ({ item }: { readonly item: BudgetReviewItem }) => (
  <details className="budget-evidence">
    <summary>View recorded days</summary>
    <ul className="budget-evidence__list">
      {item.evidence.map((entry) => (
        <li key={entry.runId}>
          <div>
            <strong>{formatLocalDate(entry.localDate)}</strong>
            <span>
              Planned {formatWholeMinutes(entry.plannedDurationMs)}
              {' · '}
              {entry.state === 'measured' && entry.actualDurationMs !== null
                ? `recorded ${formatWholeMinutes(entry.actualDurationMs)}`
                : entry.state === 'skipped'
                  ? 'skipped'
                  : 'not measured'}
            </span>
          </div>
          <a href={`#/reports/run/${encodeURIComponent(entry.runId)}`}>Open day</a>
        </li>
      ))}
    </ul>
  </details>
);

const BudgetCard = ({ item }: { readonly item: BudgetReviewItem }) => {
  const actionable =
    item.status === 'review-budget' || item.status === 'consider-buffer';

  return (
    <article className={`card budget-card${actionable ? ' card--accent' : ''}`}>
      <header className="budget-card__header">
        <h3 className="card__title">{item.label}</h3>
        <span className="badge">{statusLabel(item.status)}</span>
      </header>

      {item.plannedDurationMs === null ? (
        <p className="card__meta">
          Planned duration varied from {formatWholeMinutes(item.minimumPlannedDurationMs)} to{' '}
          {formatWholeMinutes(item.maximumPlannedDurationMs)} in this sample, so one budget change
          is not comparable.
        </p>
      ) : (
        <dl className="budget-metrics">
          <div>
            <dt>Planned</dt>
            <dd>{formatWholeMinutes(item.plannedDurationMs)}</dd>
          </div>
          <div>
            <dt>Typical recorded</dt>
            <dd>
              {item.typicalDurationMs === null ? '—' : formatWholeMinutes(item.typicalDurationMs)}
            </dd>
          </div>
          <div>
            <dt>Roomier recorded</dt>
            <dd>
              {item.roomierDurationMs === null ? '—' : formatWholeMinutes(item.roomierDurationMs)}
            </dd>
          </div>
        </dl>
      )}

      {item.plannedDurationMs !== null && item.typicalSuggestedBudgetMs !== null && (
        <p className="budget-suggestion">
          Typical budget: <strong>{formatWholeMinutes(item.typicalSuggestedBudgetMs)}</strong>{' '}
          ({increaseFromPlan(item.typicalSuggestedBudgetMs, item.plannedDurationMs)})
        </p>
      )}
      {item.plannedDurationMs !== null && item.roomierSuggestedBudgetMs !== null && (
        <p className="budget-suggestion">
          Roomier budget: <strong>{formatWholeMinutes(item.roomierSuggestedBudgetMs)}</strong>{' '}
          ({increaseFromPlan(item.roomierSuggestedBudgetMs, item.plannedDurationMs)})
        </p>
      )}

      {item.measuredCount > 0 ? (
        <p className="card__meta">
          Over plan by at least 1 min on {item.overBudgetCount} of {item.measuredCount} measured{' '}
          {item.measuredCount === 1 ? 'day' : 'days'}.
          {item.skipCount > 0 && ` ${item.skipCount} skipped.`}
          {item.unmeasuredCount > 0 && ` ${item.unmeasuredCount} not measured.`}
        </p>
      ) : (
        <p className="card__meta">
          No usable duration measurements in the selected days.
          {item.skipCount > 0 && ` ${item.skipCount} skipped.`}
        </p>
      )}
      {item.status === 'insufficient-evidence' && (
        <p className="card__meta">Five measured completions are required for a suggestion.</p>
      )}
      <Evidence item={item} />
    </article>
  );
};

const ReviewContent = ({ review }: { readonly review: TimeBudgetReview }) => {
  const actionable = review.items.filter(
    (item) => item.status === 'review-budget' || item.status === 'consider-buffer',
  );
  const priority = actionable.slice(0, 3);
  const remainingActionable = actionable.slice(3);
  const other = review.items.filter(
    (item) => item.status !== 'review-budget' && item.status !== 'consider-buffer',
  );
  const reviewCount = review.items.filter((item) => item.status === 'review-budget').length;
  const bufferCount = review.items.filter((item) => item.status === 'consider-buffer').length;

  if (review.dayCount === 0) {
    return (
      <EmptyState>
        No completed days use version {review.selectedVersion}. Historical versions stay separate
        so different time budgets are never mixed.
      </EmptyState>
    );
  }

  return (
    <>
      <section className="budget-summary" aria-label="Review summary">
        <strong>
          {reviewCount === 0
            ? 'No typical budgets need an increase'
            : `${reviewCount} ${reviewCount === 1 ? 'budget' : 'budgets'} worth reviewing`}
        </strong>
        <span>
          {bufferCount > 0
            ? `${bufferCount} optional ${bufferCount === 1 ? 'buffer' : 'buffers'}`
            : 'No optional buffers identified'}
        </span>
      </section>

      <p className="budget-caveat">
        These are active-time estimates, not causes of a late finish. A larger budget reallocates
        the day; it does not create time or guarantee an earlier finish.
      </p>

      {priority.length > 0 ? (
        <section aria-labelledby="priority-budgets">
          <h2 className="section-title" id="priority-budgets">
            Suggested review
          </h2>
          <div className="budget-card-list">
            {priority.map((item) => (
              <BudgetCard item={item} key={item.itemId} />
            ))}
          </div>
        </section>
      ) : (
        <EmptyState>
          The selected days do not support a time-budget increase. Steps with limited evidence
          remain available below.
        </EmptyState>
      )}

      {remainingActionable.length > 0 && (
        <details className="budget-group">
          <summary>Show {remainingActionable.length} more suggestions</summary>
          <div className="budget-card-list">
            {remainingActionable.map((item) => (
              <BudgetCard item={item} key={item.itemId} />
            ))}
          </div>
        </details>
      )}

      {other.length > 0 && (
        <details className="budget-group">
          <summary>Other steps ({other.length})</summary>
          <div className="budget-card-list">
            {other.map((item) => (
              <BudgetCard item={item} key={item.itemId} />
            ))}
          </div>
        </details>
      )}
    </>
  );
};

export const TimetableReportScreen = ({
  timetableId,
  selectedVersion,
  currentVersion,
}: {
  readonly timetableId: string;
  readonly selectedVersion: number | null;
  readonly currentVersion: number | null;
}) => {
  const { services, telemetry } = useApp();
  const report = useAsync(
    () =>
      services.reports.loadTimeBudgetReview(timetableId, {
        selectedVersion: selectedVersion ?? undefined,
        currentVersion: currentVersion ?? undefined,
      }),
    [services, timetableId, selectedVersion, currentVersion],
  );

  useEffect(() => {
    if (report.status !== 'ready') return;
    telemetry.trackEvent('time_budget_review_viewed', {
      version: report.value.selectedVersion,
      currentVersion: report.value.currentVersion,
      dayCount: report.value.dayCount,
      excludedRepeatCount: report.value.excludedRepeatCount,
      reviewCount: report.value.items.filter((item) => item.status === 'review-budget').length,
      bufferCount: report.value.items.filter((item) => item.status === 'consider-buffer').length,
    });
  }, [report, telemetry]);

  if (report.status === 'loading') {
    return (
      <Screen title="Time budget review" back={{ label: 'Reports', route: { kind: 'reports' } }}>
        <Loading />
      </Screen>
    );
  }

  if (report.status === 'failed') {
    return (
      <Screen title="Time budget review" back={{ label: 'Reports', route: { kind: 'reports' } }}>
        <ErrorNote error={report.error} />
      </Screen>
    );
  }

  const { value } = report;
  const dateRange =
    value.oldestLocalDate && value.newestLocalDate
      ? value.oldestLocalDate === value.newestLocalDate
        ? formatLocalDate(value.oldestLocalDate)
        : `${formatLocalDate(value.oldestLocalDate)}–${formatLocalDate(value.newestLocalDate)}`
      : 'no measured dates';

  return (
    <Screen
      title="Time budget review"
      subtitle={`${value.timetableName} · version ${value.selectedVersion}${
        value.isCurrentVersion ? ' (current)' : ' (historical)'
      } · ${value.dayCount} ${value.dayCount === 1 ? 'day' : 'days'} · ${dateRange}`}
      back={{ label: 'Reports', route: { kind: 'reports' } }}
    >
      {value.availableVersions.length > 1 && (
        <label className="budget-version">
          <span>Timetable version</span>
          <select
            value={value.selectedVersion}
            onChange={(event) =>
              navigate({
                kind: 'timetable-report',
                timetableId,
                version: Number(event.target.value),
              })
            }
          >
            {value.availableVersions.map((version) => (
              <option value={version} key={version}>
                Version {version}
                {version === value.currentVersion ? ' (current)' : ' (historical)'}
              </option>
            ))}
          </select>
        </label>
      )}

      {value.excludedRepeatCount > 0 && (
        <p className="notice">
          Used the latest completed run for each date; excluded {value.excludedRepeatCount}{' '}
          earlier same-date {value.excludedRepeatCount === 1 ? 'run' : 'runs'}.
        </p>
      )}

      <ReviewContent review={value} />

      <details className="budget-method">
        <summary>How this is calculated</summary>
        <p>
          Quartz uses up to the latest 20 completed dates for this version and only the latest
          completed run on each date. Split tasks are summed from their active segments; pauses,
          gaps, inserted activities, skipped steps, and unfinished measurements are excluded.
        </p>
        <p>
          Typical is the median recorded duration. Roomier is the nearest-rank 75th percentile.
          Suggestions require five measured completions and at least one minute above plan.
          Forgotten or late taps can distort a duration; open the recorded day to correct it.
        </p>
      </details>
    </Screen>
  );
};
