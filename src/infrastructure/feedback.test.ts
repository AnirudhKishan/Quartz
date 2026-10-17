import { describe, expect, it, vi } from 'vitest';

import { createFeedback, type FeedbackCue } from './feedback';

class FakeStorage {
  value: string | null = null;
  failRead = false;
  failWrite = false;

  getItem(): string | null {
    if (this.failRead) throw new Error('read blocked');
    return this.value;
  }

  setItem(_key: string, value: string): void {
    if (this.failWrite) throw new Error('write blocked');
    this.value = value;
  }
}

class FakeAudioParam {
  value = 0;
  setValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}

class FakeOscillator {
  type: OscillatorType = 'sine';
  frequency = new FakeAudioParam();
  onended: ((event: Event) => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn(() => this.onended?.(new Event('ended')));
}

class FakeGain {
  gain = new FakeAudioParam();
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeAudioContext {
  state: AudioContextState = 'suspended';
  currentTime = 1;
  destination = {};
  oscillators: FakeOscillator[] = [];
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  createOscillator = vi.fn(() => {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  });
  createGain = vi.fn(() => new FakeGain());
}

class FakeDocument {
  hidden = false;
  private listener: (() => void) | null = null;
  addEventListener = vi.fn((_name: string, listener: EventListenerOrEventListenerObject) => {
    this.listener =
      typeof listener === 'function'
        ? () => listener(new Event('visibilitychange'))
        : () => listener.handleEvent(new Event('visibilitychange'));
  });
  removeEventListener = vi.fn();
  hide(): void {
    this.hidden = true;
    this.listener?.();
  }
}

const createHarness = (stored: string | null = null) => {
  const storage = new FakeStorage();
  storage.value = stored;
  const vibrate = vi.fn(() => true);
  const audio = new FakeAudioContext();
  const document = new FakeDocument();
  const feedback = createFeedback({
    storage,
    navigator: { vibrate },
    audioContextFactory: () => audio,
    document,
  });
  return { feedback, storage, vibrate, audio, document };
};

describe('browser feedback', () => {
  it('defaults both channels on and persists independent changes', () => {
    const { feedback, storage } = createHarness();

    expect(feedback.getSnapshot().preferences).toEqual({ haptics: true, sound: true });
    feedback.setEnabled('sound', false);

    expect(feedback.getSnapshot().preferences).toEqual({ haptics: true, sound: false });
    expect(JSON.parse(storage.value ?? '')).toEqual({ haptics: true, sound: false });
  });

  it('restores valid preferences and reports invalid stored values', () => {
    const valid = createHarness('{"haptics":false,"sound":true}').feedback;
    const invalid = createHarness('{"haptics":"yes"}').feedback;

    expect(valid.getSnapshot().preferences).toEqual({ haptics: false, sound: true });
    expect(invalid.getSnapshot().preferences).toEqual({ haptics: true, sound: true });
    expect(invalid.getSnapshot().storageIssue).toMatch(/invalid/);
  });

  it('keeps a session change and reports when storage rejects it', () => {
    const { feedback, storage } = createHarness();
    storage.failWrite = true;

    feedback.setEnabled('haptics', false);

    expect(feedback.getSnapshot().preferences.haptics).toBe(false);
    expect(feedback.getSnapshot().storageIssue).toMatch(/did not save/);
  });

  it('reports when stored preferences cannot be read', () => {
    const storage = new FakeStorage();
    storage.failRead = true;

    const feedback = createFeedback({
      storage,
      navigator: { vibrate: vi.fn(() => true) },
      audioContextFactory: () => new FakeAudioContext(),
      document: new FakeDocument(),
    });

    expect(feedback.getSnapshot().preferences).toEqual({ haptics: true, sound: true });
    expect(feedback.getSnapshot().storageIssue).toMatch(/could not read/);
  });

  it('prepares audio from a gesture and emits both channels after success', async () => {
    const { feedback, vibrate, audio } = createHarness();

    feedback.prepare();
    await Promise.resolve();
    feedback.play('success');

    expect(audio.resume).toHaveBeenCalledOnce();
    expect(vibrate).toHaveBeenCalledWith([18]);
    expect(audio.createOscillator).toHaveBeenCalledOnce();
  });

  it.each<FeedbackCue>(['success', 'complete', 'undo', 'error'])(
    'uses a bounded cue for %s',
    async (cue) => {
      const { feedback, vibrate, audio } = createHarness();
      feedback.prepare();
      await Promise.resolve();

      feedback.play(cue);

      expect(vibrate).toHaveBeenCalledTimes(1);
      expect(audio.oscillators.length).toBeGreaterThan(0);
      expect(audio.oscillators.length).toBeLessThanOrEqual(3);
    },
  );

  it('cancels previous sound before playing the next cue', async () => {
    const { feedback, audio } = createHarness();
    feedback.prepare();
    await Promise.resolve();
    feedback.play('complete');
    const firstCue = [...audio.oscillators];

    feedback.play('error');

    firstCue.forEach((oscillator) => expect(oscillator.stop).toHaveBeenCalled());
  });

  it('cancels active feedback when the document becomes hidden', async () => {
    const { feedback, vibrate, audio, document } = createHarness();
    await feedback.prepare();
    feedback.play('complete');
    const oscillators = [...audio.oscillators];

    document.hide();

    expect(vibrate).toHaveBeenLastCalledWith(0);
    oscillators.forEach((oscillator) => expect(oscillator.stop).toHaveBeenCalled());
    feedback.play('success');
    expect(audio.oscillators).toHaveLength(oscillators.length);
  });

  it('does not create feedback through a disabled channel', async () => {
    const { feedback, vibrate, audio } = createHarness();
    feedback.setEnabled('haptics', false);
    feedback.setEnabled('sound', false);

    feedback.prepare();
    feedback.play('complete');
    await Promise.resolve();

    expect(vibrate).toHaveBeenCalledWith(0);
    expect(audio.resume).not.toHaveBeenCalled();
    expect(audio.createOscillator).not.toHaveBeenCalled();
  });

  it('reports unavailable browser channels without throwing', () => {
    const feedback = createFeedback({
      storage: new FakeStorage(),
      navigator: undefined,
      audioContextFactory: undefined,
      document: undefined,
    });

    feedback.play('error');

    expect(feedback.getSnapshot()).toMatchObject({
      hapticsAvailable: false,
      soundAvailable: false,
      hapticsIssue: 'Haptic feedback is unavailable in this browser.',
      soundIssue: 'Sound feedback is unavailable in this browser.',
    });
  });

  it('reports audio permission failures without replaying a queued cue', async () => {
    const { feedback, audio } = createHarness();
    audio.resume.mockRejectedValueOnce(new Error('blocked'));

    await feedback.prepare();
    feedback.play('success');

    expect(feedback.getSnapshot().soundIssue).toMatch(/blocked/);
    expect(audio.createOscillator).not.toHaveBeenCalled();
  });
});
