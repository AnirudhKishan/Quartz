import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { createServices, type Services } from '../application/bootstrap';
import type { TimetableRepository } from '../application/repository';
import type { Clock } from '../domain/clock';
import { sequentialIdGenerator } from '../domain/clock';
import { QuartzError } from '../domain/errors';
import { InMemoryRepository } from '../infrastructure/memoryRepository';
import { simpleTimetable } from '../test/fixtures';
import { AppProvider } from './store';

interface MovableClock extends Clock {
  advanceMinutes(count: number): void;
}

/** A clock the test moves by hand, so every recorded instant is intentional. */
const movableClock = (start: string): MovableClock => {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    advanceMinutes(count: number) {
      current = new Date(current.getTime() + count * 60_000);
    },
  };
};

const setup = (
  overrides: {
    repository?: TimetableRepository;
    clock?: MovableClock;
    hash?: string;
  } = {},
) => {
  window.location.hash = overrides.hash ?? '#/';
  const clock = overrides.clock ?? movableClock('2026-03-02T00:30:00.000Z');
  const repository =
    overrides.repository ?? new InMemoryRepository(sequentialIdGenerator());
  const services: Services = createServices(repository, clock);

  render(
    <AppProvider services={services} bundledTimetables={[simpleTimetable]}>
      <App />
    </AppProvider>,
  );

  return { services, repository, clock };
};

const user = () => userEvent.setup();

