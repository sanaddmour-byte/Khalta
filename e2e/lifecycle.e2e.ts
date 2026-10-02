import { expect, test, type Page } from '@playwright/test';
import {
  addPassingBatch,
  restoreRules,
  SECOND_MANAGER,
  seedLifecycleWorld,
  trialCandidate,
  verifyRules,
} from './lifecycle-world';
import { expectNoSeriousAxe, PASSWORD, start } from './support';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(180_000);
  await seedLifecycleWorld();
});

async function openDesign(page: Page, code: string, tab: 'trial-tab' | 'awaiting-tab' | null) {
  await page.goto('/library');
  if (tab) await page.getByTestId(tab).click();
  await page
    .getByTestId('design-row')
    .filter({ hasText: code })
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByTestId('design-sheet')).toBeVisible();
}
async function signAs(page: Page, email: string) {
  const res = await page.request.post('/api/auth/sign-in/email', {
    data: { email, password: PASSWORD },
  });
  expect(res.ok()).toBe(true);
}
async function sign(page: Page, reason: string) {
  await expect(page.getByTestId('sign-dialog')).toBeVisible();
  await expectNoSeriousAxe(page, 'sign dialog');
  await page.getByTestId('sign-reason').fill(reason);
  await page.getByTestId('sign-submit').click();
  await expect(page.getByTestId('sign-dialog')).toHaveCount(0);
}

test.afterAll(async () => {
  await restoreRules();
});

test('trial → approval: unmet gates are named, the author is blocked, a second manager signs', async ({
  page,
}) => {
  const code = 'LCY-E2E-1';
  const id = await trialCandidate(code);
  await start(page, { role: 'qc_manager' });

  // no trial batch can be logged until M4.2: the gate says so and Start trial is disabled
  await openDesign(page, code, 'trial-tab');
  await expect(page.getByTestId('step-start-trial')).toContainText('No trial batch is logged');
  await expect(page.getByTestId('do-start-trial')).toBeDisabled();
  await expectNoSeriousAxe(page, 'lifecycle trial candidate');

  await addPassingBatch(id);
  await openDesign(page, code, 'trial-tab');
  await expect(page.getByTestId('do-start-trial')).toBeEnabled();
  await page.getByTestId('do-start-trial').click();
  await expect(page.getByTestId('step-pass-trial')).toBeVisible();
  await expect(page.getByTestId('gate-criterion_slump')).toHaveAttribute('data-met', 'true');
  await page.getByTestId('do-pass-trial').click();
  await sign(page, 'Reviewed the SYNTHETIC trial results');
  await expect(page.getByTestId('step-approve')).toBeVisible();

  // the rules are not verified in this database: approval lists the unmet gate and stays disabled
  await expect(page.getByTestId('gate-rules_verified')).toHaveAttribute('data-met', 'false');
  await expect(page.getByTestId('do-approve')).toBeDisabled();
  // the author, even a QC manager, is blocked by four-eyes
  await expect(page.getByTestId('gate-four_eyes')).toHaveAttribute('data-met', 'false');

  await verifyRules();
  // a second QC manager approves
  await signAs(page, SECOND_MANAGER);
  await page.goto('/library');
  await page.getByTestId('awaiting-tab').click();
  await page
    .getByTestId('design-row')
    .filter({ hasText: code })
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByTestId('gate-four_eyes')).toHaveAttribute('data-met', 'true');
  await expect(page.getByTestId('gate-rules_verified')).toHaveAttribute('data-met', 'true');
  await expectNoSeriousAxe(page, 'lifecycle approval gates');
  await page.getByTestId('do-approve').click();
  await sign(page, 'All gates met; approved for production');
  await expect(page.getByTestId('design-history')).toContainText('Approved by QC Manager Two');
  await expect(page.getByTestId('step-release')).toBeVisible();

  await page.getByTestId('do-release').click();
  await sign(page, 'Released to the plant');
  await expect(page.getByTestId('design-history')).toContainText('Released by QC Manager Two');
  // let the confirmation toast finish its entrance and leave: axe misreads text mid-animation
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15_000 });
  await expectNoSeriousAxe(page, 'lifecycle released');
});

test('Arabic: the lifecycle section is right-to-left and accessible', async ({ page }) => {
  const code = 'LCY-E2E-2';
  await trialCandidate(code);
  await start(page, { role: 'qc_manager', lang: 'ar' });
  await page.goto('/library');
  await page.getByTestId('trial-tab').click();
  await page
    .getByTestId('design-row')
    .filter({ hasText: code })
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByTestId('lifecycle-section')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expectNoSeriousAxe(page, 'lifecycle ar');
});
