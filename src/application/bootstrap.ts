/**
 * Application start-up.
 *
 * Storage is opened, bundled plans are seeded or replaced, and any active run is
 * reconstructed and validated *before* the UI offers a single action. A failure
 * here is reported explicitly rather than worked around.
 */

import { systemClock, type Clock } from '../domain/clock';
import { QuartzError, isQuartzError } from '../domain/errors';
import type { RunState, Timetable } from '../domain/types';
import { BackupService } from './backupService';
import { ReportService } from './reportService';
import type { TimetableRepository } from './repository';
import { RunService } from './runService';

export interface Services {
  readonly repository: TimetableRepository;
  readonly runs: RunService;
  readonly reports: ReportService;
  readonly backups: BackupService;
  readonly clock: Clock;
}

export const createServices = (
  repository: TimetableRepository,
  clock: Clock = systemClock,
): Services => ({
  repository,
  runs: new RunService(repository, clock),
  reports: new ReportService(repository),
  backups: new BackupService(repository, clock),
  clock,
});

export type BootstrapOutcome =
  | { readonly kind: 'ready'; readonly activeState: RunState | null }
  | { readonly kind: 'failed'; readonly error: QuartzError };

export interface BootstrapOptions {
  readonly bundledTimetables: readonly Timetable[];
}

export const bootstrap = async (
  services: Services,
  options: BootstrapOptions,
): Promise<BootstrapOutcome> => {
  try {
    for (const timetable of options.bundledTimetables) {
      await services.repository.saveTimetable(timetable);
    }
    const activeState = await services.runs.loadActiveState();
    return { kind: 'ready', activeState };
  } catch (error) {
    return {
      kind: 'failed',
      error: isQuartzError(error)
        ? error
        : new QuartzError(
            'storage-unavailable',
            'Quartz could not start.',
            error instanceof Error ? [error.message] : [],
          ),
    };
  }
};
