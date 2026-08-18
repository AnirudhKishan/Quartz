import { useState } from 'react';

import type { RunEvent } from '../../domain/types';
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
import { TransitionTimeDialog } from '../components/TransitionTimeDialog';
import { TimelineEditor } from '../components/TimelineEditor';

export const RunReportScreen = ({ runId }: { readonly runId: string }) => {
  const { services } = useApp();
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedTransition, setSelectedTransition] = useState<RunEvent | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [editingTimeline, setEditingTimeline] = useState(false);
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
          <span className={`totals__value tone--${deviationTone(report.finalCompletionDeviationMs)}`}>
            {formatDeviation(report.finalCompletionDeviationMs)}
          </span>
        </div>
        <div className="totals__cell">
          <span className="totals__label">Total overrun</span>
          <span className="totals__value">{formatTotalPositive(report.totalPositiveDurationDeviationMs)}</span>
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
      </section>

      {saveError && <ErrorNote error={saveError} />}
      <div className="report-timeline-heading">
        <h2 className="section-title">Day timeline</h2>
        <button type="button" className="link" onClick={() => setEditingTimeline(true)}>
          Edit timeline
        </button>
      </div>
      {editingTimeline ? (
        <TimelineEditor
          state={state}
          observedAt={services.clock.now()}
          busy={saving}
          onCancel={() => setEditingTimeline(false)}
          onSave={async (replacements) => {
            setSaving(true);
            setSaveError(null);
            try {
              await services.runs.editTimeline(runId, replacements);
              setEditingTimeline(false);
              setReloadKey((value) => value + 1);
              return true;
            } catch (error) {
              setSaveError(error instanceof Error ? error : new Error(String(error)));
              return false;
            } finally {
              setSaving(false);
            }
          }}
        />
      ) : (
        <DayTimeline
          state={state}
          now={services.clock.now()}
          onEditTransition={setSelectedTransition}
        />
      )}

      {selectedTransition && (
        <TransitionTimeDialog
          state={state}
          transition={selectedTransition}
          observedAt={services.clock.now()}
          busy={saving}
          onClose={() => setSelectedTransition(null)}
          onSave={async (correctedAt) => {
            setSaving(true);
            setSaveError(null);
            try {
              await services.runs.correctTransitionTime(
                runId,
                selectedTransition.transitionId,
                selectedTransition.occurredAt,
                correctedAt,
              );
              setSelectedTransition(null);
              setReloadKey((value) => value + 1);
            } catch (error) {
              setSaveError(error instanceof Error ? error : new Error(String(error)));
            } finally {
              setSaving(false);
            }
          }}
        />
      )}
    </Screen>
  );
};
