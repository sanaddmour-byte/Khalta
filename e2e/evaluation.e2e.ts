import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousAxe, PASSWORD, settled, start } from './support';

const stamp = () => Date.now().toString(36).toUpperCase();
const HEAD =
  'design_code,plant_code,design_name,fc_mpa,strength_basis,test_age_days,exposure_classes,slump_mm,nmas_mm,pumpable,material_name,material_category,quantity,unit,approval_reference,currently_in_production,avg_monthly_volume_m3';
const csv = (code: string, exposure: string) => {
  const row = (name: string, cat: string, q: string) =>
    `${code},AMM-01,Evaluated ${code},30,cylinder,28,${exposure},100,19,true,${name},${cat},${q},kg/m3,Submittal ${code},true,1200`;
  return [
    HEAD,
    row('إسمنت (تجريبي)', 'cement', '360'),
    row(`ماء ${code}`, 'water', '175'),
    row('رمل مغسول (تجريبي)', 'fine_agg', '820'),
    row('Demo coarse 20 mm', 'coarse_agg', '1000'),
  ].join('\n');
};

/** Imports through the API (the wizard itself is covered in library.e2e.ts). */
async function importDesign(page: Page, code: string, exposure = 'F0;S0;W0;C1') {
  const up = await page.request.post('/api/imports/legacy/upload?filename=evaluation.csv', {
    headers: { 'content-type': 'application/octet-stream' },
    data: Buffer.from(csv(code, exposure)),
  });
  expect(up.ok()).toBe(true);
  const { batchId } = await up.json();
  const done = await page.request.post(`/api/imports/legacy/${batchId}/commit`, {
    data: { decisions: { [`water|ماء ${code}`]: { create: true } } },
  });
  expect(done.ok()).toBe(true);
}

async function openDesign(page: Page, code: string) {
  await page.goto('/library');
  await page.getByTestId('library-search').fill(code);
  await page.locator(`[data-code="${code}"]`).getByRole('button').click();
  await expect(page.getByTestId('design-sheet')).toBeVisible();
}

test('evaluate a design: verdict, independent validator, checks, strength adequacy and cost; the design becomes evaluated', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  const code = `EV-${stamp()}`;
  await importDesign(page, code);
  await openDesign(page, code);
  const sheet = page.getByTestId('design-sheet');
  await expect(sheet.locator('[data-status="draft"]').first()).toBeVisible();
  await sheet.getByTestId('tab-evaluation').click();
  await expect(sheet.getByTestId('evaluation-none')).toContainText('has not been evaluated yet');

  await sheet.getByTestId('evaluate-run').click();
  await expect(sheet.getByTestId('evaluation-verdict')).toBeVisible();
  await expect(sheet.getByTestId('validator-status')).toHaveAttribute('data-validator', 'pass');
  await expect(sheet.getByTestId('validator-status')).toContainText('Independently verified');
  // every number is judged against a limit with its source; unverified rules are said to be unverified
  await expect(sheet.locator('[data-evidence="RULE_UNVERIFIED"]').first()).toBeVisible();
  await expect(sheet.locator('[data-evidence="TRIAL_REQUIRED"]').first()).toBeVisible();
  const minFc = sheet.locator('[data-check-id="min_fc"]');
  await expect(minFc).toHaveAttribute('data-status', 'pass');
  await expect(minFc).toContainText('ACI');
  await expect(sheet.locator('[data-check-id="yield"]')).toBeVisible();
  // a check without data is "not evaluated" with its blocker, never a pass
  const chloride = sheet.locator('[data-check-id="cl.nonprestressed"]');
  await expect(chloride).toBeVisible();
  const status = await chloride.getAttribute('data-status');
  expect(['pass', 'fail', 'not_evaluated']).toContain(status);
  if (status === 'not_evaluated') await expect(chloride.getByTestId('check-blocker')).toBeVisible();
  // strength adequacy is labelled as not compliance and carries the baseline evidence
  const adequacy = sheet.getByTestId('adequacy-block');
  await expect(adequacy).toContainText('Not a compliance result');
  await expect(adequacy.locator('[data-evidence="MODEL_BASELINE"]')).toBeVisible();
  await expect(sheet.getByTestId('water-block')).toContainText('does not predict');
  await expect(sheet.getByTestId('evaluation-cost')).toBeVisible();
  await expect(sheet.getByTestId('assumptions')).toContainText('entrapped-air');
  await expectNoSeriousAxe(page, 'evaluation tab');

  // the state moved, with the evidence recorded in the history
  await sheet.getByTestId('tab-details').click();
  await expect(sheet.locator('[data-status="evaluated"]').first()).toBeVisible();
  await expect(sheet.getByTestId('design-history')).toContainText('Draft → Evaluated');
  await expect(sheet.getByTestId('evaluation-pending')).toHaveCount(0);

  // evaluating again keeps the state and keeps the first evaluation
  await sheet.getByTestId('tab-evaluation').click();
  await sheet.getByTestId('evaluate-run').click();
  await expect(page.getByLabel('Earlier evaluations')).toBeVisible();
});

