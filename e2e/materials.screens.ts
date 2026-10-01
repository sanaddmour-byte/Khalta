import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@playwright/test';
import { settled, start } from './support';

const milestone = process.env['MILESTONE'] ?? 'M1.1';
const outDir = join('docs', 'screens', milestone);
mkdirSync(outDir, { recursive: true });

for (const lang of ['en', 'ar'] as const) {
  for (const width of [1440, 1024, 390] as const) {
    const tag = `${lang}-${width}`;
    const shot = async (page: import('@playwright/test').Page, name: string) => {
      await settled(page);
      await page.screenshot({ path: join(outDir, `${name}-${tag}.png`), fullPage: true });
    };

    test(`materials list ${tag}`, async ({ page }) => {
      await start(page, { role: 'qc_manager', lang, width });
      await page.goto('/materials');
      await page.getByTestId('material-row').first().waitFor();
      await shot(page, 'materials');
    });

    test(`material detail ${tag}`, async ({ page }) => {
      await start(page, { role: 'qc_manager', lang, width });
      await page.goto('/materials');
      await page.getByTestId('materials-search').fill('Demo washed sand');
      await page.locator('[data-material="Demo washed sand"]').getByRole('button').click();
      await page.getByTestId('material-sheet').waitFor();
      await shot(page, 'material-detail');
      await page.getByRole('tab').nth(1).click();
      await page.getByTestId('gradation-chart').waitFor();
      await page.waitForTimeout(400);
      await shot(page, 'material-gradation');
    });

    test(`quick entry ${tag}`, async ({ page }) => {
      await start(page, { role: 'qc_manager', lang, width });
      await page.goto('/materials');
      await page.getByTestId('new-material').click();
      await page.getByTestId('m-name-en').fill('Screenshot sand');
      await page.getByTestId('f-sg_ssd').fill('2.64');
      await page
        .getByTestId('paste-input')
        .fill('9.5\t4.75\t2.36\t1.18\t0.6\t0.3\t0.15\n100\t95\t80\t60\t40\t15\t5');
      await page.getByTestId('paste-apply').click();
      await page.getByTestId('fm-live').waitFor();
      await shot(page, 'quick-entry');
    });

    test(`plants ${tag}`, async ({ page }) => {
      await start(page, { role: 'admin', lang, width });
      await page.goto('/plants');
      await page.getByTestId('plants-table').waitFor();
      await shot(page, 'plants');
    });

    test(`settings ${tag}`, async ({ page }) => {
      await start(page, { role: 'admin', lang, width });
      await page.goto('/settings');
      await page.getByTestId('s-maxPlants').waitFor();
      await shot(page, 'settings');
      await page.getByRole('tab').nth(1).click();
      await page.getByTestId('users-table').waitFor();
      await shot(page, 'users');
    });
  }
}
test('materials dark', async ({ page }) => {
  await start(page, { role: 'qc_manager', lang: 'ar', theme: 'dark', width: 1440 });
  await page.goto('/materials');
  await page.getByTestId('materials-search').fill('Demo washed sand');
  await page.locator('[data-material="Demo washed sand"]').getByRole('button').click();
  await page.getByRole('tab').nth(1).click();
  await page.getByTestId('gradation-chart').waitFor();
  await page.waitForTimeout(400);
  await settled(page);
  await page.screenshot({
    path: join(outDir, 'material-gradation-ar-1440-dark.png'),
    fullPage: true,
  });
});
