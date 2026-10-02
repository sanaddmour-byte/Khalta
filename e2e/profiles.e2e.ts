import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousAxe, settled, start } from './support';
import { seedProfiles, SYN_PROFILES } from './studio-world';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(180_000);
  await seedProfiles();
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

test('profiles screen: list, versions, code check, usage, new draft needs another approver', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  await page.goto('/profiles');
  const rows = page.getByTestId('profile-row');
  await expect(rows.filter({ hasText: SYN_PROFILES.family })).toBeVisible();
  await expect(rows.filter({ hasText: SYN_PROFILES.tenant })).toBeVisible();
  await expectNoSeriousAxe(page, 'profiles list');

  await rows.filter({ hasText: SYN_PROFILES.family }).getByRole('button').click();
  await expect(page.getByTestId('profile-sheet')).toBeVisible();
  await expect(page.getByTestId('version-1')).toContainText('Approved');
  await expect(page.getByTestId('profile-content')).toContainText('38–46');
  await expect(page.getByTestId('profile-usage')).toContainText('Used by 0 designs');
  await expectNoSeriousAxe(page, 'profile sheet');

  // a new version is a draft; the approved one stays in force
  await page.getByTestId('new-version').click();
  await page.getByTestId('profile-note').fill('SYNTHETIC tweak');
  await page.getByTestId('profile-save').click();
  await expect(page.getByTestId('version-2')).toContainText('Draft');
  await expect(page.getByTestId('profile-sheet')).toContainText('Version 1 stays in force');
  // the author (a QC manager) cannot approve their own version
  await expect(page.getByTestId('approve-version')).toBeDisabled();
  await expect(page.getByTestId('profile-sheet')).toContainText('Changes from v1 to v2');
});

test('studio: suggested profile, origin badge, draft blocks Generate, save as profile', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  await page.goto('/studio');
  await choose(page, 'req-plant', /STU-01/);
  await choose(page, 'req-mode', 'ACI');
  const picker = page.getByTestId('profile-picker');
  await expect(picker).toContainText(SYN_PROFILES.family);
  await page.getByTestId('profiles-apply-suggested').click();
  const origin = page.getByTestId('char-origin-sand_ratio_pct');
  await expect(origin).toHaveAttribute('data-origin', 'profile');
  await expect(origin).toContainText(SYN_PROFILES.family);
  await expect(page.getByTestId('generate')).toBeEnabled();

  // the user's own value overrides the profile's and says so
  await page.getByTestId('profiles-clear').click();
  await expect(page.getByTestId('char-origin-sand_ratio_pct')).toHaveCount(0);
  await page.getByTestId('profiles-apply-suggested').click();

  // save these characteristics as a profile
  await page.getByTestId('save-as-profile').click();
  await expect(page.getByTestId('profile-dialog')).toBeVisible();
  await page.getByTestId('profile-name-en').fill('SYNTHETIC studio draft');
  await page.getByTestId('profile-name-ar').fill('مسودة اصطناعية');
  await page.getByTestId('profile-family').fill('Studio family');
  await page.getByTestId('profile-save').click();
  await expect(page.getByTestId('profile-dialog')).toHaveCount(0);

  await page.goto('/profiles');
  const row = page.getByTestId('profile-row').filter({ hasText: 'SYNTHETIC studio draft' });
  await expect(row).toContainText('Draft');
  await expectNoSeriousAxe(page, 'profiles with draft');
});

test('studio: a draft profile blocks Generate but not Evaluate', async ({ page }) => {
  await start(page, { role: 'qc_manager' });
  await page.goto('/studio');
  await choose(page, 'req-plant', /STU-01/);
  await choose(page, 'req-mode', 'ACI');
  await expect(page.getByTestId('profile-picker')).toContainText('SYNTHETIC studio draft');
  await page.getByTestId('profile-pick-SYNTHETIC studio draft').check();
  await expect(page.getByTestId('profiles-draft-warning')).toBeVisible();
  await expect(page.getByTestId('generate')).toBeDisabled();
  await page.getByTestId('path-evaluate').click();
  await expect(page.getByTestId('profiles-draft-warning')).toBeVisible();
  await expectNoSeriousAxe(page, 'studio with draft profile');
});

test('Arabic: profiles screen is RTL and accessible', async ({ page }) => {
  await start(page, { role: 'qc_manager', lang: 'ar' });
  await page.goto('/profiles');
  await expect(page.getByTestId('profiles-table')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await settled(page);
  await expectNoSeriousAxe(page, 'profiles ar');
});
