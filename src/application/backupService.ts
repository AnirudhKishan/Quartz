/**
 * Backup and restore use cases.
 *
 * A restore is destructive, so the document is parsed and fully validated before
 * the repository is touched. If validation fails, nothing is written.
 */

import {
  BACKUP_VERSION,
  createBackupDocument,
  parseBackupDocument,
  type BackupData,
} from '../domain/backup';
import { systemClock, type Clock } from '../domain/clock';
import { QuartzError } from '../domain/errors';
import type { TimetableRepository } from './repository';

export interface BackupPreview {
  readonly data: BackupData;
  readonly timetableCount: number;
  readonly runCount: number;
  readonly eventCount: number;
  readonly hasActiveRun: boolean;
}

export class BackupService {
  constructor(
    private readonly repository: TimetableRepository,
    private readonly clock: Clock = systemClock,
  ) {}

  async exportToJson(): Promise<string> {
    const data = await this.repository.exportAll();
    return `${JSON.stringify(createBackupDocument(data, this.clock.now()), null, 2)}\n`;
  }

  suggestedFileName(): string {
    const stamp = this.clock.now().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `quartz-backup-v${BACKUP_VERSION}-${stamp}.json`;
  }

  /** Validate without writing, so the user can confirm against real numbers. */
  preview(text: string): BackupPreview {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new QuartzError(
        'invalid-backup',
        'The file is not valid JSON.',
        error instanceof Error ? [error.message] : [],
      );
    }
    const data = parseBackupDocument(raw);
    return {
      data,
      timetableCount: data.timetables.length,
      runCount: data.runs.length,
      eventCount: data.events.length,
      hasActiveRun: data.runs.some((run) => run.status === 'active'),
    };
  }

  /** Replace all local data. Only call with a preview the user has confirmed. */
  async restore(preview: BackupPreview): Promise<void> {
    await this.repository.replaceAll(preview.data);
  }
}
