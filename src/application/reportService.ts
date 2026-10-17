/**
 * Report use cases.
 *
 * Reports are derived on demand from stored plans and events; nothing here is
 * cached or persisted, so a report can never disagree with the history.
 */

import {
  buildRunReport,
  buildTimeBudgetAnalysis,
  type BudgetReviewItem,
  type RunReport,
} from '../domain/analysis';
import { QuartzError } from '../domain/errors';
import type { Run, TimetableSummary } from '../domain/types';
import type { TimetableRepository } from './repository';

export interface CompletedRunSummary {
  readonly run: Run;
  readonly timetableName: string;
  readonly totalPositiveDurationDeviationMs: number;
  readonly skippedCount: number;
  readonly dayStartDeviationMs: number;
  readonly finalCompletionDeviationMs: number | null;
}

export interface TimeBudgetReview {
  readonly timetableId: string;
  readonly timetableName: string;
  readonly selectedVersion: number;
  readonly currentVersion: number | null;
  readonly availableVersions: readonly number[];
  readonly isCurrentVersion: boolean;
  readonly dayCount: number;
  readonly oldestLocalDate: string | null;
  readonly newestLocalDate: string | null;
  readonly excludedRepeatCount: number;
  readonly items: readonly BudgetReviewItem[];
}

const compareRunsLatestFirst = (a: Run, b: Run): number => {
  const completedDifference =
    (b.completedAt?.getTime() ?? -Infinity) - (a.completedAt?.getTime() ?? -Infinity);
  if (completedDifference !== 0) return completedDifference;
  const startedDifference = b.startedAt.getTime() - a.startedAt.getTime();
  if (startedDifference !== 0) return startedDifference;
  return b.id.localeCompare(a.id);
};

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

  async loadTimeBudgetReview(
    timetableId: string,
    options: {
      readonly selectedVersion?: number;
      readonly currentVersion?: number;
    } = {},
  ): Promise<TimeBudgetReview> {
    const summaries = (await this.repository.listTimetables()).filter(
      (summary) => summary.id === timetableId,
    );
    const availableVersions = [...new Set(summaries.map((summary) => summary.version))].sort(
      (a, b) => a - b,
    );
    const selectedVersion =
      options.selectedVersion ??
      options.currentVersion ??
      availableVersions[availableVersions.length - 1];
    if (selectedVersion === undefined || !availableVersions.includes(selectedVersion)) {
      throw new QuartzError(
        'not-found',
        `Timetable ${timetableId}${selectedVersion === undefined ? '' : `@${selectedVersion}`} is not available.`,
      );
    }
    const timetable = await this.repository.getTimetable(timetableId, selectedVersion);
    const eligibleRuns = (await this.repository.listCompletedRuns()).filter(
      (run) => run.timetableId === timetableId && run.timetableVersion === selectedVersion,
    );
    const runsByDate = new Map<string, Run[]>();
    for (const run of eligibleRuns) {
      const sameDate = runsByDate.get(run.localDate) ?? [];
      sameDate.push(run);
      runsByDate.set(run.localDate, sameDate);
    }
    const selectedDates = [...runsByDate.keys()].sort((a, b) => b.localeCompare(a)).slice(0, 20);
    const selectedRuns = selectedDates.map((localDate) => {
      const runs = runsByDate.get(localDate);
      if (!runs) throw new Error(`Missing runs for ${localDate}.`);
      return [...runs].sort(compareRunsLatestFirst)[0]!;
    });
    const excludedRepeatCount = selectedDates.reduce(
      (total, localDate) => total + Math.max(0, (runsByDate.get(localDate)?.length ?? 0) - 1),
      0,
    );
    const reports: RunReport[] = [];
    for (const run of selectedRuns) reports.push(await this.reportFor(run));
    const analysis = buildTimeBudgetAnalysis(timetable, reports);

    return {
      timetableId,
      timetableName: timetable.name,
      selectedVersion,
      currentVersion: options.currentVersion ?? null,
      availableVersions,
      isCurrentVersion: options.currentVersion === selectedVersion,
      dayCount: selectedRuns.length,
      oldestLocalDate: selectedDates[selectedDates.length - 1] ?? null,
      newestLocalDate: selectedDates[0] ?? null,
      excludedRepeatCount,
      items: analysis.items,
    };
  }

  /** Timetable IDs that have at least one completed run. */
  async listMeasuredTimetables(): Promise<
    { id: string; name: string; runCount: number; versions: readonly number[] }[]
  > {
    const runs = await this.repository.listCompletedRuns();
    const summaries = await this.repository.listTimetables();
    const counts = new Map<string, number>();
    const versions = new Map<string, Set<number>>();
    for (const run of runs) {
      counts.set(run.timetableId, (counts.get(run.timetableId) ?? 0) + 1);
      const measuredVersions = versions.get(run.timetableId) ?? new Set<number>();
      measuredVersions.add(run.timetableVersion);
      versions.set(run.timetableId, measuredVersions);
    }
    return [...counts.entries()]
      .map(([id, runCount]) => ({
        id,
        name: latestSummary(summaries, id)?.name ?? id,
        runCount,
        versions: [...(versions.get(id) ?? [])].sort((a, b) => a - b),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

const latestSummary = (
  summaries: readonly TimetableSummary[],
  timetableId: string,
): TimetableSummary | undefined =>
  summaries
    .filter((summary) => summary.id === timetableId)
    .sort((a, b) => b.version - a.version)[0];
