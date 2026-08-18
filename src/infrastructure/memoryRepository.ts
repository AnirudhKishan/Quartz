/**
 * In-memory repository.
 *
 * This is what makes domain behaviour testable without IndexedDB. It applies the
 * same planners and the same invariants as the IndexedDB adapter, so the shared
 * contract test suite runs against both.
 */

import type { TimetableRepository } from '../application/repository';
import type { BackupData } from '../domain/backup';
import { systemIdGenerator, type IdGenerator } from '../domain/clock';
import { QuartzError } from '../domain/errors';
import { timetableKey, toSummary } from '../domain/timetable';
import { getLocalDate } from '../domain/time';
import {
  applyRunPatch,
  planStartRun,
  planTransition,
  planTransitionTimeCorrection,
  planUndo,
} from '../domain/transitions';
import type {
  CorrectTransitionTimeCommand,
  DayDecision,
  Run,
  RunEvent,
  SkipDayCommand,
  Timetable,
  TimetableRef,
  TimetableSummary,
  TransitionCommand,
} from '../domain/types';

export class InMemoryRepository implements TimetableRepository {
  private timetables = new Map<string, Timetable>();
  private runs = new Map<string, Run>();
  private events = new Map<string, RunEvent[]>();
  private dayDecisions = new Map<string, DayDecision>();

  constructor(private readonly ids: IdGenerator = systemIdGenerator) {}

