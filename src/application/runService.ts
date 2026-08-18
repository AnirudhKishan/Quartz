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
import { getLocalDate } from '../domain/time';
import type {
  DayDecision,
  EditTimelineCommand,
  Run,
  RunState,
  TimetableRef,
  TransitionKind,
} from '../domain/types';
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

  async skipDay(timezone: string, activeState: RunState | null): Promise<DayDecision> {
    const occurredAt = this.clock.now();
    return this.repository.skipDay({
      timezone,
      localDate: activeState?.run.localDate ?? getLocalDate(occurredAt, timezone),
      occurredAt,
      activeRunId: activeState?.run.id ?? null,
    });
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

  async startNext(state: RunState): Promise<RunState> {
    if (state.phase !== 'between' || !state.nextItem) {
      throw new QuartzError('stale-state', 'There is no task waiting to start.');
    }
    await this.repository.startNext({
      runId: state.run.id,
      itemId: state.nextItem.id,
      occurredAt: this.clock.now(),
      expectedSeq: state.lastSeq,
    });
    return this.loadStateById(state.run.id);
  }

  async reorderUpcoming(state: RunState, itemId: string): Promise<RunState> {
    await this.repository.reorderRun({
      runId: state.run.id,
      itemId,
      expectedSeq: state.lastSeq,
      expectedOrder: state.orderedItems.map((item) => item.id),
    });
    return this.loadStateById(state.run.id);
  }

  async undo(state: RunState): Promise<RunState> {
    await this.repository.undoLastTransition(state.run.id, this.clock.now());
    return this.loadStateById(state.run.id);
  }

  async correctTransitionTime(
    runId: string,
    transitionId: string,
    expectedOccurredAt: Date,
    correctedAt: Date,
  ): Promise<RunState> {
    const state = await this.loadStateById(runId);
    await this.repository.correctTransitionTime({
      runId,
      transitionId,
      expectedOccurredAt,
      correctedAt,
      observedAt: this.clock.now(),
      expectedSeq: state.lastSeq,
    });
    return this.loadStateById(runId);
  }

  async editTimeline(
    runId: string,
    replacements: EditTimelineCommand['replacements'],
  ): Promise<RunState> {
    const state = await this.loadStateById(runId);
    await this.repository.editTimeline({
      runId,
      replacements,
      observedAt: this.clock.now(),
      expectedSeq: state.lastSeq,
    });
    return this.loadStateById(runId);
  }
}
