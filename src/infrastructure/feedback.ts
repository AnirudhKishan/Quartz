export type FeedbackCue = 'success' | 'complete' | 'undo' | 'error';
export type FeedbackChannel = 'haptics' | 'sound';

export interface FeedbackPreferences {
  readonly haptics: boolean;
  readonly sound: boolean;
}

export interface FeedbackSnapshot {
  readonly preferences: FeedbackPreferences;
  readonly hapticsAvailable: boolean;
  readonly soundAvailable: boolean;
  readonly storageIssue: string | null;
  readonly hapticsIssue: string | null;
  readonly soundIssue: string | null;
}

export interface Feedback {
  getSnapshot(): FeedbackSnapshot;
  subscribe(listener: () => void): () => void;
  setEnabled(channel: FeedbackChannel, enabled: boolean): void;
  prepare(): Promise<void>;
  play(cue: FeedbackCue, channel?: FeedbackChannel): void;
  dispose(): void;
}

interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): void;
  exponentialRampToValueAtTime(value: number, endTime: number): void;
}

interface AudioNodeLike {
  connect(destination: unknown): unknown;
  disconnect(): void;
}

interface OscillatorLike extends AudioNodeLike {
  type: OscillatorType;
  frequency: AudioParamLike;
  onended: ((event: Event) => void) | null;
  start(when?: number): void;
  stop(when?: number): void;
}

interface GainLike extends AudioNodeLike {
  gain: AudioParamLike;
}

interface AudioContextLike {
  readonly state: AudioContextState;
  readonly currentTime: number;
  readonly destination: unknown;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
  resume(): Promise<void>;
  close(): Promise<void>;
}

interface FeedbackOptions {
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  readonly storageIssue?: string;
  readonly navigator?: Pick<Navigator, 'vibrate'>;
  readonly audioContextFactory?: () => AudioContextLike;
  readonly document?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
}

interface Tone {
  readonly frequency: number;
  readonly duration: number;
  readonly gap?: number;
}

interface ActiveSound {
  readonly oscillator: OscillatorLike;
  readonly gain: GainLike;
}

const STORAGE_KEY = 'quartz.feedback.preferences';
const DEFAULT_PREFERENCES: FeedbackPreferences = { haptics: true, sound: true };
const SILENT_GAIN = 0.0001;
const PEAK_GAIN = 0.06;

const HAPTIC_PATTERNS: Record<FeedbackCue, number | readonly number[]> = {
  success: 18,
  complete: [22, 45, 35],
  undo: [12, 35, 12],
  error: [35, 35, 35],
};

const TONES: Record<FeedbackCue, readonly Tone[]> = {
  success: [{ frequency: 660, duration: 0.07 }],
  complete: [
    { frequency: 523.25, duration: 0.08, gap: 0.025 },
    { frequency: 659.25, duration: 0.08, gap: 0.025 },
    { frequency: 783.99, duration: 0.12 },
  ],
  undo: [
    { frequency: 587.33, duration: 0.065, gap: 0.02 },
    { frequency: 440, duration: 0.09 },
  ],
  error: [
    { frequency: 220, duration: 0.085, gap: 0.025 },
    { frequency: 174.61, duration: 0.11 },
  ],
};

const defaultAudioContextFactory = (): AudioContextLike => {
  const AudioContextConstructor =
    window.AudioContext ??
    (
      window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      }
    ).webkitAudioContext;
  if (!AudioContextConstructor) throw new Error('Web Audio is unavailable.');
  return new AudioContextConstructor();
};

const isPreferences = (value: unknown): value is FeedbackPreferences => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.haptics === 'boolean' && typeof candidate.sound === 'boolean';
};

class BrowserFeedback implements Feedback {
  private snapshot: FeedbackSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly storage: FeedbackOptions['storage'];
  private readonly navigator: FeedbackOptions['navigator'];
  private readonly audioContextFactory: FeedbackOptions['audioContextFactory'];
  private readonly document: FeedbackOptions['document'];
  private audioContext: AudioContextLike | null = null;
  private readonly activeSounds = new Set<ActiveSound>();
  private disposed = false;

