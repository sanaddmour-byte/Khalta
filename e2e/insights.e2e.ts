import { expect, test } from '@playwright/test';
import { liveDesign, restoreRules, seedInsight, seedLifecycleWorld } from './lifecycle-world';
import { expectNoSeriousAxe, settled, start } from './support';

test.describe.configure({ mode: 'serial' });
let plantId = '';
let designId = '';
const CODE = 'INS-E2E-1';

test.beforeAll(async () => {
  test.setTimeout(180_000);
  plantId = await seedLifecycleWorld();
  designId = await liveDesign(CODE);
  // SYNTHETIC fixtures: the jobs that create insights are covered by the API tests
  await seedInsight(plantId, {
    type: 'opportunity',
    severity: 'medium',
    designId,
    key: 'e2e-opp',
    payload: { designCode: CODE, designVersion: 1, request: {}, candidate: {} },
    savingJodPerM3: '1.250',
    annualJod: '15000.000',
  });
  await seedInsight(plantId, {
    type: 'test_drift',
    severity: 'high',
    key: 'e2e-drift',
    payload: { materialName: 'SYNTHETIC cement', drift: [{ field: 'sg' }], affectedDesigns: 2 },
  });
  await seedInsight(plantId, {
    type: 'low_strength',
    severity: 'critical',
    designId,
    key: 'e2e-low',
    payload: { designCode: CODE, averageMpa: 31.2, requiredFcrMpa: 38.5 },
  });
});
test.afterAll(async () => {
  await restoreRules();
});

test('inbox: severity order, theoretical label, filters, snooze, dismiss with a reason, critical banner', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  await page.goto('/insights');
  await expect(page.getByTestId('insights-page')).toBeVisible();
  await expect(page.getByTestId('critical-banner')).toBeVisible();
  const cards = page.getByTestId('insight-card');
  await expect(cards.first()).toHaveAttribute('data-severity', 'critical');
  await expect(cards.nth(1)).toHaveAttribute('data-severity', 'high');
  const opp = page.locator('[data-testid="insight-card"][data-type="opportunity"]');
  await expect(opp.getByTestId('insight-saving')).toContainText('Theoretical');
  await expect(opp.getByTestId('insight-saving')).toContainText('1.25');
  await expect(page.getByTestId('digest-panel')).toBeVisible();
  await expectNoSeriousAxe(page, 'insights inbox');

  await page.getByTestId('filter-type').click();
  await page.getByRole('option', { name: 'Cost opportunity' }).click();
  await expect(cards).toHaveCount(1);
  await page.getByTestId('filter-type').click();
  await page.getByRole('option', { name: 'All' }).click();
  await expect(cards).toHaveCount(3);

  // snooze takes the drift card out of the inbox
  await page
    .locator('[data-testid="insight-card"][data-type="test_drift"]')
    .getByTestId('insight-snooze-1')
    .click();
  await expect(cards).toHaveCount(2);

  // dismiss needs a reason; the opportunity goes
  await opp.getByTestId('insight-dismiss').click();
  await page.waitForTimeout(600); // the dialog's entrance animation misreads contrast mid-fade
  await expectNoSeriousAxe(page, 'dismiss dialog');
  await expect(page.getByTestId('dismiss-submit')).toBeDisabled();
  await page.getByTestId('dismiss-reason').fill('Not worth a trial this quarter');
  await page.getByTestId('dismiss-submit').click();
  await expect(opp).toHaveCount(0);

  // the critical alert stays until it is handled; dismissing it clears the banner
  const low = page.locator('[data-testid="insight-card"][data-type="low_strength"]');
  await expect(low).toBeVisible();
  await low.getByTestId('insight-dismiss').click();
  await page.getByTestId('dismiss-reason').fill('Reviewed with the lab; retest ordered');
  await page.getByTestId('dismiss-submit').click();
  await expect(page.getByTestId('critical-banner')).toHaveCount(0);
});

test('inbox in Arabic is right-to-left and accessible', async ({ page }) => {
  await seedInsight(plantId, {
    type: 'prices_stale',
    severity: 'info',
    key: 'e2e-stale-ar',
    payload: { stale: [{}, {}] },
  });
  await start(page, { role: 'qc_manager', lang: 'ar' });
  await page.goto('/insights');
  await expect(page.getByTestId('insight-card').first()).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await settled(page);
  await expectNoSeriousAxe(page, 'insights ar');
});

test('production volume: recorded on a live design, a correction needs a note, and the savings board names what is blocked', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  await page.goto(`/library?design=${designId}`);
  const vol = page.getByTestId('volumes-section');
  await expect(vol).toBeVisible();
  await vol.getByTestId('vol-month').fill('2026-08');
  await vol.getByTestId('vol-volume').fill('1200');
  await vol.getByTestId('vol-submit').click();
  await expect(vol.getByTestId('volume-row')).toHaveCount(1);
  await vol.getByTestId('vol-volume').fill('1300');
  await vol.getByTestId('vol-submit').click();
  await expect(vol.getByTestId('vol-error')).toBeVisible();
  await vol.getByTestId('vol-note').fill('Corrected from the weighbridge log');
  await vol.getByTestId('vol-submit').click();
  await expect(vol.getByTestId('volume-row')).toHaveCount(2);
  await expectNoSeriousAxe(page, 'volumes');

  await page.goto('/savings');
  await expect(page.getByTestId('savings-page')).toBeVisible();
  await expectNoSeriousAxe(page, 'savings board');
});

test('suspend and reinstate are manual, e-signed QC manager decisions with a reason', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  await page.goto(`/library?design=${designId}`);
  await expect(page.getByTestId('design-sheet')).toBeVisible();
  await page.getByTestId('do-suspend').click();
  await expect(page.getByTestId('sign-dialog')).toContainText('Nothing suspends automatically');
  await page.getByTestId('sign-reason').fill('Strength results under review');
  await page.getByTestId('sign-submit').click();
  await expect(page.getByTestId('sign-dialog')).toHaveCount(0);
  await expect(page.getByTestId('design-history')).toContainText('Suspended by');
  await page.getByTestId('do-reinstate').click();
  await page.getByTestId('sign-reason').fill('Retest passed; reason no longer applies');
  await page.getByTestId('sign-submit').click();
  await expect(page.getByTestId('sign-dialog')).toHaveCount(0);
  await expect(page.getByTestId('design-history')).toContainText('Reinstated by');
  await expect(page.locator('[data-testid="step-suspend"]')).toBeVisible();
});
