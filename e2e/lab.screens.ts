import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, type Page } from '@playwright/test';
import { seedMoistureWorld, trialCandidate } from './lifecycle-world';
import { settled, start } from './support';

const outDir = join('docs', 'screens', process.env['MILESTONE'] ?? 'M4.2');
mkdirSync(outDir, { recursive: true });
test.beforeAll(async () => {
  test.setTimeout(180_000);
  await seedMoistureWorld();
});

for (const lang of ['en', 'ar'] as const) {
  for (const width of [1440, 1024, 390] as const) {
    const tag = `${lang}-${width}`;
    const shot = async (page: Page, name: string) => {
      await settled(page);
      await page.screenshot({ path: join(outDir, `${name}-${tag}.png`), fullPage: true });
    };
    test(`lab: trial batches, batch weights ${tag}`, async ({ page }) => {
      const code = `LAB-SCR-${lang}-${width}`;
      await trialCandidate(code);
      await start(page, { role: 'qc_manager', lang, width });
      await page.setViewportSize({ width, height: 2600 });
      await page.goto('/library');
      await page.getByTestId('trial-tab').click();
      await page
        .getByTestId('design-row')
        .filter({ hasText: code })
        .getByRole('button')
        .first()
        .click();
      await page.getByTestId('batch-add').click();
      await page.getByTestId('batch-slumpMm').fill('105');
      await page.getByTestId('batch-temperatureC').fill('27');
      await page.getByTestId('batch-save').click();
      await page.getByTestId('results-add').click();
      await page.getByTestId('results-set').fill('SYN-A');
      await page.getByTestId('results-values').fill('39.5, 41, 40.2');
      await page.getByTestId('results-save').click();
      await page.getByTestId('strength-chart').waitFor();
      const w = page.getByTestId('batch-weights');
      await w.getByTestId('moisture-fine_agg').fill('4.5');
      await w.getByTestId('moisture-coarse_agg').fill('0.4');
      await page.getByTestId('batch-convert').click();
      await page.getByTestId('batch-result').waitFor();
      await page
        .locator('[data-sonner-toast]')
        .first()
        .waitFor({ state: 'detached', timeout: 15_000 })
        .catch(() => {});
      await shot(page, 'lab-sheet');
    });
  }
}
