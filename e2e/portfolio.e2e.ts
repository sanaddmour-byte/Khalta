import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousAxe, PASSWORD, settled, start } from './support';

const stamp = () => Date.now().toString(36).toUpperCase();
const HEAD =
  'design_code,plant_code,design_name,fc_mpa,strength_basis,test_age_days,exposure_classes,slump_mm,nmas_mm,pumpable,material_name,material_category,quantity,unit,approval_reference,currently_in_production,avg_monthly_volume_m3';
const csv = (code: string, exposure: string) => {
  const row = (name: string, cat: string, q: string) =>
    `${code},AMM-01,Portfolio ${code},30,cylinder,28,${exposure},100,19,true,${name},${cat},${q},kg/m3,Submittal ${code},true,1500`;
  return [
    HEAD,
    row('إسمنت (تجريبي)', 'cement', '360'),
    row(`ماء ${code}`, 'water', '175'),
    row('رمل مغسول (تجريبي)', 'fine_agg', '820'),
    row('Demo coarse 20 mm', 'coarse_agg', '1000'),
  ].join('\n');
};
async function importDesign(page: Page, code: string, exposure = 'F0') {
  const up = await page.request.post('/api/imports/legacy/upload?filename=p.csv', {
    headers: { 'content-type': 'application/octet-stream' },
    data: Buffer.from(csv(code, exposure)),
  });
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

test('portfolio: evaluate all, filter failing, counts, data-quality causes, CSV export', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  const ok = `PF-${stamp()}`;
  const bad = `PFS-${stamp()}`;
  await importDesign(page, ok, 'F0');
  await importDesign(page, bad, 'S2');
  await page.goto('/library');
  await page.getByTestId('portfolio-tab').click();
  await expect(page.getByTestId('portfolio-counts')).toBeVisible();
  await page.getByTestId('evaluate-all').click();
  const rowOk = page.locator(`[data-testid="portfolio-row"][data-code="${ok}"]`);
  const rowBad = page.locator(`[data-testid="portfolio-row"][data-code="${bad}"]`);
  await expect(rowBad).toHaveAttribute('data-verdict', 'fail');
  await expect(rowOk).not.toHaveAttribute('data-verdict', 'none');
  await expect(page.locator('[data-count="failing"] strong')).not.toHaveText('0');
  await page.getByTestId('portfolio-filter').click();
  await page.getByRole('option', { name: 'Failing' }).click();
  await expect(rowBad).toBeVisible();
  await expect(rowOk).toHaveCount(0);
  await expectNoSeriousAxe(page, 'portfolio');

  const download = page.waitForEvent('download');
  await page.getByTestId('export-portfolio').click();
  expect((await download).suggestedFilename()).toBe('khalta-portfolio.csv');

  await page.getByTestId('quality-tab').click();
  await expect(page.getByTestId('data-quality-tab')).toBeVisible();
  await expect(page.getByTestId('dq-group').first()).toBeVisible();
  await expectNoSeriousAxe(page, 'data quality');
});

test('compliance table: failures first, filters, clause link and the traceability popover', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  const code = `CT-${stamp()}`;
  await importDesign(page, code, 'S2');
  await openDesign(page, code);
  const sheet = page.getByTestId('design-sheet');
  await sheet.getByTestId('tab-evaluation').click();
  await sheet.getByTestId('evaluate-run').click();
  await expect(sheet.getByTestId('checks-table')).toBeVisible();
  const first = sheet.getByTestId('check-row').first();
  await expect(first).toHaveAttribute('data-status', 'fail');
  await expect(sheet.getByTestId('clause-link').first()).toHaveAttribute('href', /\/rules\?q=/);
  await sheet.getByTestId('f-result').click();
  await page.getByRole('option', { name: 'Fail' }).click();
  const rows = sheet.getByTestId('check-row');
  const n = await rows.count();
  for (let i = 0; i < n; i++) await expect(rows.nth(i)).toHaveAttribute('data-status', 'fail');
  await sheet.getByTestId('trace-open').first().click();
  await expect(page.getByTestId('trace-popover')).toContainText('Formula');
  await page.keyboard.press('Escape');
  await expectNoSeriousAxe(page, 'compliance table');
});

test('Arabic compliance table shows translated reasons, not English sentences', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager', lang: 'ar' });
  const code = `CA-${stamp()}`;
  await importDesign(page, code, 'S2');
  await openDesign(page, code);
  const sheet = page.getByTestId('design-sheet');
  await sheet.getByTestId('tab-evaluation').click();
  await sheet.getByTestId('evaluate-run').click();
  await expect(sheet.getByTestId('checks-table')).toBeVisible();
  const blocker = sheet.getByTestId('check-blocker').first();
  await expect(blocker).toBeVisible();
  await expect(blocker).not.toContainText('is not on file');
  await expect(sheet.getByTestId('data-quality')).not.toContainText('rule value(s)');
  await settled(page);
  await expectNoSeriousAxe(page, 'compliance ar');
});