  constructor(options: FeedbackOptions) {
    this.storage = options.storage;
    this.navigator = options.navigator;
    this.audioContextFactory = options.audioContextFactory;
    this.document = options.document;
    const stored = this.readPreferences();
    this.snapshot = {
      preferences: stored.preferences,
      hapticsAvailable: typeof this.navigator?.vibrate === 'function',
      soundAvailable: this.audioContextFactory !== undefined,
      storageIssue: stored.issue ?? options.storageIssue ?? null,
      hapticsIssue: null,
      soundIssue: null,
    };
    this.document?.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  getSnapshot(): FeedbackSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setEnabled(channel: FeedbackChannel, enabled: boolean): void {
    if (this.disposed || this.snapshot.preferences[channel] === enabled) return;
    const preferences = { ...this.snapshot.preferences, [channel]: enabled };
    this.update({ preferences });
    if (!enabled) {
      if (channel === 'haptics') this.cancelHaptics();
      else this.cancelAudio();
    }
    if (!this.storage) {
      this.update({
        storageIssue:
          this.snapshot.storageIssue ??
          'Quartz can use this choice now, but this browser did not save it.',
      });
      return;
    }
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
      this.update({ storageIssue: null });
    } catch {
      this.update({
        storageIssue: 'Quartz can use this choice now, but this browser did not save it.',
      });
    }
  }

  async prepare(): Promise<void> {
    if (this.disposed || !this.snapshot.preferences.sound || !this.snapshot.soundAvailable) return;
    const context = this.getAudioContext();
    if (!context || context.state !== 'suspended') return;
    try {
      await context.resume();
      this.update({ soundIssue: null });
    } catch {
      this.update({
        soundIssue: 'Sound is blocked by the browser. Tap Preview sound to try again.',
      });
    }
  }

  play(cue: FeedbackCue, channel?: FeedbackChannel): void {
    if (this.disposed || this.document?.hidden) return;
    if (
      this.snapshot.preferences.haptics &&
      (channel === undefined || channel === 'haptics')
    ) {
      this.playHaptic(cue);
    }
    if (
      this.snapshot.preferences.sound &&
      (channel === undefined || channel === 'sound')
    ) {
      this.playSound(cue);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.document?.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.cancelHaptics();
    this.cancelAudio();
    const context = this.audioContext;
    this.audioContext = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
    this.listeners.clear();
  }

  private readPreferences(): { preferences: FeedbackPreferences; issue: string | null } {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (raw === null || raw === undefined) {
        return { preferences: DEFAULT_PREFERENCES, issue: null };
      }
      const parsed: unknown = JSON.parse(raw);
      if (!isPreferences(parsed)) {
        return {
          preferences: DEFAULT_PREFERENCES,
          issue: 'Saved feedback settings were invalid, so Quartz restored the defaults.',
        };
      }
      return { preferences: parsed, issue: null };
    } catch {
      return {
        preferences: DEFAULT_PREFERENCES,
        issue: 'Quartz could not read saved feedback settings, so it is using the defaults.',
      };
    }
  }

  private getAudioContext(): AudioContextLike | null {
    if (this.audioContext?.state === 'closed') this.audioContext = null;
    if (this.audioContext) return this.audioContext;
    if (!this.audioContextFactory) return null;
    try {
      this.audioContext = this.audioContextFactory();
      this.update({ soundIssue: null });
      return this.audioContext;
    } catch {
      this.update({
        soundIssue: 'Sound feedback is unavailable in this browser.',
      });
      return null;
    }
  }

  private playHaptic(cue: FeedbackCue): void {
    if (!this.snapshot.hapticsAvailable || !this.navigator?.vibrate) {
      this.update({ hapticsIssue: 'Haptic feedback is unavailable in this browser.' });
      return;
    }
    try {
      const accepted = this.navigator.vibrate([...toPattern(HAPTIC_PATTERNS[cue])]);
      this.update({
        hapticsIssue: accepted
          ? null
          : 'This device did not accept the haptic feedback request.',
      });
    } catch {
      this.update({ hapticsIssue: 'This device could not play haptic feedback.' });
    }
  }

