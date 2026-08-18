import type { PlannedItem } from '../domain/analysis';
import { getLocalParts, parseClockTime, zonedLocalTimeToUtc } from '../domain/time';
import type { RunEvent, RunState } from '../domain/types';

const MIN_SECTION_HEIGHT = 96;
const MAX_SECTION_HEIGHT = 190;

export const timelineSectionHeight = (plannedDurationMs: number): number => {
  const minutes = Math.max(1, plannedDurationMs / 60_000);
  return Math.round(
    Math.min(MAX_SECTION_HEIGHT, Math.max(MIN_SECTION_HEIGHT, 45 + Math.sqrt(minutes) * 7)),
  );
};

export const instantFraction = (plan: PlannedItem, instant: Date): number | null => {
  const start = plan.plannedStartUtc.getTime();
  const end = plan.plannedEndUtc.getTime();
  const value = instant.getTime();
  if (value < start || value > end) return null;
  return Math.min(1, Math.max(0, (value - start) / (end - start)));
};

const pad = (value: number): string => String(value).padStart(2, '0');

export const toLocalDateTimeValue = (instant: Date, timezone: string): string => {
  const parts = getLocalParts(instant, timezone);
  return `${String(parts.year).padStart(4, '0')}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
};

export const fromLocalDateTimeValue = (value: string, timezone: string): Date | null => {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  return zonedLocalTimeToUtc(match[1]!, parseClockTime(match[2]!), timezone);
};

export interface TransitionContext {
  readonly terminal: RunEvent;
  readonly nextStarted: RunEvent | null;
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly minimum: Date;
  readonly maximum: Date;
}

export const getTransitionContext = (
  state: RunState,
  transitionId: string,
  observedAt: Date,
): TransitionContext | null => {
  const index = state.effectiveEvents.findIndex(
    (event) =>
      event.id === transitionId &&
      event.transitionId === transitionId &&
      (event.type === 'completed' ||
        event.type === 'skipped' ||
        (event.seq === 1 && event.type === 'started')),
  );
  const terminal = state.effectiveEvents[index];
  if (!terminal) return null;
  const isInitialStart = terminal.seq === 1 && terminal.type === 'started';

  const previous = state.effectiveEvents[index - 1];
  const candidateStarted = state.effectiveEvents[index + 1];
  const nextStarted =
    !isInitialStart &&
    candidateStarted?.transitionId === transitionId &&
    candidateStarted.type === 'started'
      ? candidateStarted
      : null;
  const nextBoundary = nextStarted ? state.effectiveEvents[index + 2] : candidateStarted;
  const maximum = new Date(
    Math.min(nextBoundary?.occurredAt.getTime() ?? observedAt.getTime(), observedAt.getTime()),
  );

  return {
    terminal,
    nextStarted,
    fromLabel: isInitialStart
      ? 'Day start'
      : state.timetable.items.find((item) => item.id === terminal.itemId)?.label ??
        terminal.itemId,
    toLabel: isInitialStart
      ? state.timetable.items[0]?.label ?? terminal.itemId
      : nextStarted
        ? state.timetable.items.find((item) => item.id === nextStarted.itemId)?.label ??
          nextStarted.itemId
        : 'Day complete',
    minimum: isInitialStart
      ? zonedLocalTimeToUtc(state.run.localDate, 0, state.timetable.timezone)
      : previous?.occurredAt ?? state.run.startedAt,
    maximum,
  };
};
