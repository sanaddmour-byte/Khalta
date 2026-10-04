import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousAxe, settled, start } from './support';
import { seedStudioWorld } from './studio-world';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(180_000);
  await seedStudioWorld();
});

async function choose(page: Page, testId: string, option: string | RegExp) {
  await page.getByTestId(testId).click();
  await page
    .getByRole(
      'option',
      typeof option === 'string' ? { name: option, exact: true } : { name: option },
    )
    .click();
}
async function open(page: Page, opts: Parameters<typeof start>[1] = { role: 'qc_manager' }) {
  await start(page, opts);
  await page.goto('/studio');
  await expect(page.getByTestId('studio-page')).toBeVisible();
  await choose(page, 'req-plant', /STU-01/);
  await choose(page, 'req-mode', 'ACI');
  await expect(page.getByTestId('pool-chip').first()).toBeVisible();
}

test('generate: candidates with evidence, compare, inspect, validator, request trial', async ({
  page,
}) => {
  await open(page);
  await expect(page.getByTestId('trial-banner')).toContainText('not approved');
  await expect(page.getByTestId('dof-meter')).toContainText('quantities left');
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('candidates-stage')).toBeVisible();
  const cards = page.getByTestId('candidate-card');
  await expect(cards).toHaveCount(5);
  await expect(cards.first().getByTestId('candidate-evidence')).toContainText('Trial required');
  await expect(cards.first().getByTestId('candidate-cost')).toBeVisible();
  // pin two → comparison table; the fifth cannot be pinned after four
  await page.getByTestId('pin-1').click();
  await page.getByTestId('pin-2').click();
  await expect(page.getByTestId('compare-table')).toBeVisible();
  await page.getByTestId('pin-3').click();
  await page.getByTestId('pin-4').click();
  await expect(page.getByTestId('pin-5')).toBeDisabled();
  await expectNoSeriousAxe(page, 'studio candidates');

  await page.getByTestId('inspect-1').click();
  await expect(page.getByTestId('inspect-stage')).toBeVisible();
  await expect(page.getByTestId('validator-status')).toHaveAttribute('data-status', 'pass');
  await expect(page.getByTestId('proportion-totals')).toContainText('1.000');
  await page.getByTestId('tab-compliance').click();
  await expect(
    page.getByTestId('compliance-table').or(page.locator('table').first()),
  ).toBeVisible();
  await page.getByTestId('tab-gradation').click();
  await expect(page.getByTestId('combined-chart')).toBeVisible();
  await expect(page.getByTestId('shilstone-chart')).toBeVisible();
  await page.getByTestId('tab-strength').click();
  await expect(page.getByTestId('strength-evidence')).toContainText('no plant strength model');
  await page.getByTestId('tab-validator').click();
  await expect(page.getByTestId('validator-report')).toContainText('Validator version');
  await expectNoSeriousAxe(page, 'studio inspect');

  await page.getByTestId('stage-save').click();
  const code = `STU-${Date.now().toString(36).toUpperCase()}`;
  await page.getByTestId('save-code').fill(code);
  await page.getByTestId('save-name').fill('Studio candidate');
  await page.getByTestId('request-trial').click();
  await expect(page.getByTestId('trial-done')).toContainText('not approved');
  const designs = await page.request.get(`/api/designs?q=${code}`);
  const list = (await designs.json()) as { code: string; status: string }[];
  expect(list.find((d) => d.code === code)?.status).toBe('trial_candidate');
});

test('a value that would loosen a code limit is rejected inline with its clause', async ({
  page,
}) => {
  await open(page);
  await page.getByTestId('exposure-S1').click();
  await expect(page.getByTestId('char-bound-wcm')).toContainText('0.5');
  await choose(page, 'char-mode-wcm', 'Fixed');
  await page.getByTestId('char-value-wcm').fill('0.7');
  await expect(page.getByTestId('char-rejected-wcm')).toContainText('ACI');
  await expect(page.getByTestId('generate')).toBeDisabled();
  await page.getByTestId('char-value-wcm').fill('0.4');
  await expect(page.getByTestId('char-rejected-wcm')).toHaveCount(0);
});

test('air-entrained exposure disables Generate and says why', async ({ page }) => {
  await open(page);
  await page.getByTestId('exposure-F2').click();
  await expect(page.getByTestId('air-entrained-note')).toBeVisible();
  await expect(page.getByTestId('generate')).toBeDisabled();
});

test('missing parameters are named, not hidden (Jordanian values are not on file)', async ({
  page,
}) => {
  await open(page);
  await choose(page, 'req-mode', /JS/);
  await expect(page.getByTestId('blocked-panel')).toBeVisible();
  await expect(page.getByTestId('blocker').first()).toBeVisible();
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('blocked-panel')).toBeVisible();
  await expectNoSeriousAxe(page, 'studio blocked');
});

