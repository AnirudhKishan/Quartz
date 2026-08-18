import { expect, test, type Page, type TestInfo } from '@playwright/test';

const MONDAY = new Date('2026-03-02T00:00:00.000Z');

const capture = async (page: Page, testInfo: TestInfo, name: string) => {
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
};

const startGymDay = async (page: Page) => {
  await page.clock.install({ time: MONDAY });
  await page.goto('/');
  await page.getByRole('heading', { name: 'Gym weekday', exact: true }).waitFor();
  await page
    .getByRole('heading', { name: 'Gym weekday', exact: true })
    .locator('..')
    .getByRole('button', { name: 'Start day' })
    .click();
  await expect(page.getByText('Brush, hydrate and change in progress')).toBeVisible();
};

test('contextual actions, pause reload, resume, and unplanned work', async ({
  page,
}, testInfo) => {
  await startGymDay(page);
  await page.clock.fastForward('10:00');

  await page
    .getByRole('button', { name: 'Open Brush, hydrate and change details' })
    .click();
  await expect(page.getByRole('dialog', { name: 'Brush, hydrate and change' })).toBeVisible();
  await capture(page, testInfo, 'desktop-task-details');
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.clock.fastForward('05:00');

  await expect(page.getByRole('button', { name: 'Resume Brush, hydrate and change' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'End Brush, hydrate and change' })).toBeVisible();
  await capture(page, testInfo, 'desktop-paused');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Resume Brush, hydrate and change' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume Brush, hydrate and change' }).click();
  await page.clock.fastForward('10:00');
  await capture(page, testInfo, 'desktop-resumed');

  await page
    .getByRole('button', { name: 'Open Brush, hydrate and change details' })
    .last()
    .click();
  await page.getByRole('button', { name: 'Start another task' }).click();
  const input = page.getByLabel('Task name');
  await expect(input).toHaveValue('Between tasks');
  await input.fill('📞 Phone call');
  await page.getByRole('button', { name: 'Start', exact: true }).click();

  await expect(page.getByText('📞 Phone call in progress')).toBeVisible();
  await expect(page.locator('.timeline-item--current').getByText('Unplanned activity')).toBeVisible();
  await capture(page, testInfo, 'desktop-unplanned');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('🏋️ Gym in progress')).toBeVisible();
});