test('a failing design is evaluated and shows its failures; Both is the default ruleset', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  const code = `EVF-${stamp()}`;
  await importDesign(page, code, 'S2');
  await openDesign(page, code);
  const sheet = page.getByTestId('design-sheet');
  await sheet.getByTestId('tab-evaluation').click();
  await expect(sheet.getByTestId('evaluate-mode')).toContainText('Both');
  await sheet.getByTestId('evaluate-run').click();
  await expect(sheet.getByTestId('evaluation-verdict')).toHaveAttribute('data-verdict', 'fail');
  await expect(sheet.locator('[data-check-id="max_wcm"]')).toHaveAttribute('data-status', 'fail');
  await expect(sheet.locator('[data-check-id="min_fc"]')).toHaveAttribute('data-status', 'fail');
  await expect(sheet.locator('[data-check-id="sulfate_cement"]')).toBeVisible();
  // JS values are not on file yet; Both is therefore provisional on ACI and says so
  await expect(sheet.getByText('Provisional: rules in use are not yet verified')).toBeVisible();
  await sheet.getByTestId('tab-details').click();
  await expect(sheet.locator('[data-status="evaluated"]').first()).toBeVisible();
});

test('an attested design keeps its state; a failed evaluation raises the revalidation flag in the Library', async ({
  page,
}) => {
  await start(page, { role: 'admin' });
  const email = `qc3-${stamp().toLowerCase()}@khalta.test`;
  const made = await page.request.post('/api/users', {
    data: { email, name: 'QC Manager Three', role: 'qc_manager', password: PASSWORD },
  });
  expect(made.ok()).toBe(true);
  await start(page, { role: 'qc_manager' });
  const code = `EVA-${stamp()}`;
  await importDesign(page, code, 'S2');
  // a second QC manager attests (four eyes)
  await page.request.post('/api/auth/sign-in/email', { data: { email, password: PASSWORD } });
  const id = (await (await page.request.get(`/api/designs?q=${code}`)).json())[0].id as string;
  const att = await page.request.post(`/api/designs/${id}/attest`, {
    data: {
      approvalReference: `Submittal ${code}`,
      inProduction: true,
      note: 'Checked against the signed submittal',
    },
  });
  expect(att.ok()).toBe(true);

  await openDesign(page, code);
  const sheet = page.getByTestId('design-sheet');
  await sheet.getByTestId('tab-evaluation').click();
  await sheet.getByTestId('evaluate-run').click();
  await expect(sheet.getByTestId('evaluation-verdict')).toHaveAttribute('data-verdict', 'fail');
  await expect(sheet.getByTestId('revalidation-badge')).toBeVisible();
  await expect(sheet.locator('[data-status="in_production"]').first()).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByTestId('revalidation-tab').click();
  await page.getByTestId('library-search').fill(code);
  const row = page.locator(`[data-code="${code}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId('revalidation-chip')).toBeVisible();
  await expectNoSeriousAxe(page, 'revalidation tab');
});

test('cost-blind roles never see cost figures and cannot evaluate', async ({ page }) => {
  await start(page, { role: 'qc_manager' });
  const code = `EVS-${stamp()}`;
  await importDesign(page, code);
  await openDesign(page, code);
  await page.getByTestId('design-sheet').getByTestId('tab-evaluation').click();
  await page.getByTestId('design-sheet').getByTestId('evaluate-run').click();
  await expect(page.getByTestId('evaluation-cost')).toBeVisible();

  await start(page, { role: 'viewer' });
  await openDesign(page, code);
  const sheet = page.getByTestId('design-sheet');
  await sheet.getByTestId('tab-evaluation').click();
  await expect(sheet.getByTestId('evaluation-verdict')).toBeVisible();
  await expect(sheet.getByTestId('evaluate-run')).toHaveCount(0);
  await expect(sheet.getByTestId('evaluation-cost')).toHaveCount(0);
  await expect(sheet).not.toContainText('JOD');
});

test('Arabic: right-to-left, isolated numbers and passes axe', async ({ page }) => {
  await start(page, { role: 'qc_manager', lang: 'ar' });
  const code = `EVR-${stamp()}`;
  await importDesign(page, code);
  await openDesign(page, code);
  const sheet = page.getByTestId('design-sheet');
  await sheet.getByTestId('tab-evaluation').click();
  await sheet.getByTestId('evaluate-run').click();
  await expect(sheet.getByTestId('evaluation-verdict')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(sheet.getByTestId('validator-status')).toContainText('بشكل مستقل');
  await expect(sheet.getByTestId('adequacy-block')).toContainText('ليست نتيجة مطابقة');
  expect(await sheet.locator('[data-check-id] bdi').count()).toBeGreaterThan(2);
  await settled(page);
  await expectNoSeriousAxe(page, 'evaluation tab ar');
});

test('settings: near-limit percentage, safety margin and yield tolerance can be configured', async ({
  page,
}) => {
  await start(page, { role: 'admin' });
  await page.goto('/settings');
  await expect(page.getByTestId('s-nearLimitPct')).toBeVisible();
  await expect(page.getByTestId('s-yieldTolerance')).toHaveValue('0.005');
  await expect(page.getByTestId('s-nearLimitPct')).toHaveValue('');
  await expect(page.getByTestId('s-safetyMarginMpa')).toHaveValue('');
});
