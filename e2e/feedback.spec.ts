import { expect, test } from '@playwright/test';

test('@feedback persists settings and confirms a run action without noisy navigation', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = window as typeof window & {
      __quartzHaptics: unknown[];
      __quartzSoundStarts: number;
    };
    state.__quartzHaptics = [];
    state.__quartzSoundStarts = 0;

    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: (pattern: unknown) => {
        state.__quartzHaptics.push(pattern);
        return true;
      },
    });

    class FakeParam {
      value = 0;
      setValueAtTime(): void {}
      exponentialRampToValueAtTime(): void {}
    }

    class FakeAudioNode {
      connect(): this {
        return this;
      }
      disconnect(): void {}
    }

    class FakeOscillator extends FakeAudioNode {
      type: OscillatorType = 'sine';
      frequency = new FakeParam();
      onended: ((event: Event) => void) | null = null;
      start(): void {
        state.__quartzSoundStarts += 1;
      }
      stop(): void {}
    }

    class FakeGain extends FakeAudioNode {
      gain = new FakeParam();
    }

    class FakeAudioContext {
      state: AudioContextState = 'running';
      currentTime = 0;
      destination = {};
      createOscillator(): FakeOscillator {
        return new FakeOscillator();
      }
      createGain(): FakeGain {
        return new FakeGain();
      }
      async resume(): Promise<void> {}
      async close(): Promise<void> {
        this.state = 'closed';
      }
    }

    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: FakeAudioContext,
    });
  });

  await page.clock.install({ time: new Date('2026-03-02T00:30:00.000Z') });
  await page.goto('/#/settings');
  const haptics = page.getByLabel('Haptic feedback');
  const sound = page.getByLabel('Sound feedback');
  await expect(haptics).toBeChecked();
  await expect(sound).toBeChecked();

  const initial = await page.evaluate(() => {
    const state = window as typeof window & {
      __quartzHaptics: unknown[];
      __quartzSoundStarts: number;
    };
    return {
      haptics: state.__quartzHaptics.length,
      sounds: state.__quartzSoundStarts,
    };
  });
  await page.getByRole('link', { name: /Timetables/ }).click();
  await expect(page.getByRole('heading', { name: 'Quartz' })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window as typeof window & {
          __quartzHaptics: unknown[];
          __quartzSoundStarts: number;
        };
        return {
          haptics: state.__quartzHaptics.length,
          sounds: state.__quartzSoundStarts,
        };
      }),
    )
    .toEqual(initial);

  await page.goto('/#/settings');
  await sound.uncheck();
  await page.reload();
  await expect(sound).not.toBeChecked();
  await sound.check();
  await page.getByRole('button', { name: 'Preview sound' }).click();
  await expect
    .poll(() => page.evaluate(() => (
      window as typeof window & { __quartzSoundStarts: number }
    ).__quartzSoundStarts))
    .toBeGreaterThan(initial.sounds);

  await page.getByRole('link', { name: /Timetables/ }).click();
  const gym = page.getByRole('heading', { name: 'Gym weekday', exact: true }).locator('..');
  await gym.getByRole('button', { name: 'Start day' }).click();
  await expect(page.getByRole('heading', { name: 'Brush, hydrate and change' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (
      window as typeof window & { __quartzHaptics: unknown[] }
    ).__quartzHaptics.length))
    .toBeGreaterThan(initial.haptics);
});
