/**
 * Report use cases.
 *
 * Reports are derived on demand from stored plans and events; nothing here is
 * cached or persisted, so a report can never disagree with the history.
 */

import {
  buildAggregateReport,
  buildRunReport,
  type AggregateReport,
  type RunReport,
} from '../domain/analysis';
import { QuartzError } from '../domain/errors';
import type { Run } from '../domain/types';
import type { TimetableRepository } from './repository';

export interface CompletedRunSummary {
  readonly run: Run;
  readonly timetableName: string;
  readonly totalPositiveDurationDeviationMs: number;
  readonly skippedCount: number;
  readonly dayStartDeviationMs: number;
  readonly finalCompletionDeviationMs: number | null;
}

export class ReportService {
  constructor(private readonly repository: TimetableRepository) {}

  private async reportFor(run: Run): Promise<RunReport> {
    const timetable = await this.repository.getTimetable(run.timetableId, run.timetableVersion);
    const events = await this.repository.getRunEvents(run.id);
    return buildRunReport(timetable, run, events);
  }

  async loadRunReport(runId: string): Promise<RunReport> {
    const run = await this.repository.getRun(runId);
    if (!run) throw new QuartzError('not-found', `Run ${runId} does not exist.`);
    if (run.status === 'skipped') {
      throw new QuartzError('not-found', 'This day was skipped and is excluded from analysis.');
    }
    return this.reportFor(run);
  }

  async listCompletedRuns(): Promise<CompletedRunSummary[]> {
    const runs = await this.repository.listCompletedRuns();
    const summaries: CompletedRunSummary[] = [];
    for (const run of runs) {
      const report = await this.reportFor(run);
      summaries.push({
        run,
        timetableName: report.timetable.name,
        totalPositiveDurationDeviationMs: report.totalPositiveDurationDeviationMs,
        skippedCount: report.skippedCount,
        dayStartDeviationMs: report.dayStartDeviationMs,
        finalCompletionDeviationMs: report.finalCompletionDeviationMs,
      });
    }
    return summaries;
  }

  /** Aggregate every completed run that used this stable timetable ID, any version. */
  async loadAggregateReport(timetableId: string): Promise<AggregateReport> {
    const runs = (await this.repository.listCompletedRuns()).filter(
      (run) => run.timetableId === timetableId,
    );
    const reports: RunReport[] = [];
    for (const run of runs) reports.push(await this.reportFor(run));

    const name =
      reports[reports.length - 1]?.timetable.name ??
      (await this.repository.listTimetables()).find((t) => t.id === timetableId)?.name ??
      timetableId;

    return buildAggregateReport(timetableId, name, reports);
  }

  /** Timetable IDs that have at least one completed run. */
  async listMeasuredTimetables(): Promise<{ id: string; name: string; runCount: number }[]> {
    const runs = await this.repository.listCompletedRuns();
    const summaries = await this.repository.listTimetables();
    const counts = new Map<string, number>();
    for (const run of runs) {
      counts.set(run.timetableId, (counts.get(run.timetableId) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([id, runCount]) => ({
        id,
        name: summaries.find((summary) => summary.id === id)?.name ?? id,
        runCount,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
