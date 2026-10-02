import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousAxe, PASSWORD, start } from './support';

const stamp = () => Date.now().toString(36).toUpperCase();
const HEAD =
  'design_code,plant_code,design_name,fc_mpa,strength_basis,test_age_days,exposure_classes,slump_mm,nmas_mm,pumpable,material_name,material_category,quantity,unit,approval_reference,currently_in_production,avg_monthly_volume_m3';
const row = (code: string, name: string, cat: string, q: string, unit = 'kg/m3') =>
  `${code},AMM-01,Imported ${code},30,cylinder,28,F0;S0;W0;C1,125,19,true,${name},${cat},${q},${unit},Submittal ${code},true,1200`;
const csv = (code: string) =>
  [
    HEAD,
    row(code, 'إسمنت (تجريبي)', 'cement', '360'),
    row(code, `ماء ${code}`, 'water', '175'),
    row(code, 'رمل مغسول (تجريبي)', 'fine_agg', '820'),
    row(code, 'Demo coarse 20 mm', 'coarse_agg', '1000'),
  ].join('\n');

async function secondManager(page: Page) {
  await start(page, { role: 'admin' });
  const email = `qc2-${stamp().toLowerCase()}@khalta.test`;
  const res = await page.request.post('/api/users', {
    data: { email, name: 'QC Manager Two', role: 'qc_manager', password: PASSWORD },
  });
  expect(res.ok()).toBe(true);
  return email;
}
const signInAs = async (page: Page, email: string) => {
  const res = await page.request.post('/api/auth/sign-in/email', {
    data: { email, password: PASSWORD },
  });
  expect(res.ok()).toBe(true);
};

async function importDesign(page: Page, code: string) {
  await page.goto('/imports');
  await page
    .getByTestId('legacy-file')
    .setInputFiles({ name: 'legacy.csv', mimeType: 'text/csv', buffer: Buffer.from(csv(code)) });
  await expect(page.getByTestId('mapping')).toBeVisible();
  await expect(page.getByTestId('matching')).toBeVisible();
  // exact names link by themselves; the water name has no library match and needs a choice
  await expect(page.locator('[data-material="إسمنت (تجريبي)"]')).toHaveAttribute(
    'data-decision',
    'exact',
  );
  const water = page.locator(`[data-material="ماء ${code}"]`);
  await expect(water).toHaveAttribute('data-decision', 'unresolved');
  await expect(page.getByTestId('legacy-commit')).toBeDisabled();
  await water.getByTestId('link-select').click();
  await page.getByRole('option', { name: 'Create as a new material' }).click();
  await expect(water).toHaveAttribute('data-decision', 'create');
  await expect(page.getByTestId('plan-summary')).toContainText('1 ready');
  await page.getByTestId('legacy-commit').click();
  await expect(page.getByTestId('import-done')).toBeVisible();
}

test('legacy import wizard: exact names link, unknown ones need a choice, commit creates a draft', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  const code = `E2E-${stamp()}`;
  await importDesign(page, code);
  await page.goto('/library');
  await page.getByTestId('library-search').fill(code);
  const r = page.locator(`[data-code="${code}"]`);
  await expect(r).toBeVisible();
  await expect(r).toContainText('Draft');
  await r.getByRole('button').click();
  const sheet = page.getByTestId('design-sheet');
  await expect(sheet.getByTestId('evaluation-pending')).toContainText(
    'No compliance, cost or strength figure',
  );
  await expect(sheet.getByTestId('design-lines')).toContainText('360');
  await expect(sheet.getByTestId('design-warnings')).toContainText('no tests yet');
  await expectNoSeriousAxe(page, 'design sheet');
});

test('attestation: the importer is refused, a second QC manager attests, the design is labelled legacy', async ({
  page,
}) => {
  const second = await secondManager(page);
  await signInAs(page, 'qc.manager@khalta.test');
  const code = `ATT-${stamp()}`;
  await importDesign(page, code);

  await page.goto('/library');
  await page.getByTestId('queue-tab').click();
  await page.getByTestId('library-search').fill(code);
  await page.locator(`[data-code="${code}"]`).getByRole('button').click();
  await page.getByTestId('attest-open').click();
  await expect(page.getByTestId('four-eyes-note')).toBeVisible();
  await page.getByTestId('attest-note').fill('Checked against the signed submittal');
  await page.getByTestId('attest-submit').click();
  await expect(page.getByTestId('attest-error')).toContainText('cannot approve');

  await signInAs(page, second);
  await page.goto('/library');
  await page.getByTestId('queue-tab').click();
  await page.getByTestId('library-search').fill(code);
  await page.locator(`[data-code="${code}"]`).getByRole('button').click();
  await page.getByTestId('attest-open').click();
  await expect(page.getByTestId('four-eyes-note')).toHaveCount(0);
  await expect(page.getByTestId('attest-ref')).toHaveValue(`Submittal ${code}`);
  await expectNoSeriousAxe(page, 'attest dialog');
  await page.getByTestId('attest-note').fill('Checked against the signed submittal');
  await page.getByTestId('attest-submit').click();
  await expect(page.getByTestId('attest-dialog')).toHaveCount(0);
  const sheet = page.getByTestId('design-sheet');
  await expect(sheet.locator('[data-status="in_production"]')).toBeVisible();
  await expect(sheet.locator('[data-approval="legacy_attested"]')).toContainText(
    'not yet evaluated by Khalta',
  );
  await expect(sheet.getByTestId('design-history')).toContainText(
    'Checked against the signed submittal',
  );
  await expect(sheet.getByTestId('attest-open')).toHaveCount(0);
});

test('viewers can read the library but cannot import or attest', async ({ page }) => {
  await start(page, { role: 'viewer' });
  await page.goto('/library');
  await expect(page.getByRole('heading', { name: 'Mix Library' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Import designs' })).toHaveCount(0);
  await expect(page.getByTestId('queue-tab')).toHaveCount(0);
});

test('Arabic renders the import wizard right-to-left and passes axe', async ({ page }) => {
  await start(page, { role: 'qc_manager', lang: 'ar' });
  await page.goto('/imports');
  await page.getByTestId('legacy-file').setInputFiles({
    name: 'legacy.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv(`AR-${stamp()}`)),
  });
  await expect(page.getByTestId('matching')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expectNoSeriousAxe(page, 'imports ar');
});