  private playSound(cue: FeedbackCue): void {
    if (!this.snapshot.soundAvailable) {
      this.update({ soundIssue: 'Sound feedback is unavailable in this browser.' });
      return;
    }
    const context = this.getAudioContext();
    if (!context) return;
    if (context.state === 'closed') {
      this.update({ soundIssue: 'Sound feedback is unavailable in this browser.' });
      return;
    }
    if (context.state === 'suspended') {
      void context.resume().then(
        () => this.update({ soundIssue: null }),
        () =>
          this.update({
            soundIssue: 'Sound is blocked by the browser. Tap Preview sound to try again.',
          }),
      );
    } else if (context.state !== 'running') {
      if (!this.snapshot.soundIssue) {
        this.update({
          soundIssue: 'Sound is waiting for browser permission. Tap Preview sound to try again.',
        });
      }
      return;
    }

    this.cancelAudio();
    let offset = 0;
    try {
      for (const tone of TONES[cue]) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = context.currentTime + offset;
        const end = start + tone.duration;
        oscillator.type = 'sine';
        oscillator.frequency.value = tone.frequency;
        gain.gain.setValueAtTime(SILENT_GAIN, start);
        gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, start + 0.008);
        gain.gain.exponentialRampToValueAtTime(SILENT_GAIN, end);
        oscillator.connect(gain);
        gain.connect(context.destination);
        const activeSound = { oscillator, gain };
        oscillator.onended = () => {
          this.activeSounds.delete(activeSound);
          oscillator.disconnect();
          gain.disconnect();
        };
        this.activeSounds.add(activeSound);
        oscillator.start(start);
        oscillator.stop(end + 0.01);
        offset += tone.duration + (tone.gap ?? 0);
      }
      this.update({ soundIssue: null });
    } catch {
      this.cancelAudio();
      this.update({ soundIssue: 'This browser could not play sound feedback.' });
    }
  }

  private cancelHaptics(): void {
    try {
      this.navigator?.vibrate?.(0);
    } catch {
      // Optional feedback cleanup must never block Quartz.
    }
  }

  private cancelAudio(): void {
    for (const { oscillator, gain } of this.activeSounds) {
      oscillator.onended = null;
      try {
        oscillator.stop();
      } catch {
        // The node may already have stopped.
      }
      oscillator.disconnect();
      gain.disconnect();
    }
    this.activeSounds.clear();
  }

  private readonly handleVisibilityChange = (): void => {
    if (!this.document?.hidden) return;
    this.cancelHaptics();
    this.cancelAudio();
  };

  private update(changes: Partial<FeedbackSnapshot>): void {
    const next = { ...this.snapshot, ...changes };
    if (
      next.preferences === this.snapshot.preferences &&
      next.storageIssue === this.snapshot.storageIssue &&
      next.hapticsIssue === this.snapshot.hapticsIssue &&
      next.soundIssue === this.snapshot.soundIssue
    ) {
      return;
    }
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
}

const toPattern = (pattern: number | readonly number[]): readonly number[] =>
  typeof pattern === 'number' ? [pattern] : pattern;

const noopSnapshot: FeedbackSnapshot = {
  preferences: DEFAULT_PREFERENCES,
  hapticsAvailable: false,
  soundAvailable: false,
  storageIssue: null,
  hapticsIssue: null,
  soundIssue: null,
};

const noopFeedback: Feedback = {
  getSnapshot: () => noopSnapshot,
  subscribe: () => () => undefined,
  setEnabled: () => undefined,
  prepare: async () => undefined,
  play: () => undefined,
  dispose: () => undefined,
};

export const createFeedback = (options: FeedbackOptions = {}): Feedback => {
  let storage = options.storage;
  let storageIssue = options.storageIssue;
  if (!storage && typeof window !== 'undefined') {
    try {
      storage = window.localStorage;
    } catch {
      storageIssue = 'Quartz could not access saved feedback settings in this browser.';
    }
  }
  const browserOptions: FeedbackOptions = {
    storage,
    storageIssue,
    navigator:
      options.navigator ??
      (typeof window === 'undefined' ? undefined : window.navigator),
    audioContextFactory:
      options.audioContextFactory ??
      (typeof window !== 'undefined' &&
      (typeof window.AudioContext === 'function' ||
        typeof (
          window as typeof window & {
            webkitAudioContext?: typeof AudioContext;
          }
        ).webkitAudioContext === 'function')
        ? defaultAudioContextFactory
        : undefined),
    document:
      options.document ??
      (typeof document === 'undefined' ? undefined : document),
  };
  return new BrowserFeedback(browserOptions);
};

export const createNoopFeedback = (): Feedback => noopFeedback;