test('normal click opens details while double-click edits boundaries', async ({
  page,
}, testInfo) => {
  await startGymDay(page);
  await page.clock.fastForward('30:00');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.clock.fastForward('10:00');
  const gymCard = page.getByRole('heading', { name: '🏋️ Gym' }).locator('..').locator('..');

  await gymCard.click();
  await expect(page.getByRole('dialog', { name: '🏋️ Gym' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Adjust 🏋️ Gym segment start' })).toHaveCount(0);
  const closeDetails = page.getByRole('button', { name: 'Close task details' });
  await expect(closeDetails).toBeFocused();
  await closeDetails.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Skip current task' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(closeDetails).toBeFocused();
  await closeDetails.click();

  const detailsButton = page.getByRole('button', { name: 'Open 🏋️ Gym details' });
  await detailsButton.focus();
  await detailsButton.press('Enter');
  await expect(page.getByRole('dialog', { name: '🏋️ Gym' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Adjust 🏋️ Gym segment start' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close task details' }).click();

  await gymCard.dblclick();
  const startEdge = page.getByRole('button', { name: 'Adjust 🏋️ Gym segment start' });
  await expect(startEdge).toBeVisible();
  await capture(page, testInfo, 'desktop-edit-boundaries');

  const box = await startEdge.boundingBox();
  if (!box) throw new Error('Start edge has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 5, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByText('Between tasks')).toBeVisible();
  await capture(page, testInfo, 'desktop-edit-gap');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(startEdge).toHaveCount(0);
  await expect(page.getByText('Between tasks')).toBeVisible();
});

test('completed report remains editable and shows the new timetable labels', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await startGymDay(page);
  const plannedMinutes = [
    15, 75, 30, 60, 15, 30, 60, 165, 45, 225, 75, 15, 15, 45, 45, 15, 15, 15, 480,
  ];
  for (let index = 0; index < 18; index += 1) {
    await page.clock.fastForward(plannedMinutes[index]! * 60_000);
    await page.getByRole('button', { name: 'Next' }).click();
  }
  await page.clock.fastForward(plannedMinutes[18]! * 60_000);
  await page.getByRole('button', { name: 'Finish day' }).click();
  await page.getByRole('link', { name: 'See the report' }).click();

  await expect(page.getByRole('heading', { name: /2 Mar 2026/ })).toBeVisible();
  await expect(page.getByText('🪥 Brush')).toBeVisible();
  await expect(page.getByText('Wind down')).toBeVisible();
  await capture(page, testInfo, 'desktop-completed-report');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, testInfo, 'mobile-completed-report');

  const sleepCard = page.getByRole('heading', { name: '😴 Sleep' }).locator('..').locator('..');
  await sleepCard.dblclick();
  await expect(page.getByRole('button', { name: 'Adjust 😴 Sleep segment end' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
});

test.describe('mobile touch interactions', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test('tap opens the sheet and long press enters edit mode', async ({ page }, testInfo) => {
    await startGymDay(page);
    const card = page
      .getByRole('heading', { name: 'Brush, hydrate and change' })
      .locator('..')
      .locator('..');

    await card.tap();
    await expect(page.getByRole('dialog', { name: 'Brush, hydrate and change' })).toBeVisible();
    await capture(page, testInfo, 'mobile-task-sheet');
    await page.getByRole('button', { name: 'Start another task' }).tap();
    await expect(page.getByLabel('Task name')).toHaveValue('Between tasks');
    await page.clock.fastForward('02:00');
    await expect(page.getByLabel('Task name')).toBeFocused();
    await capture(page, testInfo, 'mobile-task-composer');
    await page.getByRole('button', { name: 'Cancel' }).tap();
    await page.getByRole('button', { name: 'Close task details' }).tap();

    const box = await card.boundingBox();
    if (!box) throw new Error('Current card has no bounding box');
    const point = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    await card.dispatchEvent('pointerdown', {
      pointerType: 'touch',
      pointerId: 1,
      ...point,
    });
    await page.waitForTimeout(550);
    await card.dispatchEvent('pointerup', {
      pointerType: 'touch',
      pointerId: 1,
      ...point,
    });

    await expect(
      page.getByRole('button', { name: 'Adjust Brush, hydrate and change segment start' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    await capture(page, testInfo, 'mobile-long-press-edit');
  });
});

test('keyboard editing snaps, carries the previous edge, and restores focus', async ({ page }) => {
  await startGymDay(page);
  await page.clock.fastForward('30:00');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.clock.fastForward('10:00');
  const gymCard = page.getByRole('heading', { name: '🏋️ Gym' }).locator('..').locator('..');

  await gymCard.focus();
  await gymCard.press('Enter');
  const startEdge = page.getByRole('button', { name: 'Adjust 🏋️ Gym segment start' });
  await expect(startEdge).toBeVisible();

  await startEdge.press('ArrowDown');
  await expect(page.getByText('Between tasks')).toBeVisible();
  await expect(page.locator('.timeline-draft-bar')).toContainText('1 changed');

  await startEdge.press('ArrowUp');
  await expect(page.getByText('Between tasks')).toHaveCount(0);
  await expect(startEdge).toHaveClass(/timeline-edge--magnetic/);
  await expect(page.locator('.timeline-draft-bar')).toContainText('0 changed');

  await startEdge.press('ArrowUp');
  await expect(page.getByText('Between tasks')).toHaveCount(0);
  await expect(page.locator('.timeline-draft-bar')).toContainText('2 changed');

  await page.keyboard.press('Escape');
  await expect(startEdge).toHaveCount(0);
  await expect(gymCard).toBeFocused();
});

test('crossing a completed bottom edge carries the next segment and saves', async ({ page }) => {
  await startGymDay(page);
  await page.clock.fastForward('30:00');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.clock.fastForward('30:00');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.clock.fastForward('10:00');

  const gymCard = page.getByRole('heading', { name: '🏋️ Gym' }).locator('..').locator('..');
  await gymCard.dblclick();
  const endEdge = page.getByRole('button', { name: 'Adjust 🏋️ Gym segment end' });
  await endEdge.press('ArrowDown');

  await expect(page.locator('.timeline-draft-bar')).toContainText('2 changed');
  await expect(page.getByText('Between tasks')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(endEdge).toHaveCount(0);

  await gymCard.dblclick();
  await expect(page.getByRole('button', { name: 'Adjust 🏋️ Gym segment end' })).toHaveAttribute(
    'aria-valuetext',
    /T01:05:00\.000Z$/,
  );
  await page.getByRole('button', { name: 'Cancel' }).click();
});

test('a stale timeline draft is rejected without closing the editor', async ({ page, context }) => {
  await startGymDay(page);
  await page.clock.fastForward('30:00');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.clock.fastForward('10:00');
  const gymCard = page.getByRole('heading', { name: '🏋️ Gym' }).locator('..').locator('..');
  await gymCard.dblclick();
  const staleEdge = page.getByRole('button', { name: 'Adjust 🏋️ Gym segment start' });
  await staleEdge.press('ArrowDown');

  const otherPage = await context.newPage();
  await otherPage.clock.install({ time: new Date(MONDAY.getTime() + 40 * 60_000) });
  await otherPage.goto('/#/run');
  const otherGymCard = otherPage
    .getByRole('heading', { name: '🏋️ Gym' })
    .locator('..')
    .locator('..');
  await otherGymCard.dblclick();
  await otherPage
    .getByRole('button', { name: 'Adjust 🏋️ Gym segment start' })
    .press('ArrowDown');
  await otherPage.getByRole('button', { name: 'Save' }).click();

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Could not save these boundaries.')).toBeVisible();
  await expect(staleEdge).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
});

test('repeated pause supports grouped undo, end, undo, and continuation', async ({ page }) => {
  await startGymDay(page);
  await page.clock.fastForward('10:00');
  await page
    .getByRole('button', { name: 'Open Brush, hydrate and change details' })
    .click();
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.clock.fastForward('05:00');
  await page.getByRole('button', { name: 'Resume Brush, hydrate and change' }).click();
  await page.clock.fastForward('10:00');
  await page
    .getByRole('button', { name: 'Open Brush, hydrate and change details' })
    .last()
    .click();
  await page.getByRole('button', { name: 'Pause' }).click();

  await expect(page.getByText('Segment 2 of 2')).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('Brush, hydrate and change in progress')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume Brush, hydrate and change' })).toHaveCount(0);

  await page
    .getByRole('button', { name: 'Open Brush, hydrate and change details' })
    .last()
    .click();
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('button', { name: 'End Brush, hydrate and change' }).click();
  await expect(page.getByText('Between tasks in progress')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume Brush, hydrate and change' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume Brush, hydrate and change' })).toBeVisible();
  await page.getByRole('button', { name: 'End Brush, hydrate and change' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('🏋️ Gym in progress')).toBeVisible();
});
