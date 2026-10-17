import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';

import { createBackupDocument } from '../src/domain/backup';
import { buildRunReport, computePlannedSchedule } from '../src/domain/analysis';
import { parseTimetable } from '../src/domain/timetable';
import type { Run, RunEvent } from '../src/domain/types';
import { RunDriver } from '../src/test/runDriver';

const MONDAY = new Date('2026-03-02T00:00:00.000Z');
const EIGHT_THIRTY_IST = new Date('2026-03-02T03:00:00.000Z');

const taskCard = (page: Page, name: string) =>
  page.getByRole('heading', { name, exact: true }).locator('xpath=ancestor::article[1]');

const chooseOverflowAction = async (page: Page, name: string) => {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('button', { name, exact: true }).click();
};

const capture = async (
  page: Page,
  testInfo: TestInfo,
  name: string,
  fullPage = true,
) => {
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
};

const startGymDay = async (page: Page, time = MONDAY) => {
  await page.clock.install({ time });
  await page.goto('/');
  await page.getByRole('heading', { name: 'Gym weekday', exact: true }).waitFor();
  await page
    .getByRole('heading', { name: 'Gym weekday', exact: true })
    .locator('..')
    .getByRole('button', { name: 'Start day' })
    .click();
  await expect(
    taskCard(page, 'Brush, hydrate and change').locator('xpath=ancestor::li[1]'),
  ).toHaveClass(/timeline-item--current/);
};

const budgetReviewBackup = () => {
  const timetable = parseTimetable(
    JSON.parse(
      readFileSync(new URL('../src/timetables/weekday-gym.v1.json', import.meta.url), 'utf8'),
    ),
    'weekday-gym.v1.json',
  );
  const runs: Run[] = [];
  const events: RunEvent[] = [];

  for (let day = 0; day < 5; day += 1) {
    const start = new Date(MONDAY.getTime() + day * 24 * 60 * 60_000);
    const localDate = `2026-03-${String(day + 2).padStart(2, '0')}`;
    const planned = computePlannedSchedule(timetable, localDate);
    const driver = new RunDriver(timetable, start, `budget-run-${day + 1}`);
    let occurredAt = start;
    planned.forEach((item, index) => {
      const extra = index === 0 ? 10 * 60_000 : index === 1 ? 15 * 60_000 : 0;
      occurredAt = new Date(occurredAt.getTime() + item.plannedDurationMs + extra);
      driver.next(occurredAt);
    });
    // Reconstruct here as an extra guard that the generated backup contains valid histories.
    buildRunReport(timetable, driver.run, driver.events);
    runs.push(driver.run);
    events.push(...driver.events);
  }

  return JSON.stringify(
    createBackupDocument(
      { timetables: [timetable], runs, events },
      new Date('2026-03-07T00:00:00.000Z'),
    ),
  );
};

test('@budget-review shows actionable budgets and evidence without mobile overflow', async ({
  page,
}, testInfo) => {
  await page.goto('/#/data');
  await page.getByLabel('Choose a backup file').setInputFiles({
    name: 'budget-review.json',
    mimeType: 'application/json',
    buffer: Buffer.from(budgetReviewBackup()),
  });
  await page.getByRole('button', { name: 'Replace all data' }).click();
  await expect(page.getByRole('heading', { name: 'Backup restored' })).toBeVisible();

  await page.goto('/#/reports');
  await page
    .getByRole('heading', { name: 'Gym weekday', exact: true })
    .locator('..')
    .getByRole('link', { name: 'Time budget review' })
    .click();

  await expect(page.getByRole('heading', { name: 'Time budget review' })).toBeVisible();
  await expect(page.getByText('2 budgets worth reviewing')).toBeVisible();
  const brush = page
    .getByRole('heading', { name: 'Brush, hydrate and change', exact: true })
    .locator('xpath=ancestor::article[1]');
  await expect(brush).toContainText('Typical recorded');
  await expect(brush).toContainText('25 min');
  await expect(brush).toContainText('Typical budget: 25 min (+10 min)');
  await brush.getByText('View recorded days').click();
  await expect(brush.getByRole('link', { name: 'Open day' })).toHaveCount(5);
  await capture(page, testInfo, 'time-budget-review');
});

