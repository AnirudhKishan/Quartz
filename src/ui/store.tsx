/**
 * Application state for the UI.
 *
 * The store holds one authoritative `RunState` reconstructed from storage. Every
 * action re-reads that state from storage rather than mutating a local copy, so
 * what the screen shows is always what was actually recorded.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { bootstrap, type Services } from '../application/bootstrap';
import { QuartzError, isBlockingError, isQuartzError } from '../domain/errors';
import { getLocalDate } from '../domain/time';
import type {
  DayDecision,
  EditTimelineCommand,
  RunState,
  Timetable,
  TimetableRef,
  TransitionKind,
} from '../domain/types';
import {
  createNoopTelemetry,
  type Telemetry,
  type TelemetryProperties,
} from '../infrastructure/telemetry';

export type AppPhase = 'loading' | 'ready' | 'blocked';

export interface AppStore {
  readonly services: Services;
  readonly telemetry: Telemetry;
  readonly telemetryAvailable: boolean;
  readonly telemetryEnabled: boolean;
  readonly phase: AppPhase;
  /** Set only when the app cannot safely offer actions. */
  readonly blockingError: QuartzError | null;
  readonly activeState: RunState | null;
  readonly timetables: readonly Timetable[];
  readonly dayDecision: DayDecision | null;
  /** True while a transition is in flight; every action button is disabled. */
  readonly busy: boolean;
  /** Transient, non-blocking message, e.g. a rejected duplicate press. */
  readonly notice: string | null;
  dismissNotice(): void;
  startRun(ref: TimetableRef): Promise<void>;
  advance(kind: TransitionKind): Promise<void>;
  startNext(): Promise<void>;
  startUnplanned(label: string): Promise<void>;
  recordGapTask(label: string, startedAt: Date, endedAt: Date): Promise<boolean>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  endPaused(): Promise<void>;
  reorderUpcoming(itemId: string): Promise<void>;
  undo(): Promise<void>;
  editTimeline(replacements: EditTimelineCommand['replacements']): Promise<boolean>;
  skipDay(): Promise<boolean>;
  clearAllData(): Promise<boolean>;
  setTelemetryEnabled(enabled: boolean): Promise<void>;
  reload(): Promise<void>;
}

const AppContext = createContext<AppStore | null>(null);

export const useApp = (): AppStore => {
  const store = useContext(AppContext);
  if (!store) throw new Error('useApp must be used inside AppProvider');
  return store;
};

const toQuartzError = (error: unknown): QuartzError =>
  isQuartzError(error)
    ? error
    : new QuartzError(
        'storage-unavailable',
        'Quartz could not complete that action.',
        error instanceof Error ? [error.message] : [],
      );

export interface AppProviderProps {
  readonly services: Services;
  readonly bundledTimetables: readonly Timetable[];
  readonly telemetry?: Telemetry;
  readonly children: ReactNode;
}

