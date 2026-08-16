/** Errors that the domain raises. All are explicit; none are recoverable by guessing. */

export type QuartzErrorCode =
  | 'invalid-timetable'
  | 'invalid-backup'
  | 'corrupt-history'
  | 'stale-state'
  | 'run-already-active'
  | 'ineligible-day'
  | 'day-skipped'
  | 'no-active-run'
  | 'run-completed'
  | 'nothing-to-undo'
  | 'not-found'
  | 'storage-unavailable';

export class QuartzError extends Error {
  readonly code: QuartzErrorCode;
  readonly details: readonly string[];

  constructor(code: QuartzErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'QuartzError';
    this.code = code;
    this.details = details;
  }
}

export const isQuartzError = (error: unknown): error is QuartzError =>
  error instanceof QuartzError;

/** True when the failure means the UI must not offer state-changing actions. */
export const isBlockingError = (error: unknown): boolean =>
  isQuartzError(error) &&
  (error.code === 'storage-unavailable' ||
    error.code === 'corrupt-history' ||
    error.code === 'invalid-timetable');