test('@timeline-geometry planned tasks stay on clock time while only the marker follows now', async ({
  page,
}, testInfo) => {
  await startGymDay(page, EIGHT_THIRTY_IST);

  const brush = taskCard(page, 'Brush, hydrate and change');
  await expect(brush.getByText('Planned 05:30–05:45')).toBeVisible();
  await expect(brush).toHaveClass(/timeline-item__card/);
  await expect(brush.locator('xpath=..')).toHaveClass(/timeline-item--current/);

  const pooja = taskCard(page, '🕉️ Pooja');
  await expect(pooja.locator('.timeline-now')).toHaveCount(1);
  expect(Number(await pooja.locator('.timeline-now').getAttribute('data-clock-fraction'))).toBeLessThan(
    0.1,
  );
  await expect(page.locator('.timeline-now')).toHaveCount(1);
  const timeline = page.locator('.day-timeline');
  await expect
    .poll(() =>
      timeline.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      })),
    )
    .toMatchObject({ clientHeight: expect.any(Number), scrollHeight: expect.any(Number) });
  expect(
    await timeline.evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBeTruthy();
  await timeline.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(taskCard(page, '😴 Sleep')).toBeVisible();
  await capture(page, testInfo, 'absolute-clock-timeline');
});

test('task flyout edits times without gesture-editor artifacts', async ({ page }, testInfo) => {
  await startGymDay(page);
  await page.clock.fastForward('30:00');
  await page.getByRole('button', { name: /^Next:/ }).click();
  await page.clock.fastForward('05:00');

  const gym = taskCard(page, '🏋️ Gym');
  await gym.click();
  await expect(page.getByRole('dialog', { name: '🏋️ Gym' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit times' }).click();
  await expect(page.getByLabel('Start')).toHaveValue('2026-03-02T06:00');
  await expect(page.getByLabel('End')).toHaveCount(0);
  await page.getByLabel('Start').fill('2026-03-02T05:55');
  await capture(page, testInfo, 'flyout-time-editor', false);
  await page.getByRole('button', { name: 'Save times' }).click();

  await expect(taskCard(page, '🏋️ Gym').getByText(/Actual 05:55/)).toBeVisible();
  await expect(taskCard(page, 'Brush, hydrate and change')).toContainText('Actual 05:30–05:55');
  await expect(page.locator('.timeline-gap')).toHaveCount(0);
  await expect(page.locator('.timeline-draft-bar, .timeline-edge, .timeline-boundary')).toHaveCount(0);
  await capture(page, testInfo, 'flyout-time-edit');
});

test('a dotted gap adds a named task and survives reload', async ({ page }, testInfo) => {
  await startGymDay(page);
  await page.clock.fastForward('15:00');
  await chooseOverflowAction(page, 'Finish current task');
  await page.clock.fastForward('15:00');
  await page.getByRole('button', { name: 'Start 🏋️ Gym' }).click();

  const addGap = page.getByRole('button', { name: /Add a task between 05:45 and 06:00/ });
  await expect(addGap).toBeVisible();
  await addGap.click();
  await expect(page.getByRole('dialog', { name: 'Add a task' })).toBeVisible();
  await expect(page.getByLabel('Task name')).toHaveValue('Between tasks');
  await page.getByLabel('Task name').fill('📞 Phone call');
  await capture(page, testInfo, 'gap-task-editor', false);
  await page.getByRole('button', { name: 'Add task' }).click();

  await expect(taskCard(page, '📞 Phone call')).toContainText('Actual 05:45–06:00');
  await expect(addGap).toHaveCount(0);
  await capture(page, testInfo, 'recorded-gap-task');
  await page.reload();
  await expect(taskCard(page, '📞 Phone call')).toContainText('Actual 05:45–06:00');
});

test('contextual pause and unplanned-task actions remain available', async ({ page }, testInfo) => {
  await startGymDay(page);
  await page.clock.fastForward('10:00');

  await page.getByRole('button', { name: 'Open Brush, hydrate and change details' }).click();
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.clock.fastForward('05:00');
  await expect(page.getByRole('button', { name: 'Resume Brush, hydrate and change' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume Brush, hydrate and change' }).click();
  await page.clock.fastForward('05:00');

  await page
    .getByRole('button', { name: 'Open Brush, hydrate and change details' })
    .last()
    .click();
  await page.getByRole('button', { name: 'Start another task' }).click();
  await expect(page.getByLabel('Task name')).toHaveValue('Between tasks');
  await page.getByLabel('Task name').fill('📞 Phone call');
  await page.getByRole('button', { name: 'Start', exact: true }).click();

  await expect(taskCard(page, '📞 Phone call').locator('xpath=ancestor::li[1]')).toHaveClass(
    /timeline-item--current/,
  );
  await capture(page, testInfo, 'contextual-actions');
});

test('mobile overflow dismissal and tap-based reordering stay discoverable', async ({
  page,
}, testInfo) => {
  await startGymDay(page);

  await page.getByRole('button', { name: 'More actions' }).click();
  const finish = page.getByRole('button', { name: 'Finish current task' });
  await expect(finish).toBeVisible();
  await page.locator('.screen').click({ position: { x: 4, y: 4 } });
  await expect(finish).toBeHidden();

  await page.getByRole('button', { name: 'Change next task' }).click();
  await expect(page.getByText('This changes the order for today only.')).toBeVisible();
  await page.getByRole('button', { name: '🥣 Breakfast', exact: true }).click();
  await expect(taskCard(page, '🥣 Breakfast')).toContainText('Order changed for today');
  await capture(page, testInfo, 'mobile-reorder');
});

test('completed report supports flyout editing and gap insertion', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await startGymDay(page);
  const plannedMinutes = [
    15, 75, 30, 60, 15, 30, 60, 165, 45, 225, 75, 15, 15, 45, 45, 15, 30, 480,
  ];
  for (let index = 0; index < plannedMinutes.length - 1; index += 1) {
    await page.clock.fastForward(plannedMinutes[index]! * 60_000);
    if (index === 4) {
      await chooseOverflowAction(page, 'Finish current task');
      await page.clock.fastForward('05:00');
      await page.getByRole('button', { name: 'Start 🥣 Breakfast' }).click();
    } else {
      await page.getByRole('button', { name: /^Next:/ }).click();
    }
  }
  await page.clock.fastForward(plannedMinutes.at(-1)! * 60_000);
  await page.getByRole('button', { name: 'Wake up & finish day' }).click();
  await expect(page.getByRole('heading', { name: 'Day complete' })).toBeVisible();
  await page.goto('/#/reports');
  await page.getByRole('link', { name: 'Open day' }).click();

  await expect(page.getByRole('heading', { name: /2 Mar 2026/ })).toBeVisible();
  await page.getByRole('button', { name: 'Open 🕉️ Pooja details' }).click();
  await page.getByRole('button', { name: 'Edit times' }).click();
  await page.getByLabel('End').fill('2026-03-02T08:40');
  await page.getByRole('button', { name: 'Save times' }).click();

  const addGap = page.getByRole('button', { name: /Add a task between 08:40 and 08:50/ });
  await addGap.click();
  await page.getByLabel('Task name').fill('Prepare breakfast');
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(taskCard(page, 'Prepare breakfast')).toContainText('Actual 08:40–08:50');
  await capture(page, testInfo, 'completed-report-edit');
  await page.reload();
  await expect(taskCard(page, 'Prepare breakfast')).toBeVisible();
});
