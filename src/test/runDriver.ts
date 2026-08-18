import { reconstructRunState } from '../domain/runState';
import {
  applyRunPatch,
  planEndPaused,
  planPause,
  planReorderRun,
  planResume,
  planStartNext,
  planStartRun,
  planStartUnplanned,
  planTimelineEdit,
  planTransition,
  planUndo,
} from '../domain/transitions';
import type {
  Run,
  RunEvent,
  RunState,
  TimelineEventReplacement,
  Timetable,
  TransitionKind,
} from '../domain/types';

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
    const currentItem = state.currentActivity;
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

  startUnplanned(label: string, occurredAt: Date): this {
    const state = this.state;
    if (!state.currentActivity) throw new Error('run has no current item');
    const planned = planStartUnplanned(this.timetable, this.run, this.events, {
      runId: this.run.id,
      label,
      occurredAt,
      expectedItemId: state.currentActivity.id,
      expectedSeq: state.lastSeq,
    });
    this.events = [...this.events, ...planned.events];
    this.run = applyRunPatch(this.run, planned.runPatch);
    return this;
  }

  pause(occurredAt: Date): this {
    const state = this.state;
    if (!state.currentActivity) throw new Error('run has no current item');
    const planned = planPause(this.timetable, this.run, this.events, {
      runId: this.run.id,
      occurredAt,
      expectedItemId: state.currentActivity.id,
      expectedSeq: state.lastSeq,
    });
    this.events = [...this.events, ...planned.events];
    this.run = applyRunPatch(this.run, planned.runPatch);
    return this;
  }

  resume(occurredAt: Date): this {
    const state = this.state;
    if (!state.currentActivity || !state.resumeTarget) throw new Error('run is not paused');
    const planned = planResume(this.timetable, this.run, this.events, {
      runId: this.run.id,
      occurredAt,
      expectedItemId: state.currentActivity.id,
      expectedResumeTargetId: state.resumeTarget.id,
      expectedSeq: state.lastSeq,
    });
    this.events = [...this.events, ...planned.events];
    this.run = applyRunPatch(this.run, planned.runPatch);
    return this;
  }

  endPaused(occurredAt: Date): this {
    const state = this.state;
    if (!state.currentActivity || !state.resumeTarget) throw new Error('run is not paused');
    const planned = planEndPaused(this.timetable, this.run, this.events, {
      runId: this.run.id,
      occurredAt,
      expectedItemId: state.currentActivity.id,
      expectedResumeTargetId: state.resumeTarget.id,
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

  finish(occurredAt: Date): this {
    return this.advance('finish', occurredAt);
  }

  startNext(occurredAt: Date): this {
    const state = this.state;
    if (!state.nextItem) throw new Error('run has no next item');
    const planned = planStartNext(this.timetable, this.run, this.events, {
      runId: this.run.id,
      itemId: state.nextItem.id,
      occurredAt,
      expectedSeq: state.lastSeq,
    });
    this.events = [...this.events, ...planned.events];
    this.run = applyRunPatch(this.run, planned.runPatch);
    return this;
  }

  reorder(itemId: string): this {
    const state = this.state;
    const planned = planReorderRun(this.timetable, this.run, this.events, {
      runId: this.run.id,
      itemId,
      expectedSeq: state.lastSeq,
      expectedOrder: state.orderedItems.map((item) => item.id),
    });
    this.run = applyRunPatch(this.run, planned.runPatch);
    return this;
  }

  undo(occurredAt: Date): this {
    const planned = planUndo(this.timetable, this.run, this.events, occurredAt);
    this.events = [...this.events, ...planned.events];
    this.run = applyRunPatch(this.run, planned.runPatch);
    return this;
  }

  edit(replacements: readonly TimelineEventReplacement[], observedAt: Date): this {
    const planned = planTimelineEdit(this.timetable, this.run, this.events, {
      runId: this.run.id,
      replacements,
      observedAt,
      expectedSeq: this.state.lastSeq,
    });
    const replacementMap = new Map(planned.events.map((event) => [event.id, event]));
    this.events = this.events.map((event) => replacementMap.get(event.id) ?? event);
    this.run = applyRunPatch(this.run, planned.runPatch);
    return this;
  }
}
