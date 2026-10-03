import { expect, test } from '@playwright/test';
import { restoreRules } from './lifecycle-world';
import { seedStrengthWorld } from './strength-world';
import { expectNoSeriousAxe, settled, start } from './support';

test.describe.configure({ mode: 'serial' });
let versions: string[] = [];

test.beforeAll(async () => {
  test.setTimeout(240_000);
  ({ versions } = await seedStrengthWorld());
});
test.afterAll(async () => {
  await restoreRules();
});

async function openTab(page: import('@playwright/test').Page) {
  await page.goto('/library');
  await page.getByTestId('strength-tab-trigger').click();
  await expect(page.getByTestId('strength-tab')).toBeVisible();
}

test('a fitted model is a proposal with its evidence; a QC manager approves it by e-signature', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  await openTab(page);
  await page.getByTestId('refit').click();
  const card = page.locator('[data-testid="model-card"]').first();
  await expect(card).toBeVisible();
  await expect(card.getByTestId('model-status')).toHaveAttribute('data-status', 'valid');
  // other specs add their own trial sets to the same group, so at least ours
  expect(Number(await card.getByTestId('model-n').innerText())).toBeGreaterThanOrEqual(37);
  await expect(card).toContainText('Not a compliance result');
  await card.getByTestId('model-details').click();
  await expect(card.getByTestId('model-chart')).toBeVisible();
  await expect(card.getByTestId('model-heldout')).toContainText('RMSE');
  await settled(page);
  await expectNoSeriousAxe(page, 'strength model proposal');

  await card.getByTestId('model-approve').click();
  await page.waitForTimeout(600); // dialog entrance animation misreads contrast mid-fade
  await expectNoSeriousAxe(page, 'strength sign dialog');
  await expect(page.getByTestId('model-sign-submit')).toBeDisabled();
  await page.getByTestId('model-reason').fill('Reviewed the SYNTHETIC fit and its held-out check');
  await page.getByTestId('model-sign-submit').click();
  await expect(page.getByTestId('model-sign-dialog')).toHaveCount(0);
  await expect(card.getByTestId('model-status')).toHaveAttribute('data-status', 'in_force');
});

test('the design sheet then shows the plant model, labelled, and the proposals panel names what is missing', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  await page.goto(`/library?design=${versions[1]}`);
  const sheet = page.getByTestId('design-sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByTestId('tab-evaluation').click();
  await sheet.getByTestId('evaluate-run').click();
  await expect(sheet.getByTestId('adequacy-block')).toBeVisible();
  await expect(sheet.getByTestId('adequacy-model-note')).toContainText('plant strength model');
  await expect(sheet.getByTestId('adequacy-model-wc')).toBeVisible();
  await expect(sheet.getByTestId('adequacy-block')).toContainText('Not a compliance result');
  await expectNoSeriousAxe(page, 'adequacy with a model');

  await openTab(page);
  await expect(page.getByTestId('s-proposals')).toBeVisible();
  await expect(page.getByTestId('beta-proposal')).toContainText('proposal only');
});

test('retiring the model returns the evaluator to the published baseline', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page, { role: 'qc_manager' });
  await openTab(page);
  const card = page.locator('[data-testid="model-card"] [data-status="in_force"]').first();
  await expect(card).toBeVisible();
  await page.getByTestId('model-retire').first().click();
  await page.getByTestId('model-reason').fill('Retired after the SYNTHETIC check');
  await page.getByTestId('model-sign-submit').click();
  await expect(page.getByTestId('model-sign-dialog')).toHaveCount(0);
  await expect(
    page.locator('[data-testid="model-status"][data-status="retired"]').first(),
  ).toBeVisible();
  await page.goto(`/library?design=${versions[1]}`);
  const sheet = page.getByTestId('design-sheet');
  await sheet.getByTestId('tab-evaluation').click();
  await sheet.getByTestId('evaluate-run').click();
  await expect(sheet.getByTestId('adequacy-model-note')).toContainText('No plant strength model');
});

test('the Strength tab in Arabic is right-to-left and accessible', async ({ page }) => {
  await start(page, { role: 'qc_manager', lang: 'ar' });
  await openTab(page);
  await expect(page.getByTestId('model-card').first()).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await settled(page);
  await expectNoSeriousAxe(page, 'strength ar');
});