test('a conflict names the value to release; Release re-runs and finds candidates', async ({
  page,
}) => {
  await open(page);
  await choose(page, 'char-mode-binder_kg', 'Range');
  await page.getByTestId('char-max-binder_kg').fill('200');
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('conflict-panel')).toHaveAttribute('data-kind', 'user_specified');
  await expect(page.getByTestId('conflict-item')).toHaveAttribute('data-id', 'binder_kg');
  await expectNoSeriousAxe(page, 'studio conflict');
  await page.getByTestId('release-binder_kg').click();
  await expect(page.getByTestId('candidate-card').first()).toBeVisible({ timeout: 30_000 });
});

test('evaluate path: type a mix, see the verdict and the validator, save a draft; nothing is approved', async ({
  page,
}) => {
  await open(page);
  await page.getByTestId('path-evaluate').click();
  const mix: [string, string][] = [
    ['cem-i', '350'],
    ['water', '175'],
    ['sand', '780'],
    ['c20', '1035'],
  ];
  for (const [i, [name, kg]] of mix.entries()) {
    if (i > 0 || (await page.getByTestId('mix-line').count()) === 0)
      await page.getByTestId('mix-add').click();
    await choose(page, `mix-material-${i}`, new RegExp(`^${name}$`));
    await page.getByTestId(`mix-kg-${i}`).fill(kg);
  }
  await page.getByTestId('evaluate').click();
  await expect(page.getByTestId('inspect-stage')).toBeVisible();
  await expect(page.getByTestId('validator-status')).toHaveAttribute('data-status', 'pass');
  await page.getByTestId('stage-save').click();
  const code = `STE-${Date.now().toString(36).toUpperCase()}`;
  await page.getByTestId('save-code').fill(code);
  await page.getByTestId('save-name').fill('Typed mix');
  await expect(page.getByTestId('request-trial')).toBeDisabled();
  await page.getByTestId('save-draft').click();
  await expect(page.getByTestId('draft-done')).toContainText('Nothing is approved');
});

test('a what-if material can be added from the quick-entry drawer and is marked', async ({
  page,
}) => {
  await open(page);
  await page.getByTestId('adhoc-open').click();
  await expect(page.getByTestId('adhoc-drawer')).toBeVisible();
  await choose(page, 'adhoc-category', 'Cement');
  await page.getByTestId('adhoc-name-en').fill('Offer cement');
  await page.getByTestId('adhoc-sg').fill('3.15');
  await page.getByTestId('adhoc-price').fill('0.05');
  await expectNoSeriousAxe(page, 'studio drawer');
  await page.getByTestId('adhoc-add').click();
  await expect(page.getByTestId('adhoc-chip')).toContainText('Offer cement');
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('candidate-card').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('candidate-evidence').first()).toContainText('declared');
});

test('compare plants runs the request at both plants after the mapping is confirmed', async ({
  page,
}) => {
  await open(page);
  await page.getByTestId('compare-plants-open').click();
  await expect(page.getByTestId('compare-plants')).toBeVisible();
  await page.getByTestId('compare-plant-STU-01').click();
  await page.getByTestId('compare-plant-STU-02').click();
  await expect(page.getByTestId('compare-run')).toBeDisabled();
  await page.getByTestId('compare-confirm').click();
  await page.getByTestId('compare-run').click();
  await expect(page.getByTestId('compare-row')).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId('compare-results')).toContainText('5 candidates');
  await expect(page.getByTestId('compare-plants')).toContainText('Theoretical and trial-only');
  await expectNoSeriousAxe(page, 'studio compare');
});

test('roles without design.write have no Studio', async ({ page }) => {
  await start(page, { role: 'sales' });
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Design Studio' })).toHaveCount(0);
});

test('Arabic: right-to-left, no serious axe violations', async ({ page }) => {
  await start(page, { role: 'qc_manager', lang: 'ar' });
  await page.goto('/studio');
  await expect(page.getByTestId('studio-page')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await settled(page);
  await expectNoSeriousAxe(page, 'studio ar');
});

test('cement colour: the choice is offered and can be set back to any', async ({ page }) => {
  await open(page);
  await choose(page, 'req-colour', 'White only');
  await expect(page.getByTestId('req-colour')).toContainText('White only');
  await expect(page.getByTestId('pool')).toBeVisible();
  await choose(page, 'req-colour', 'Any');
  await expectNoSeriousAxe(page, 'studio colour');
});

test('switching plant with generated, unsaved candidates asks first; staying keeps them', async ({
  page,
}) => {
  await open(page);
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('candidate-card').first()).toBeVisible();
  await page.getByTestId('plant-switcher').click();
  // pick a plant other than the current one (choosing the current one changes nothing)
  await page.getByRole('option', { selected: false }).first().click();
  const dialog = page.getByTestId('unsaved-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('unsaved work');
  await expectNoSeriousAxe(page, 'unsaved dialog');
  await page.getByTestId('unsaved-stay').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('candidate-card').first()).toBeVisible();
});
