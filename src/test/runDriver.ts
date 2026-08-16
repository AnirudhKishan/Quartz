import { reconstructRunState } from '../domain/runState';
import { applyRunPatch, planStartRun, planTransition, planUndo } from '../domain/transitions';
import type { Run, RunEvent, RunState, Timetable, TransitionKind } from '../domain/types';

/**
 * Drives the pure planners without any storage.
 *
 * This is the shape the storage adapters use inside their transactions, so tests
 * written against it exercise exactly the rules that production writes follow.
 */
export class RunDriver {
  run: Run;
  events: RunEvent[];

  constructor(
    readonly timetable: Timetable,
    startedAt: Date,
    runId = 'run-test-0001',
  ) {
    const plan = planStartRun(timetable, runId, startedAt);
    this.run = plan.run;
    this.events = [...plan.events];
  }

  get state(): RunState {
    return reconstructRunState(this.timetable, this.run, this.events);
  }

  /** Advance using the preconditions the UI would have observed. */
  advance(kind: TransitionKind, occurredAt: Date): this {
    const state = this.state;
    const currentItem = state.currentItem;
    if (!currentItem) throw new Error('run has no current item');
    const planned = planTransition(this.timetable, this.run, this.events, {
      runId: this.run.id,
      kind,
      occurredAt,
      expectedItemId: currentItem.id,
      expectedSeq: state.lastSeq,
    });
    this.events = [...this.events, ...planned.events];
    this.run = applyRunPatch(this.run, planned.runPatch);
    return this;
  }

  next(occurredAt: Date): this {
    return this.advance('next', occurredAt);
  }

  skip(occurredAt: Date): this {
    return this.advance('skip', occurredAt);
  }

  undo(occurredAt: Date): this {
    const planned = planUndo(this.timetable, this.run, this.events, occurredAt);
    this.events = [...this.events, ...planned.events];
    this.run = applyRunPatch(this.run, planned.runPatch);
    return this;
  }
}