  async listTimetables(): Promise<TimetableSummary[]> {
    return [...this.timetables.values()]
      .map(toSummary)
      .sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version);
  }

  async getTimetable(id: string, version: number): Promise<Timetable> {
    const timetable = this.timetables.get(timetableKey(id, version));
    if (!timetable) {
      throw new QuartzError('not-found', `Timetable ${id}@${version} is not available.`);
    }
    return timetable;
  }

  async saveTimetable(timetable: Timetable): Promise<void> {
    const key = timetableKey(timetable.id, timetable.version);
    this.timetables.set(key, timetable);
  }

  async createRun(ref: TimetableRef, occurredAt: Date): Promise<Run> {
    const active = await this.getActiveRun();
    if (active) {
      throw new QuartzError('run-already-active', 'A day is already in progress.');
    }
    const timetable = await this.getTimetable(ref.timetableId, ref.version);
    const localDate = getLocalDate(occurredAt, timetable.timezone);
    if (await this.getDayDecision(timetable.timezone, localDate)) {
      throw new QuartzError('day-skipped', 'Tracking has been skipped for this day.');
    }
    const runId = this.ids.newRunId(localDate);
    const started = planStartRun(timetable, runId, occurredAt);

    this.runs.set(runId, started.run);
    this.events.set(runId, [...started.events]);
    return started.run;
  }

  async getActiveRun(): Promise<Run | null> {
    return [...this.runs.values()].find((run) => run.status === 'active') ?? null;
  }

  async getRun(runId: string): Promise<Run | null> {
    return this.runs.get(runId) ?? null;
  }

  async getDayDecision(timezone: string, localDate: string): Promise<DayDecision | null> {
    const stored = this.dayDecisions.get(`${timezone}|${localDate}`);
    if (stored) return stored;
    for (const run of this.runs.values()) {
      if (run.status !== 'skipped' || run.localDate !== localDate || !run.completedAt) continue;
      const timetable = await this.getTimetable(run.timetableId, run.timetableVersion);
      if (timetable.timezone === timezone) {
        return {
          timezone,
          localDate,
          status: 'skipped',
          occurredAt: run.completedAt,
        };
      }
    }
    return null;
  }

  async skipDay(command: SkipDayCommand): Promise<DayDecision> {
    const active = await this.getActiveRun();
    if (active) {
      if (command.activeRunId !== active.id) {
        throw new QuartzError('stale-state', 'The active day changed before it could be skipped.');
      }
      const timetable = await this.getTimetable(active.timetableId, active.timetableVersion);
      if (
        timetable.timezone !== command.timezone ||
        active.localDate !== command.localDate
      ) {
        throw new QuartzError('stale-state', 'The active run belongs to a different local day.');
      }
      this.runs.set(active.id, {
        ...active,
        status: 'skipped',
        completedAt: command.occurredAt,
      });
    } else if (command.activeRunId !== null) {
      throw new QuartzError('no-active-run', 'There is no active day to skip.');
    } else {
      for (const run of this.runs.values()) {
        if (run.status !== 'completed' || run.localDate !== command.localDate) continue;
        const timetable = await this.getTimetable(run.timetableId, run.timetableVersion);
        if (timetable.timezone === command.timezone) {
          this.runs.set(run.id, {
            ...run,
            status: 'skipped',
            completedAt: command.occurredAt,
          });
        }
      }
    }

    const decision: DayDecision = {
      timezone: command.timezone,
      localDate: command.localDate,
      status: 'skipped',
      occurredAt: command.occurredAt,
    };
    this.dayDecisions.set(`${command.timezone}|${command.localDate}`, decision);
    return decision;
  }

  async completeRun(runId: string, occurredAt: Date): Promise<void> {
    const run = this.requireRun(runId);
    if (run.status === 'completed') return;
    this.runs.set(runId, { ...run, status: 'completed', completedAt: occurredAt });
  }

  async appendTransition(command: TransitionCommand): Promise<void> {
    const run = this.requireRun(command.runId);
    const timetable = await this.getTimetable(run.timetableId, run.timetableVersion);
    const events = this.events.get(run.id) ?? [];
    const planned = planTransition(timetable, run, events, command);
    this.events.set(run.id, [...events, ...planned.events]);
    this.runs.set(run.id, applyRunPatch(run, planned.runPatch));
  }

  async correctTransitionTime(command: CorrectTransitionTimeCommand): Promise<void> {
    const run = this.requireRun(command.runId);
    const timetable = await this.getTimetable(run.timetableId, run.timetableVersion);
    const events = this.events.get(run.id) ?? [];
    const planned = planTransitionTimeCorrection(timetable, run, events, command);
    const replacements = new Map(planned.events.map((event) => [event.id, event]));
    this.events.set(
      run.id,
      events.map((event) => replacements.get(event.id) ?? event),
    );
    this.runs.set(run.id, applyRunPatch(run, planned.runPatch));
  }

  async undoLastTransition(runId: string, occurredAt: Date): Promise<void> {
    const run = this.requireRun(runId);
    const timetable = await this.getTimetable(run.timetableId, run.timetableVersion);
    const events = this.events.get(run.id) ?? [];
    const planned = planUndo(timetable, run, events, occurredAt);
    this.events.set(run.id, [...events, ...planned.events]);
    this.runs.set(run.id, applyRunPatch(run, planned.runPatch));
  }

  async getRunEvents(runId: string): Promise<RunEvent[]> {
    return [...(this.events.get(runId) ?? [])].sort((a, b) => a.seq - b.seq);
  }

  async listCompletedRuns(): Promise<Run[]> {
    return [...this.runs.values()]
      .filter((run) => run.status === 'completed')
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }

  async listRuns(): Promise<Run[]> {
    return [...this.runs.values()].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }

  async exportAll(): Promise<BackupData> {
    return {
      timetables: [...this.timetables.values()],
      runs: [...this.runs.values()],
      events: [...this.events.values()].flat().sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  async replaceAll(data: BackupData): Promise<void> {
    this.timetables = new Map(
      data.timetables.map((timetable) => [
        timetableKey(timetable.id, timetable.version),
        timetable,
      ]),
    );
    this.runs = new Map(data.runs.map((run) => [run.id, run]));
    this.events = new Map();
    this.dayDecisions = new Map();
    for (const event of data.events) {
      const list = this.events.get(event.runId) ?? [];
      list.push(event);
      this.events.set(event.runId, list);
    }
    for (const [runId, list] of this.events) {
      this.events.set(runId, list.sort((a, b) => a.seq - b.seq));
    }
  }

  async clearAll(): Promise<void> {
    await this.replaceAll({ timetables: [], runs: [], events: [] });
  }

  private requireRun(runId: string): Run {
    const run = this.runs.get(runId);
    if (!run) throw new QuartzError('not-found', `Run ${runId} does not exist.`);
    return run;
  }
}