test('edit as a new version: live check, draft saved, source untouched, diff shown', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  const code = `ED-${stamp()}`;
  await importDesign(page, code);
  await openDesign(page, code);
  const sheet = page.getByTestId('design-sheet');
  await sheet.getByTestId('edit-open').click();
  const dlg = page.getByTestId('editor-dialog');
  await expect(dlg.getByTestId('preview-validator')).toHaveAttribute('data-validator', 'pass');
  const cement = dlg.locator('[data-material]').first().getByTestId('editor-kg');
  await cement.fill('350');
  await expect(dlg.getByTestId('editor-preview')).toContainText('Live check');
  await expect(dlg.getByTestId('preview-validator')).toBeVisible();
  await cement.fill('abc');
  await expect(dlg.getByTestId('editor-preview')).toContainText('positive quantity');
  await expect(dlg.getByTestId('editor-save')).toBeDisabled();
  await cement.fill('350');
  await dlg.getByTestId('editor-note').fill('Trim the cement');
  await expectNoSeriousAxe(page, 'editor');
  await dlg.getByTestId('editor-save').click();
  await expect(dlg).toHaveCount(0);
  // the new version is open as a draft; the original is still its own version
  await expect(sheet.locator('[data-status="draft"]').first()).toBeVisible();
  const versions = sheet.getByTestId('versions');
  await expect(versions.locator('[data-version="2"]')).toBeVisible();
  await expect(versions.locator('[data-version="1"]')).toBeVisible();
  await versions.getByTestId('compare-prev').click();
  await expect(sheet.getByTestId('diff').locator('[data-change="changed"]')).toHaveCount(1);
});

test('import → evaluate → attest → baseline → manual variant → THEORETICAL entry; cost-blind roles see none of it', async ({
  page,
}) => {
  await start(page, { role: 'admin' });
  const email = `qc4-${stamp().toLowerCase()}@khalta.test`;
  expect(
    (
      await page.request.post('/api/users', {
        data: { email, name: 'QC Manager Four', role: 'qc_manager', password: PASSWORD },
      })
    ).ok(),
  ).toBe(true);

  await start(page, { role: 'qc_manager' });
  const code = `BL-${stamp()}`;
  await importDesign(page, code, 'F0');
  const id = (await (await page.request.get(`/api/designs?q=${code}`)).json())[0].id as string;
  expect(
    (await page.request.post(`/api/designs/${id}/evaluate`, { data: { mode: 'BOTH' } })).ok(),
  ).toBe(true);

  // a second QC manager attests (four eyes)
  await page.request.post('/api/auth/sign-in/email', { data: { email, password: PASSWORD } });
  const att = await page.request.post(`/api/designs/${id}/attest`, {
    data: {
      approvalReference: `Submittal ${code}`,
      inProduction: true,
      note: 'Checked against the signed submittal',
    },
  });
  expect(att.ok()).toBe(true);

  // procurement-side setup: a price for the newly created water, then a named snapshot
  await start(page, { role: 'admin' });
  const mats = await (
    await page.request.get(`/api/materials?q=${encodeURIComponent(`ماء ${code}`)}`)
  ).json();
  const plants = await (await page.request.get('/api/plants')).json();
  const suppliers = await (await page.request.get('/api/suppliers')).json();
  const amm = plants.find((p: { code: string }) => p.code === 'AMM-01').id as string;
  expect(
    (
      await page.request.post('/api/prices', {
        data: {
          entries: [
            {
              materialId: mats[0].id,
              plantId: amm,
              supplierId: suppliers[0].id,
              price: '0.500',
              unit: 'JOD/ton',
            },
          ],
        },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (await page.request.post('/api/price-snapshots', { data: { name: `Snap ${code}` } })).ok(),
  ).toBe(true);

  // QC manager: baseline on that snapshot
  await start(page, { role: 'qc_manager' });
  await page.goto('/savings');
  await expect(page.getByTestId('savings-page')).toBeVisible();
  await page.getByTestId('baseline-open').click();
  const dlg = page.getByTestId('baseline-dialog');
  await dlg.getByTestId('baseline-design').click();
  await page.getByRole('option', { name: new RegExp(code) }).click();
  await dlg.getByTestId('baseline-snapshot').click();
  await page.getByRole('option', { name: new RegExp(`Snap ${code}`) }).click();
  await expectNoSeriousAxe(page, 'baseline dialog');
  await dlg.getByTestId('baseline-submit').click();
  await expect(dlg).toHaveCount(0);
  const base = page.locator(`[data-testid="baseline-row"][data-code="${code}"]`);
  await expect(base).toBeVisible();
  await expect(base).toContainText('Snap');

  // a manual variant: less cement, more coarse aggregate; priced at the baseline's own snapshot
  await openDesign(page, code);
  const sheet = page.getByTestId('design-sheet');
  await sheet.getByTestId('edit-open').click();
  const ed = page.getByTestId('editor-dialog');
  const kgs = ed.getByTestId('editor-kg');
  await kgs.nth(0).fill('350');
  await kgs.nth(3).fill('1010');
  await ed.getByTestId('editor-note').fill('Less cement, more coarse aggregate');
  await expect(ed.getByTestId('preview-validator')).toHaveAttribute('data-validator', 'pass');
  await ed.getByTestId('editor-save').click();
  await expect(ed).toHaveCount(0);
  await sheet.getByTestId('price-opportunity').first().click();
  const out = sheet.getByTestId('opportunity-result');
  await expect(out).toBeVisible();
  await expect(out).toHaveAttribute('data-eligible', 'true');
  await expect(out).toContainText('not approved, not realized');

  await page.goto('/savings');
  const entry = page.getByTestId('entry-row').first();
  await expect(entry).toHaveAttribute('data-state', 'theoretical');
  await expect(entry).toContainText('Theoretical');
  await expectNoSeriousAxe(page, 'savings');

  // cost-blind roles: no ledger, no cost anywhere
  await start(page, { role: 'viewer' });
  await page.goto('/savings');
  await expect(page.getByTestId('savings-page')).toHaveCount(0);
});
