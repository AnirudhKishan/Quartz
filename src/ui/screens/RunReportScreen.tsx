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

export const RunReportScreen = ({ runId }: { readonly runId: string }) => {
  const { services } = useApp();
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedTransition, setSelectedTransition] = useState<RunEvent | null>(null);
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
      </section>

      {saveError && <ErrorNote error={saveError} />}
      <h2 className="section-title">Day timeline</h2>
      <DayTimeline
        state={state}
        now={services.clock.now()}
        onEditTransition={setSelectedTransition}
      />

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
