import { expect, test, type Page } from '@playwright/test';
import { settled, start } from './support';

const open = async (page: Page, key: string) => {
  await page.getByTestId('rules-search').fill(key);
  await page.getByTestId(`rule-open-${key}`).first().click();
  await expect(page.getByTestId('rule-sheet')).toBeVisible();
};
const sheetChip = (page: Page, state: string) =>
  page.getByTestId('rule-sheet').locator(`[data-verification="${state}"]`).first();

test('QC manager sees the unverified banner, opens a rule and verifies it with a signed note', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  await page.goto('/rules');
  await expect(page.getByTestId('rules-banner')).toContainText('unverified');
  await open(page, 'durability.F3.min_fc');
  await expect(page.getByTestId('rule-sheet')).toContainText('ACI 318-19 Table 19.3.2.1');
  await expect(sheetChip(page, 'unverified')).toBeVisible();

  await page.getByTestId('verify-open').click();
  const submit = page.getByTestId('verify-submit');
  await expect(submit).toBeDisabled(); // a note is required
  await page
    .getByLabel('E-signature note')
    .fill('Checked against licensed ACI 318-19 Table 19.3.2.1, row F3');
  await submit.click();
  await expect(page.getByTestId('verify-dialog')).toHaveCount(0);
  await expect(sheetChip(page, 'verified')).toBeVisible();
  await expect(page.getByTestId('verification-entry')).toContainText(
    'Checked against licensed ACI 318-19',
  );
  await expect(page.getByTestId('verify-open')).toHaveCount(0); // nothing left to verify
});

test('four-eyes: the person who corrects a value cannot sign it off', async ({ page }) => {
  await start(page, { role: 'qc_manager' });
  await page.goto('/rules');
  await open(page, 'accept.fc_threshold_mpa');
  await page.getByTestId('edit-open').click();
  await page.getByLabel('Reason for the change').fill('Transcription fix from the licensed copy');
  await page.locator('#edit-value').fill('36');
  await page.getByTestId('edit-submit').click();
  await expect(page.getByTestId('edit-dialog')).toHaveCount(0);
  await expect(page.getByTestId('rule-sheet')).toContainText('Version 2');
  await page.getByTestId('verify-open').click();
  await page.getByLabel('E-signature note').fill('I will sign my own correction');
  await page.getByTestId('verify-submit').click();
  await expect(page.getByTestId('verify-error')).toContainText('four-eyes');
  await expect(sheetChip(page, 'unverified')).toBeVisible();
});

test('admin may correct a value (new unverified version) but has no verify action', async ({
  page,
}) => {
  await start(page, { role: 'admin' });
  await page.goto('/rules');
  await open(page, 'hot.max_concrete_temp_c');
  await expect(page.getByTestId('verify-open')).toHaveCount(0);
  await page.getByTestId('edit-open').click();
  await expect(page.getByTestId('edit-dialog')).toContainText('creates version 2');
  await page.locator('#edit-value').fill('33');
  await page.getByLabel('Reason for the change').fill('Project default is 33 degrees');
  await page.getByTestId('edit-submit').click();
  await expect(page.getByTestId('rule-sheet')).toContainText('Version 2');
  await expect(page.getByTestId('rule-sheet').locator('[data-version="1"]')).toBeVisible(); // the old version stays
  await expect(sheetChip(page, 'unverified')).toBeVisible();
});

test('a wrong value shape is rejected in the form before anything is sent', async ({ page }) => {
  await start(page, { role: 'admin' });
  await page.goto('/rules');
  await open(page, 'durability.F0.min_fc');
  await page.getByTestId('edit-open').click();
  await page.locator('#edit-value').fill('seventeen');
  await page.getByLabel('Reason for the change').fill('testing a wrong value');
  await expect(page.getByTestId('edit-dialog')).toContainText('This is not a number');
  await expect(page.getByTestId('edit-submit')).toBeDisabled();
});

test('QC engineer can read rules but has no verify, edit or import actions', async ({ page }) => {
  await start(page, { role: 'qc_engineer' });
  await page.goto('/rules');
  await expect(page.getByTestId('rules-banner')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Import Jordanian values' })).toHaveCount(0);
  await open(page, 'durability.W1.min_fc');
  await expect(page.getByTestId('verify-open')).toHaveCount(0);
  await expect(page.getByTestId('edit-open')).toHaveCount(0);
});

test('roles without rules.read are told why, not shown a broken page', async ({ page }) => {
  await start(page, { role: 'sales' });
  await page.goto('/rules');
  await expect(page.getByText('Not available for your role')).toBeVisible();
});

test('filters and the engineering tab show gaps honestly', async ({ page }) => {
  await start(page, { role: 'qc_manager' });
  await page.goto('/rules');
  await page.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'Not on file' }).click();
  await expect(page.locator('[data-rule="grading.fine.limits"]').first()).toBeVisible();
  await expect(page.locator('[data-rule="durability.S2.max_wcm"][data-ruleset]')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Engineering parameters' }).click();
  await page.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'All statuses' }).click();
  const beta = page.locator('[data-rule="eng.water.beta_fm"]');
  await expect(beta).toContainText('Not on file');
  await expect(page.locator('[data-rule="eng.shilstone.cf.min"]')).toContainText('45');
});