export const AppProvider = ({
  services,
  bundledTimetables,
  telemetry = createNoopTelemetry(),
  children,
}: AppProviderProps) => {
  const [phase, setPhase] = useState<AppPhase>('loading');
  const [blockingError, setBlockingError] = useState<QuartzError | null>(null);
  const [activeState, setActiveState] = useState<RunState | null>(null);
  const [dayDecision, setDayDecision] = useState<DayDecision | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [telemetryEnabled, setTelemetryEnabledState] = useState(telemetry.isEnabled());
  const inFlight = useRef(false);

  const load = useCallback(
    async (initial: boolean) => {
      // Only the first load blanks the screen. A reload after a restore keeps
      // the current screen mounted so its confirmation is not swallowed.
      if (initial) setPhase('loading');
      setBlockingError(null);
      const outcome = await bootstrap(services, { bundledTimetables });
      if (outcome.kind === 'failed') {
        telemetry.trackException(new Error('Quartz bootstrap failed'), {
          operation: 'bootstrap',
          errorCode: outcome.error.code,
          blocking: true,
          initial,
        });
        setBlockingError(outcome.error);
        setActiveState(null);
        setPhase('blocked');
        return;
      }
      telemetry.trackEvent('app_ready', {
        initial,
        hasActiveRun: outcome.activeState !== null,
        timetableCount: bundledTimetables.length,
      });
      setActiveState(outcome.activeState);
      const timezone = outcome.activeState?.timetable.timezone ?? bundledTimetables[0]?.timezone;
      setDayDecision(
        timezone
          ? await services.repository.getDayDecision(
              timezone,
              getLocalDate(services.clock.now(), timezone),
            )
          : null,
      );
      setPhase('ready');
    },
    [services, bundledTimetables, telemetry],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  /**
   * Run one state-changing action under a lock.
   *
   * A second press while a transition is in flight is dropped rather than
   * queued, and a rejected precondition simply re-reads state: the first press
   * already won, so the user sees the truth instead of an error.
   */
  const guard = useCallback(
    async (
      eventName: string,
      action: () => Promise<RunState | null>,
      properties: TelemetryProperties = {},
    ) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      try {
        const nextState = await action();
        setActiveState(nextState);
        setNotice(null);
        if (nextState) telemetry.trackEvent(eventName, properties);
      } catch (error) {
        const quartz = toQuartzError(error);
        telemetry.trackException(new Error('Quartz action failed'), {
          operation: eventName,
          errorCode: quartz.code,
          blocking: isBlockingError(quartz),
        });
        if (isBlockingError(quartz)) {
          setBlockingError(quartz);
          setPhase('blocked');
        } else if (quartz.code === 'stale-state' || quartz.code === 'run-completed') {
          try {
            setActiveState(await services.runs.loadActiveState());
          } catch (reloadError) {
            setBlockingError(toQuartzError(reloadError));
            setPhase('blocked');
          }
        } else {
          setNotice(quartz.message);
        }
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [services, telemetry],
  );

  const store = useMemo<AppStore>(
    () => ({
      services,
      telemetry,
      telemetryAvailable: telemetry.isAvailable(),
      telemetryEnabled,
      phase,
      blockingError,
      activeState,
      timetables: bundledTimetables,
      dayDecision,
      busy,
      notice,
      dismissNotice: () => setNotice(null),
      startRun: (ref) => guard('run_started', () => services.runs.startRun(ref)),
      advance: (kind) =>
        guard(`run_${kind}`, async () => {
          if (!activeState) return null;
          const nextState = await services.runs.advance(activeState, kind);
          if (nextState.status === 'completed') {
            telemetry.trackEvent('run_completed', {
              recordedEventCount: nextState.events.length,
              plannedItemCount: nextState.timetable.items.length,
            });
          }
          return nextState;
        }),
      startNext: () =>
        guard('planned_task_started', async () => {
          if (!activeState) return null;
          return services.runs.startNext(activeState);
        }),
      startUnplanned: (label) =>
        guard('unplanned_task_started', async () => {
          if (!activeState) return null;
          return services.runs.startUnplanned(activeState, label);
        }),
      recordGapTask: async (label, startedAt, endedAt) => {
        if (inFlight.current || !activeState) return false;
        inFlight.current = true;
        setBusy(true);
        try {
          setActiveState(
            await services.runs.recordGapTask(
              activeState.run.id,
              label,
              startedAt,
              endedAt,
            ),
          );
          setNotice(null);
          telemetry.trackEvent('gap_task_recorded', {
            durationMs: endedAt.getTime() - startedAt.getTime(),
          });
          return true;
        } catch (error) {
          const quartz = toQuartzError(error);
          telemetry.trackException(new Error('Quartz action failed'), {
            operation: 'gap_task_recorded',
            errorCode: quartz.code,
            blocking: isBlockingError(quartz),
          });
          if (isBlockingError(quartz)) {
            setBlockingError(quartz);
            setPhase('blocked');
          } else {
            setNotice(quartz.message);
          }
          return false;
        } finally {
          inFlight.current = false;
          setBusy(false);
        }
      },
      pause: () =>
        guard('run_paused', async () => {
          if (!activeState) return null;
          return services.runs.pause(activeState);
        }),
      resume: () =>
        guard('run_resumed', async () => {
          if (!activeState) return null;
          return services.runs.resume(activeState);
        }),
      endPaused: () =>
        guard('paused_task_ended', async () => {
          if (!activeState) return null;
          return services.runs.endPaused(activeState);
        }),
      reorderUpcoming: (itemId) =>
        guard('upcoming_tasks_reordered', async () => {
          if (!activeState) return null;
          return services.runs.reorderUpcoming(activeState, itemId);
        }),
      undo: () =>
        guard('transition_undone', async () => {
          if (!activeState) return null;
          return services.runs.undo(activeState);
        }),
      editTimeline: async (replacements) => {
        if (inFlight.current || !activeState) return false;
        inFlight.current = true;
        setBusy(true);
        try {
          setActiveState(
            await services.runs.editTimeline(activeState.run.id, replacements),
          );
          setNotice(null);
          telemetry.trackEvent('timeline_edited', {
            replacementCount: replacements.length,
          });
          return true;
        } catch (error) {
          const quartz = toQuartzError(error);
          telemetry.trackException(new Error('Quartz action failed'), {
            operation: 'timeline_edited',
            errorCode: quartz.code,
            blocking: isBlockingError(quartz),
          });
          if (isBlockingError(quartz)) {
            setBlockingError(quartz);
            setPhase('blocked');
          } else {
            setNotice(quartz.message);
          }
          return false;
        } finally {
          inFlight.current = false;
          setBusy(false);
        }
      },
      skipDay: async () => {
        if (inFlight.current) return false;
        const timezone = activeState?.timetable.timezone ?? bundledTimetables[0]?.timezone;
        if (!timezone) {
          setNotice('No timetable timezone is available for this day.');
          return false;
        }
        inFlight.current = true;
        setBusy(true);
        try {
          const decision = await services.runs.skipDay(timezone, activeState);
          setActiveState(null);
          setDayDecision(decision);
          setNotice(null);
          telemetry.trackEvent('day_skipped', {
            hadActiveRun: activeState !== null,
            recordedEventCount: activeState?.events.length ?? 0,
          });
          return true;
        } catch (error) {
          const quartz = toQuartzError(error);
          telemetry.trackException(new Error('Quartz action failed'), {
            operation: 'day_skipped',
            errorCode: quartz.code,
            blocking: isBlockingError(quartz),
          });
          if (isBlockingError(quartz)) {
            setBlockingError(quartz);
            setPhase('blocked');
          } else {
            setNotice(quartz.message);
          }
          return false;
        } finally {
          inFlight.current = false;
          setBusy(false);
        }
      },
      clearAllData: async () => {
        if (inFlight.current) return false;
        inFlight.current = true;
        setBusy(true);
        try {
          await services.repository.clearAll();
          setActiveState(null);
          setDayDecision(null);
          setNotice(null);
          await load(false);
          telemetry.trackEvent('local_data_cleared');
          return true;
        } catch (error) {
          telemetry.trackException(new Error('Quartz action failed'), {
            operation: 'local_data_cleared',
            blocking: true,
          });
          setBlockingError(toQuartzError(error));
          setPhase('blocked');
          return false;
        } finally {
          inFlight.current = false;
          setBusy(false);
        }
      },
      setTelemetryEnabled: async (enabled) => {
        await telemetry.setEnabled(enabled);
        setTelemetryEnabledState(telemetry.isEnabled());
      },
      reload: () => load(false),
    }),
    [
      services,
      telemetry,
      telemetryEnabled,
      phase,
      blockingError,
      activeState,
      bundledTimetables,
      dayDecision,
      busy,
      notice,
      guard,
      load,
    ],
  );

  return <AppContext.Provider value={store}>{children}</AppContext.Provider>;
};