beforeEach(() => {
  window.location.hash = '#/';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('selection screen', () => {
  it('lists the available plan without exposing its internal version and starts a day', async () => {
    setup();

    await screen.findByRole('heading', { name: 'Test plan' });
    expect(screen.queryByText('v1')).not.toBeInTheDocument();

    await user().click(screen.getByRole('button', { name: 'Start day' }));

    expect(await screen.findByRole('heading', { name: 'Wake' })).toBeInTheDocument();
    expect(screen.getByLabelText('Timetable day')).toBeInTheDocument();
  });

  it('refuses to start a second day while one is running', async () => {
    setup();
    await user().click(await screen.findByRole('button', { name: 'Start day' }));

    window.location.hash = '#/';
    expect(await screen.findByRole('heading', { name: 'A day is already running' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start day' })).toBeDisabled();
  });

  it('offers no tracking controls when no plan is eligible on the weekend', async () => {
    setup({ clock: movableClock('2026-03-07T00:30:00.000Z') });

    expect(await screen.findByText(/No plan is scheduled/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start day' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip day' })).not.toBeInTheDocument();
  });

  it('confirms a whole-day skip before tracking starts', async () => {
    const { repository } = setup();

    await user().click(await screen.findByRole('button', { name: 'Skip day' }));
    expect(screen.getByRole('heading', { name: 'Skip tracking for the whole day?' })).toBeVisible();
    await user().click(screen.getByRole('button', { name: 'Confirm skip day' }));

    expect(await screen.findByRole('heading', { name: 'No tracking today' })).toBeVisible();
    expect(await repository.getDayDecision('Asia/Kolkata', '2026-03-02')).not.toBeNull();
    expect(await repository.listRuns()).toEqual([]);
  });
});

describe('active run screen', () => {
  const startDay = async () => {
    const context = setup();
    await user().click(await screen.findByRole('button', { name: 'Start day' }));
    await screen.findByRole('heading', { name: 'Wake' });
    return context;
  };

  it('shows the planned window, the elapsed time, and what is next', async () => {
    await startDay();

    expect(screen.getByText('Planned 06:00–06:30')).toBeInTheDocument();
    expect(screen.getByLabelText('Time in this step')).toHaveTextContent(/^\d{2}:\d{2}$/);
    expect(screen.getByRole('heading', { name: 'Gym' })).toBeInTheDocument();
  });

  it('advances to the next item and records the deviation of the one just finished', async () => {
    const { clock } = await startDay();

    clock.advanceMinutes(40);
    await user().click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Gym in progress')).toBeInTheDocument();
    expect(screen.getByText('10m 00s late')).toBeInTheDocument();
  });

  it('undoes the last transition and restores the original start of the item', async () => {
    const { clock } = await startDay();

    clock.advanceMinutes(40);
    await user().click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Gym in progress');

    clock.advanceMinutes(5);
    await user().click(screen.getByRole('button', { name: 'Undo' }));

    expect(await screen.findByText('Wake in progress')).toBeInTheDocument();
    expect(screen.getByText('on time')).toBeInTheDocument();
  });

  it('cannot undo before the first recorded step', async () => {
    await startDay();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('skips an item without offering a confirmation prompt', async () => {
    const { clock } = await startDay();

    clock.advanceMinutes(30);
    await user().click(screen.getByRole('button', { name: 'Skip' }));

    expect(await screen.findByText('Gym in progress')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('confirms skipping an active day and excludes its retained history', async () => {
    const { clock, repository } = await startDay();
    const run = await repository.getActiveRun();
    if (!run) throw new Error('expected active run');

    clock.advanceMinutes(30);
    await user().click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Gym in progress');
    const eventsBeforeSkip = await repository.getRunEvents(run.id);

    await user().click(screen.getByRole('button', { name: 'Skip day' }));
    expect(screen.getByRole('heading', { name: 'Stop tracking the whole day?' })).toBeVisible();
    await user().click(screen.getByRole('button', { name: 'Confirm skip day' }));

    expect(await screen.findByRole('heading', { name: 'No tracking today' })).toBeVisible();
    expect((await repository.getRun(run.id))?.status).toBe('skipped');
    expect(await repository.getRunEvents(run.id)).toEqual(eventsBeforeSkip);
    expect(await repository.listCompletedRuns()).toEqual([]);
  });

  it('completes the day on the final step and offers the report', async () => {
    const { clock, repository } = await startDay();

    clock.advanceMinutes(30);
    await user().click(screen.getByRole('button', { name: 'Next' }));
    clock.advanceMinutes(60);
    await user().click(await screen.findByRole('button', { name: 'Next' }));
    clock.advanceMinutes(30);
    await user().click(await screen.findByRole('button', { name: 'Finish day' }));

    expect(await screen.findByRole('heading', { name: 'Day complete' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See the report' })).toBeInTheDocument();
    expect(await repository.getActiveRun()).toBeNull();
  });

  it('locks the controls while a transition is in flight', async () => {
    const repository = new InMemoryRepository(sequentialIdGenerator());
    const original = repository.appendTransition.bind(repository);
    const gate: { release: () => void } = { release: () => undefined };
    vi.spyOn(repository, 'appendTransition').mockImplementation(async (command) => {
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return original(command);
    });

    setup({ repository });
    await user().click(await screen.findByRole('button', { name: 'Start day' }));
    await screen.findByRole('heading', { name: 'Wake' });

    await user().click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Skip' })).toBeDisabled();

    gate.release();
    expect(await screen.findByText('Gym in progress')).toBeInTheDocument();
  });

  it('corrects a recently recorded changeover from the timeline', async () => {
    const { clock, repository } = await startDay();
    clock.advanceMinutes(40);
    await user().click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Gym in progress');

    await user().click(screen.getByRole('button', { name: /06:40 Edit time/ }));
    const input = screen.getByLabelText('Actual changeover time');
    fireEvent.change(input, { target: { value: '2026-03-02T06:30' } });
    await user().click(screen.getByRole('button', { name: 'Save correction' }));

    expect(await screen.findByRole('button', { name: /06:30 Edit time/ })).toBeInTheDocument();
    const run = await repository.getActiveRun();
    const events = await repository.getRunEvents(run!.id);
    expect(events[1]?.occurredAt.toISOString()).toBe('2026-03-02T01:00:00.000Z');
    expect(events[2]?.occurredAt.toISOString()).toBe('2026-03-02T01:00:00.000Z');
  });

  it('corrects the first task start from the timeline', async () => {
    const { repository } = await startDay();

    await user().click(screen.getByRole('button', { name: /06:00 Edit start/ }));
    fireEvent.change(screen.getByLabelText('Actual day start time'), {
      target: { value: '2026-03-02T05:50' },
    });
    await user().click(screen.getByRole('button', { name: 'Save correction' }));

    expect(await screen.findByRole('button', { name: /05:50 Edit start/ })).toBeInTheDocument();
    const run = await repository.getActiveRun();
    const events = await repository.getRunEvents(run!.id);
    expect(run?.startedAt.toISOString()).toBe('2026-03-02T00:20:00.000Z');
    expect(events[0]?.occurredAt.toISOString()).toBe('2026-03-02T00:20:00.000Z');
  });

  it('clears local data from the overflow menu and reseeds a fresh install', async () => {
    const { repository } = await startDay();
    await user().click(screen.getByText('More actions'));
    await user().click(screen.getByRole('button', { name: 'Clear all local data' }));
    await user().click(screen.getByRole('button', { name: 'Permanently clear data' }));

    expect(await screen.findByRole('heading', { name: 'Quartz' })).toBeInTheDocument();
    expect(await repository.listRuns()).toEqual([]);
    expect(await repository.listTimetables()).toHaveLength(1);
  });
});

describe('reports', () => {
  const completeADay = async () => {
    const context = setup();
    await user().click(await screen.findByRole('button', { name: 'Start day' }));
    await screen.findByRole('heading', { name: 'Wake' });

    context.clock.advanceMinutes(60);
    await user().click(screen.getByRole('button', { name: 'Next' }));
    context.clock.advanceMinutes(60);
    await user().click(await screen.findByRole('button', { name: 'Next' }));
    context.clock.advanceMinutes(30);
    await user().click(await screen.findByRole('button', { name: 'Finish day' }));
    await screen.findByRole('heading', { name: 'Day complete' });
    return context;
  };

  it('reports the day, its steps, and the deviations that were measured', async () => {
    await completeADay();

    await user().click(screen.getByRole('link', { name: 'See the report' }));

    expect(await screen.findByRole('heading', { name: /2 Mar 2026/ })).toBeInTheDocument();
    expect(screen.getByText('Day started')).toBeInTheDocument();
    // Wake was planned for 30 minutes and took 60.
    const wake = screen.getByRole('heading', { name: 'Wake' }).closest('li')!;
    expect(within(wake).getByText('Duration 30m 00s longer')).toBeInTheDocument();
  });

  it('allows a completed-day boundary to be corrected from its report', async () => {
    await completeADay();
    await user().click(screen.getByRole('link', { name: 'See the report' }));
    await screen.findByRole('heading', { name: /2 Mar 2026/ });

    await user().click(screen.getByRole('button', { name: /08:30 Edit time/ }));
    fireEvent.change(screen.getByLabelText('Actual changeover time'), {
      target: { value: '2026-03-02T08:20' },
    });
    await user().click(screen.getByRole('button', { name: 'Save correction' }));

    expect(await screen.findByText('20m 00s late')).toBeInTheDocument();
  });

  it('ranks the steps that cause deviation across days', async () => {
    await completeADay();

    window.location.hash = '#/reports';
    await user().click(await screen.findByRole('link', { name: 'Steps causing deviation' }));

    const items = await screen.findAllByRole('listitem');
    expect(within(items[0]!).getByRole('heading')).toHaveTextContent('Wake');
    expect(within(items[0]!).getByText(/30m 00s over plan/)).toBeInTheDocument();
    expect(
      screen.getByText(/Skipped steps are never counted as time saved/),
    ).toBeInTheDocument();
  });

  it('says so plainly when nothing has been measured yet', async () => {
    setup({ hash: '#/reports' });
    expect(
      await screen.findByText('Complete a day to see which steps cause deviation.'),
    ).toBeInTheDocument();
  });
});

describe('recovery', () => {
  it('reports unreadable storage instead of offering actions', async () => {
    const repository = new InMemoryRepository(sequentialIdGenerator());
    vi.spyOn(repository, 'saveTimetable').mockRejectedValue(
      new QuartzError('storage-unavailable', 'Site data is blocked.', ['QuotaExceededError']),
    );

    setup({ repository });

    expect(await screen.findByRole('heading', { name: 'Quartz cannot continue' })).toBeVisible();
    expect(screen.getByText('QuotaExceededError')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start day' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Restore from a backup' })).toBeInTheDocument();
  });
});

describe('backup', () => {
  it('warns about data loss and only replaces data after an explicit confirmation', async () => {
    setup({ hash: '#/data' });

    expect(
      await screen.findByText(/Restoring replaces all data currently on this device/),
    ).toBeInTheDocument();

    const backup = JSON.stringify({
      format: 'quartz.backup',
      version: 1,
      exportedAt: '2026-03-02T00:00:00.000Z',
      timetables: [simpleTimetable],
      runs: [],
      events: [],
    });
    const file = new File([backup], 'quartz-backup.json', { type: 'application/json' });

    await user().upload(screen.getByLabelText('Choose a backup file'), file);

    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm restore' });
    expect(
      within(dialog).getByText(/permanently deletes everything currently stored/),
    ).toBeInTheDocument();

    await user().click(within(dialog).getByRole('button', { name: 'Replace all data' }));
    expect(await screen.findByRole('heading', { name: 'Backup restored' })).toBeInTheDocument();
  });

  it('states plainly that unexported data can be lost', async () => {
    setup({ hash: '#/data' });

    expect(
      await screen.findByText(
        /Uninstalling the app, clearing browser storage or site data, or losing the device will remove any data that has not been exported/,
      ),
    ).toBeInTheDocument();
  });

  it('rejects an invalid file and leaves the existing data alone', async () => {
    setup({ hash: '#/data' });

    const file = new File(['{"format":"nope"}'], 'bad.json', { type: 'application/json' });
    await user().upload(await screen.findByLabelText('Choose a backup file'), file);

    expect(await screen.findByRole('alert')).toHaveTextContent(/not a Quartz backup/);
    expect(screen.getByText('Your existing data is unchanged.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