test('table rules show their grid, numbers kept left-to-right', async ({ page }) => {
  await start(page, { role: 'qc_manager', lang: 'ar' });
  await page.goto('/rules');
  await open(page, 'prop.water.non_ae');
  const grid = page.getByTestId('rule-sheet').locator('table');
  await expect(grid).toContainText('207');
  await expect(grid).toContainText('243');
  expect(await grid.locator('bdi[dir="ltr"]').count()).toBeGreaterThan(10);
});

test('importing Jordanian values: errors block the commit, a clean file applies as unverified', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  await page.goto('/rules');
  await page.getByRole('tab', { name: 'Import Jordanian values' }).click();
  const header = 'rule_key,value,units,clause_ref,requirement_class,note_ar,note_en,value_json';
  const bad = `${header}\ndurability.F1.min_fc,24,ppm,JSC-2022 §7.1.1,CODE_HARD,,,\nnot.a.rule,1,ratio,JSC-2022 §1,CODE_HARD,,,`;
  await page.getByTestId('csv-text').fill(bad);
  await page.getByTestId('import-preview').click();
  await expect(page.getByTestId('import-summary')).toContainText(
    '2 with errors'.replace('2 with', '2 with'),
  );
  await expect(page.getByTestId('import-result')).toContainText('do not match');
  await expect(page.getByTestId('import-result')).toContainText('unknown rule_key');
  await expect(page.getByTestId('import-commit')).toBeDisabled();

  const good = `${header}\ndurability.F1.min_fc,24,MPa,JSC-2022 §7.1.1,CODE_HARD,أدنى مقاومة,Min f'c for F1,`;
  await page.getByTestId('csv-text').fill(good);
  await page.getByTestId('import-preview').click();
  await expect(page.getByTestId('import-summary')).toContainText('1 will change');
  await expect(page.getByTestId('import-commit')).toBeEnabled();
  await page.getByTestId('import-commit').click();
  await expect(page.getByTestId('import-result')).toHaveCount(0);

  await page.getByRole('tab', { name: 'Code rules' }).click();
  await page.getByTestId('rules-search').fill('durability.F1.min_fc');
  const jsRow = page.locator('[data-ruleset="JS"] [data-rule="durability.F1.min_fc"]');
  await expect(jsRow).toContainText('24');
  await expect(jsRow.locator('[data-verification="unverified"]:visible')).toBeVisible();
});

test('a file with a missing column is rejected before any row is looked at', async ({ page }) => {
  await start(page, { role: 'admin' });
  await page.goto('/rules');
  await page.getByRole('tab', { name: 'Import Jordanian values' }).click();
  await page.getByTestId('csv-text').fill('rule_key,value\ndurability.F2.min_fc,31');
  await page.getByTestId('import-preview').click();
  await expect(page.getByTestId('file-errors')).toContainText('missing column "units"');
  await expect(page.getByTestId('import-commit')).toBeDisabled();
});

for (const lang of ['en', 'ar'] as const) {
  test(`the detail sheet opens from the end edge in ${lang}`, async ({ page }) => {
    await start(page, { role: 'qc_manager', lang });
    await page.goto('/rules');
    await open(page, 'durability.S1.max_wcm');
    await page.waitForTimeout(300); // slide animation
    const b = (await page.getByTestId('rule-sheet').boundingBox())!;
    const vw = page.viewportSize()!.width;
    if (lang === 'en') expect(Math.abs(b.x + b.width - vw)).toBeLessThan(2);
    else expect(b.x).toBeLessThan(2);
    if (lang === 'ar') {
      await expect(page.getByTestId('rule-sheet')).toContainText('أقصى نسبة ماء إلى مواد إسمنتية');
      await expect(page.getByTestId('rule-sheet')).toContainText('Maximum w/cm'); // the other language is shown too
    }
  });
}

for (const [lang, theme] of [
  ['en', 'light'],
  ['ar', 'dark'],
] as const) {
  test(`the rules screen, detail sheet and dialogs have no serious axe violations (${lang}/${theme})`, async ({
    page,
  }) => {
    const { expectNoSeriousAxe } = await import('./support');
    await start(page, { role: 'qc_manager', lang, theme });
    await page.goto('/rules');
    await settled(page);
    await expectNoSeriousAxe(page, `rules ${lang}/${theme}`);
    await open(page, 'durability.W1.max_wcm'.replace('W1', 'W2'));
    await settled(page);
    await expectNoSeriousAxe(page, 'rule sheet');
    await page.getByTestId('verify-open').click();
    await expectNoSeriousAxe(page, 'verify dialog');
  });
}
