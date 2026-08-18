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
  RunState,
  Timetable,
  TimetableRef,
  TransitionKind,
} from '../domain/types';

export type AppPhase = 'loading' | 'ready' | 'blocked';

export interface AppStore {
  readonly services: Services;
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
  undo(): Promise<void>;
  correctTransitionTime(transitionId: string, correctedAt: Date): Promise<boolean>;
  skipDay(): Promise<boolean>;
  clearAllData(): Promise<boolean>;
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
  readonly children: ReactNode;
}

export const AppProvider = ({ services, bundledTimetables, children }: AppProviderProps) => {
  const [phase, setPhase] = useState<AppPhase>('loading');
  const [blockingError, setBlockingError] = useState<QuartzError | null>(null);
  const [activeState, setActiveState] = useState<RunState | null>(null);
  const [dayDecision, setDayDecision] = useState<DayDecision | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(
    async (initial: boolean) => {
      // Only the first load blanks the screen. A reload after a restore keeps
      // the current screen mounted so its confirmation is not swallowed.
      if (initial) setPhase('loading');
      setBlockingError(null);
      const outcome = await bootstrap(services, { bundledTimetables });
      if (outcome.kind === 'failed') {
        setBlockingError(outcome.error);
        setActiveState(null);
        setPhase('blocked');
        return;
      }
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
    [services, bundledTimetables],
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
    async (action: () => Promise<RunState | null>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      try {
        setActiveState(await action());
        setNotice(null);
      } catch (error) {
        const quartz = toQuartzError(error);
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
    [services],
  );

  const store = useMemo<AppStore>(
    () => ({
      services,
      phase,
      blockingError,
      activeState,
      timetables: bundledTimetables,
      dayDecision,
      busy,
      notice,
      dismissNotice: () => setNotice(null),
      startRun: (ref) => guard(() => services.runs.startRun(ref)),
      advance: (kind) =>
        guard(async () => {
          if (!activeState) return null;
          return services.runs.advance(activeState, kind);
        }),
      undo: () =>
        guard(async () => {
          if (!activeState) return null;
          return services.runs.undo(activeState);
        }),
      correctTransitionTime: async (transitionId, correctedAt) => {
        if (inFlight.current || !activeState) return false;
        inFlight.current = true;
        setBusy(true);
        try {
          setActiveState(
            await services.runs.correctTransitionTime(
              activeState.run.id,
              transitionId,
              correctedAt,
            ),
          );
          setNotice(null);
          return true;
        } catch (error) {
          const quartz = toQuartzError(error);
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
          return true;
        } catch (error) {
          const quartz = toQuartzError(error);
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
          return true;
        } catch (error) {
          setBlockingError(toQuartzError(error));
          setPhase('blocked');
          return false;
        } finally {
          inFlight.current = false;
          setBusy(false);
        }
      },
      reload: () => load(false),
    }),
    [
      services,
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
