import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousAxe, settled, start } from './support';

const unique = (p: string) => `${p} ${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PDF = {
  name: 'lab-report.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n% e2e\n'),
};
const PASTE_OK = '9.5\t4.75\t2.36\t1.18\t0.6\t0.3\t0.15\n100\t95\t80\t60\t40\t15\t5';
const PASTE_BAD = '9.5\t4.75\t2.36\n100\t80\t90';

const openNew = async (page: Page) => {
  await page.goto('/materials');
  await page.getByTestId('new-material').click();
  await expect(page.getByTestId('entry-dialog')).toBeVisible();
};
const row = (page: Page, name: string) =>
  page.locator(`[data-testid="material-row"][data-material="${name}"]`);

test('SG + absorption alone evaluates; design names gradation as a blocker; declared values are flagged (F-007)', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  const name = unique('Sand');
  await openNew(page);
  await page.getByTestId('m-name-en').fill(name);
  await page.getByTestId('f-sg_ssd').fill('2.62');
  await page.getByTestId('f-absorption_pct').fill('1.4');
  const submit = page.getByTestId('entry-submit');
  await expect(submit).toBeDisabled(); // a declared value needs a reason
  await page.getByTestId('declared-reason').fill('Supplier phoned the values, report to follow');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByTestId('entry-dialog')).toHaveCount(0);

  const sheet = page.getByTestId('material-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-ready="evaluate:true"]')).toBeVisible();
  await expect(sheet.locator('[data-ready="design:false"]')).toBeVisible();
  await expect(page.getByTestId('blockers-design')).toContainText('Sieve analysis');
  await expect(sheet.locator('[data-evidence="INPUT_USER_DECLARED"]').first()).toBeVisible();
  await expect(page.getByTestId('declared-note')).toContainText('Specific gravity');
  await expectNoSeriousAxe(page, 'material sheet');
});

test('pasting a gradation row computes FM live; a non-monotonic gradation is rejected', async ({
  page,
}) => {
  await start(page, { role: 'qc_engineer' });
  await openNew(page);
  await page.getByTestId('m-name-en').fill(unique('Washed sand'));
  await page.getByTestId('f-sg_ssd').fill('2.6');
  await page.getByTestId('paste-input').fill(PASTE_BAD);
  await page.getByTestId('paste-apply').click();
  await expect(page.getByTestId('gradation-errors')).toContainText('never increase');
  await expect(page.getByTestId('entry-submit')).toBeDisabled();

  await page.getByTestId('paste-input').fill(PASTE_OK);
  await page.getByTestId('paste-apply').click();
  await expect(page.getByTestId('paste-assumptions')).toContainText('% PASSING');
  await expect(page.getByTestId('gradation-errors')).toHaveCount(0);
  await expect(page.getByTestId('gradation-table')).toBeVisible();
  // sieves coarser than 9.5 mm are inferred as passing 100%, so the FM is computable: 3.05
  await expect(page.getByTestId('fm-live')).toContainText('3.05');
});

test('a lab report needs its file; the declared→lab upgrade keeps both versions in history', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  const name = unique('Crushed sand');
  await openNew(page);
  await page.getByTestId('m-name-en').fill(name);
  await page.getByTestId('f-sg_ssd').fill('2.68');
  await page.getByTestId('f-absorption_pct').fill('1.1');
  await page.getByTestId('declared-reason').fill('first estimate');
  await page.getByTestId('entry-submit').click();
  await expect(page.getByTestId('material-sheet')).toBeVisible();

  await page.getByTestId('upgrade-source').click();
  const submit = page.getByTestId('entry-submit');
  await expect(submit).toBeDisabled(); // lab_report is preselected and needs the report
  await page.getByTestId('attach-input').setInputFiles(PDF);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByTestId('entry-dialog')).toHaveCount(0);

  const sheet = page.getByTestId('material-sheet');
  await expect(sheet.locator('[data-source-kind="lab_report"]').first()).toBeVisible();
  await sheet.getByRole('tab', { name: 'Test history' }).click();
  await expect(page.getByTestId('test-history').locator('li')).toHaveCount(2);
  await expect(page.getByTestId('test-history')).toContainText('lab-report.pdf');
});

test('unsaved entries survive a reload as a local draft and are offered back', async ({ page }) => {
  await start(page, { role: 'qc_manager' });
  await openNew(page);
  await page.getByTestId('m-name-en').fill('Draft sand');
  await page.getByTestId('f-sg_ssd').fill('2.71');
  await page.waitForTimeout(700); // autosave debounce
  await page.reload();
  await page.getByTestId('new-material').click();
  await expect(page.getByTestId('draft-banner')).toBeVisible();
  await page.getByRole('button', { name: 'Restore draft' }).click();
  await expect(page.getByTestId('f-sg_ssd')).toHaveValue('2.71');
});

test('values outside the usual range warn but still save', async ({ page }) => {
  await start(page, { role: 'qc_manager' });
  await openNew(page);
  await page.getByTestId('m-name-en').fill(unique('Odd sand'));
  await page.getByTestId('f-sg_ssd').fill('3.8');
  await expect(page.getByTestId('sanity-warnings')).toContainText('outside the usual range');
  await page.getByTestId('declared-reason').fill('unusual heavy aggregate');
  await expect(page.getByTestId('entry-submit')).toBeEnabled();
});

test('plant manager sees materials but cannot create them', async ({ page }) => {
  await start(page, { role: 'plant_manager' });
  await page.goto('/materials');
  await expect(page.getByRole('heading', { name: 'Materials' })).toBeVisible();
  await expect(page.getByTestId('new-material')).toHaveCount(0);
});

test('the gradation chart is never mirrored and has a table alternative in Arabic', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager', lang: 'ar' });
  await page.goto('/materials');
  await page.getByTestId('materials-search').fill('Demo washed sand');
  await row(page, 'Demo washed sand').getByRole('button').click();
  await page.getByRole('tab', { name: 'التدرج' }).click();
  const chart = page.getByTestId('gradation-chart');
  await expect(chart).toBeVisible();
  await expect(chart).toHaveAttribute('dir', 'ltr');
  await expect(page.getByTestId('gradation-values')).toBeVisible();
  await settled(page);
  await expectNoSeriousAxe(page, 'material sheet ar');
});

test('admin manages plants and users', async ({ page }) => {
  await start(page, { role: 'admin' });
  await page.goto('/plants');
  const code = `T${Date.now().toString(36).slice(-5).toUpperCase()}`;
  await page.getByTestId('new-plant').click();
  await page.getByTestId('plant-code').fill(code);
  await page.getByTestId('plant-name-en').fill('Test plant');
  await page.getByTestId('plant-name-ar').fill('مصنع تجريبي');
  await page.getByTestId('plant-save').click();
  await expect(page.getByTestId('plant-dialog')).toHaveCount(0);
  await expect(page.getByTestId('plants-table')).toContainText(code);

  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Users' }).click();
  const email = `e2e-${Date.now().toString(36)}@khalta.test`;
  await page.getByTestId('new-user').click();
  await page.getByTestId('user-name').fill('E2E User');
  await page.getByTestId('user-email').fill(email);
  await page.getByTestId('user-password').fill('a-long-enough-password');
  await page.getByTestId('user-save').click();
  await expect(page.getByTestId('user-dialog')).toHaveCount(0);
  await expect(page.getByTestId('users-table')).toContainText(email);
  await expectNoSeriousAxe(page, 'settings users');
});

test('settings: engineering authority changes sanity ranges; the admin sees them locked and why', async ({
  page,
}) => {
  await start(page, { role: 'admin' });
  await page.goto('/settings');
  await expect(page.getByTestId('s-sg_max')).toBeDisabled();
  await expect(page.getByTestId('s-maxPlants')).toBeEnabled();
  await expect(page.getByTestId('settings-authority-note')).toContainText('engineering authority');
  await start(page, { role: 'qc_manager' });
  await page.goto('/settings');
  await expect(page.getByTestId('s-sg_max')).toBeEnabled();
  await expect(page.getByTestId('s-maxPlants')).toBeDisabled();
  await expect(page.getByTestId('s-sg_max')).toHaveValue('3.1');
  await page.getByTestId('s-sg_max').fill('3.2');
  await page.getByTestId('settings-save').click();
  await page.reload();
  await expect(page.getByTestId('s-sg_max')).toHaveValue('3.2');
  await page.getByTestId('s-sg_max').fill('3.1');
  await page.getByTestId('settings-save').click();
  await expectNoSeriousAxe(page, 'settings general');
});
