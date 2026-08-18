import { useState } from 'react';

import type { TimelineEventReplacement } from '../../domain/types';
import {
  deviationTone,
  formatDeviation,
  formatLocalDate,
  formatPercent,
  formatTotalPositive,
} from '../format';
import { useApp } from '../store';
import { useAsync } from '../useAsync';
import { DayTimeline } from '../components/DayTimeline';
import { ErrorNote, Loading, Screen } from '../components/Screen';
import { TaskDetailsPanel } from '../components/TaskDetailsPanel';

interface SelectedActivity {
  readonly id: string;
  readonly anchorTop: number;
  readonly trigger: HTMLElement;
}

export const RunReportScreen = ({ runId }: { readonly runId: string }) => {
  const { services } = useApp();
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedActivity, setSelectedActivity] = useState<SelectedActivity | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const data = useAsync(
    async () => ({
      report: await services.reports.loadRunReport(runId),
      state: await services.runs.loadStateById(runId),
    }),
    [services, runId, reloadKey],
  );

  if (data.status === 'loading') {
    return (
      <Screen title="Day report" back={{ label: 'Reports', route: { kind: 'reports' } }}>
        <Loading />
      </Screen>
    );
  }
  if (data.status === 'failed') {
    return (
      <Screen title="Day report" back={{ label: 'Reports', route: { kind: 'reports' } }}>
        <ErrorNote error={data.error} />
      </Screen>
    );
  }

  const { report, state } = data.value;
  const saveTimeline = async (replacements: readonly TimelineEventReplacement[]) => {
    setSaving(true);
    setSaveError(null);
    try {
      await services.runs.editTimeline(runId, replacements);
      setReloadKey((value) => value + 1);
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error : new Error(String(error)));
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen
      title={formatLocalDate(report.run.localDate)}
      subtitle={`${report.timetable.name} · ${report.timetable.timezone}`}
      back={{ label: 'Reports', route: { kind: 'reports' } }}
    >
      <section className="totals">
        <div className="totals__cell">
          <span className="totals__label">Day started</span>
          <span className={`totals__value tone--${deviationTone(report.dayStartDeviationMs)}`}>
            {formatDeviation(report.dayStartDeviationMs)}
          </span>
        </div>
        <div className="totals__cell">
          <span className="totals__label">Day finished</span>
          <span
            className={`totals__value tone--${deviationTone(report.finalCompletionDeviationMs)}`}
          >
            {formatDeviation(report.finalCompletionDeviationMs)}
          </span>
        </div>
        <div className="totals__cell">
          <span className="totals__label">Total overrun</span>
          <span className="totals__value">
            {formatTotalPositive(report.totalPositiveDurationDeviationMs)}
          </span>
        </div>
        <div className="totals__cell">
          <span className="totals__label">Skipped</span>
          <span className="totals__value">
            {report.skippedCount} of {report.reachedCount} ({formatPercent(report.skipRate)})
          </span>
        </div>
        {report.totalBetweenTasksMs > 0 && (
          <div className="totals__cell">
            <span className="totals__label">Between tasks</span>
            <span className="totals__value">
              {formatTotalPositive(report.totalBetweenTasksMs)}
            </span>
          </div>
        )}
        {report.totalInsertedDurationMs > 0 && (
          <div className="totals__cell">
            <span className="totals__label">Unplanned</span>
            <span className="totals__value">
              {formatTotalPositive(report.totalInsertedDurationMs)}
            </span>
          </div>
        )}
      </section>

      {saveError && <ErrorNote error={saveError} />}
      <div className="report-timeline-heading">
        <h2 className="section-title">Day timeline</h2>
      </div>
      <DayTimeline
        state={state}
        now={services.clock.now()}
        selectedActivityId={selectedActivity?.id}
        onSelectActivity={(id, anchorTop, trigger) =>
          setSelectedActivity({ id, anchorTop, trigger })
        }
        onSaveTimeline={saveTimeline}
        onEditingChange={(editing) => {
          if (editing) setSelectedActivity(null);
        }}
        busy={saving}
        constrainHeight={false}
      />

      {selectedActivity && (
        <TaskDetailsPanel
          state={state}
          activityId={selectedActivity.id}
          anchorTop={selectedActivity.anchorTop}
          returnFocus={selectedActivity.trigger}
          busy={saving}
          onClose={() => setSelectedActivity(null)}
        />
      )}
    </Screen>
  );
};
