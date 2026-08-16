/**
 * Use cases for operating a run.
 *
 * The service owns nothing: it reads state through the repository, asks the
 * domain what to write, and hands failures back untouched so the UI can decide
 * whether they are recoverable.
 */

import { systemClock, type Clock } from '../domain/clock';
import { QuartzError } from '../domain/errors';
import { reconstructRunState } from '../domain/runState';
import type { Run, RunState, TimetableRef, TransitionKind } from '../domain/types';
import type { TimetableRepository } from './repository';

export class RunService {
  constructor(
    private readonly repository: TimetableRepository,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Rebuild the active run, or null when there is none. Throws on corruption. */
  async loadActiveState(): Promise<RunState | null> {
    const run = await this.repository.getActiveRun();
    if (!run) return null;
    return this.loadState(run);
  }

  async loadState(run: Run): Promise<RunState> {
    const timetable = await this.repository.getTimetable(run.timetableId, run.timetableVersion);
    const events = await this.repository.getRunEvents(run.id);
    return reconstructRunState(timetable, run, events);
  }

  async loadStateById(runId: string): Promise<RunState> {
    const run = await this.repository.getRun(runId);
    if (!run) throw new QuartzError('not-found', `Run ${runId} does not exist.`);
    return this.loadState(run);
  }

  async startRun(ref: TimetableRef): Promise<RunState> {
    const run = await this.repository.createRun(ref, this.clock.now());
    return this.loadState(run);
  }

  /**
   * Advance the run.
   *
   * One press produces one timestamp, and the preconditions taken from the state
   * the user actually saw are what make a repeated press a no-op rather than a
   * second transition.
   */
  async advance(state: RunState, kind: TransitionKind): Promise<RunState> {
    if (!state.currentItem) {
      throw new QuartzError('run-completed', 'This run has already been completed.');
    }
    await this.repository.appendTransition({
      runId: state.run.id,
      kind,
      occurredAt: this.clock.now(),
      expectedItemId: state.currentItem.id,
      expectedSeq: state.lastSeq,
    });
    return this.loadStateById(state.run.id);
  }

  async undo(state: RunState): Promise<RunState> {
    await this.repository.undoLastTransition(state.run.id, this.clock.now());
    return this.loadStateById(state.run.id);
  }
}
