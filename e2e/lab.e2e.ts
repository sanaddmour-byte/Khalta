import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { seedMoistureWorld, trialCandidate } from './lifecycle-world';
import { expectNoSeriousAxe, start } from './support';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(180_000);
  await seedMoistureWorld();
});

async function openInTrial(page: Page, code: string) {
  await page.goto('/library');
  await page.getByTestId('trial-tab').click();
  await page
    .getByTestId('design-row')
    .filter({ hasText: code })
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByTestId('design-sheet')).toBeVisible();
}

test('log a trial batch and its cylinders; the strength chart and table show them', async ({
  page,
}) => {
  const code = 'LAB-E2E-1';
  await trialCandidate(code);
  await start(page, { role: 'qc_manager' });
  await openInTrial(page, code);
  await expect(page.getByTestId('trial-batches')).toContainText('No trial batch is logged yet');
  await page.getByTestId('batch-add').click();
  await expect(page.getByTestId('batch-dialog')).toBeVisible();
  await expectNoSeriousAxe(page, 'batch dialog');
  await page.getByTestId('batch-slumpMm').fill('105');
  await page.getByTestId('batch-airPct').fill('2');
  await page.getByTestId('batch-temperatureC').fill('27');
  await page.getByTestId('batch-save').click();
  await expect(page.getByTestId('batch-row')).toHaveCount(1);
  await page.getByTestId('results-add').click();
  await page.getByTestId('results-set').fill('SYN-A');
  await page.getByTestId('results-values').fill('39.5, 41, 40.2');
  await expectNoSeriousAxe(page, 'results dialog');
  await page.getByTestId('results-save').click();
  await expect(page.getByTestId('batch-row')).toContainText('39.5, 41, 40.2');
  await expect(page.getByTestId('strength-chart')).toBeVisible();
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15_000 });
  await expectNoSeriousAxe(page, 'trial batches');
});

test('batch weights: convert, the independent check agrees, save; wrong readings are refused by name', async ({
  page,
}) => {
  const code = 'LAB-E2E-2';
  await trialCandidate(code);
  await start(page, { role: 'qc_manager' });
  await openInTrial(page, code);
  const section = page.getByTestId('batch-weights');
  await section.getByTestId('moisture-fine_agg').fill('4.5');
  await section.getByTestId('moisture-coarse_agg').fill('0.4');
  await page.getByTestId('batch-convert').click();
  await expect(page.getByTestId('batch-result')).toBeVisible();
  await expect(page.getByTestId('batch-validator')).toHaveAttribute('data-status', 'pass');
  await expect(page.getByTestId('batch-water')).toContainText('Water to add');
  await page.getByTestId('batch-store').click();
  await expect(page.getByTestId('batch-history')).toContainText('Trial batch weights');
  // an impossible reading is named and cannot be saved
  await section.getByTestId('moisture-fine_agg').fill('40');
  await page.getByTestId('batch-convert').click();
  await expect(page.getByTestId('batch-blockers')).toContainText('impossible');
  await expect(page.getByTestId('batch-store')).toHaveCount(0);
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15_000 });
  await expectNoSeriousAxe(page, 'batch weights');
});

test('submittal PDF downloads in English and Arabic with the not-approved watermark note', async ({
  page,
}) => {
  const code = 'LAB-E2E-3';
  await trialCandidate(code);
  await start(page, { role: 'qc_manager' });
  await openInTrial(page, code);
  await expect(page.getByTestId('submittal')).toContainText('NOT APPROVED');
  for (const lang of ['en', 'ar'] as const) {
    if (lang === 'ar') {
      await page.getByTestId('pdf-lang').click();
      await page.getByRole('option', { name: 'Arabic', exact: true }).click();
    }
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('pdf-download').click(),
    ]);
    const file = await dl.path();
    const bytes = readFileSync(file);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(20_000);
    try {
      const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
      expect(text).toContain(code);
      if (lang === 'ar') expect(text).toContain('مستند اعتماد الخلطة');
    } catch (e) {
      if ((e as { code?: string }).code !== 'ENOENT') throw e; // poppler absent: size and header checks stand
    }
  }
});

test('Arabic: the lab sections are right-to-left and accessible', async ({ page }) => {
  const code = 'LAB-E2E-4';
  await trialCandidate(code);
  await start(page, { role: 'qc_manager', lang: 'ar' });
  await openInTrial(page, code);
  await expect(page.getByTestId('trial-batches')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expectNoSeriousAxe(page, 'lab ar');
});
