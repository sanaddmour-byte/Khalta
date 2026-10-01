import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, type Page } from '@playwright/test';
import { settled, start } from './support';

const outDir = join('docs', 'screens', process.env['MILESTONE'] ?? 'M1.2');
mkdirSync(outDir, { recursive: true });

for (const lang of ['en', 'ar'] as const) {
  for (const width of [1440, 1024, 390] as const) {
    const tag = `${lang}-${width}`;
    const shot = async (page: Page, name: string) => {
      await settled(page);
      await page.screenshot({ path: join(outDir, `${name}-${tag}.png`), fullPage: true });
    };
    const open = async (page: Page) => {
      await start(page, { role: 'admin', lang, width });
      await page.goto('/prices');
      await page.getByTestId('price-grid').waitFor();
      await page.locator('[data-cell="Demo cement|AMM-01"]').waitFor();
    };

    test(`price matrix ${tag}`, async ({ page }) => {
      await open(page);
      await page.locator('[data-cell="Demo washed sand|AQB-01"]').click();
      await page.keyboard.press('Enter');
      await page.getByTestId('price-editor').fill('10.750');
      await page.keyboard.press('Enter');
      await page.getByTestId('heatmap-toggle').click();
      await shot(page, 'prices');
    });
    test(`price history ${tag}`, async ({ page }) => {
      await open(page);
      await page.locator('[data-cell="Demo cement|AMM-01"]').click();
      await page.getByTestId('open-history').click();
      await page.getByTestId('history-sheet').waitFor();
      await shot(page, 'price-history');
    });
    test(`price import ${tag}`, async ({ page }) => {
      await open(page);
      await page.getByTestId('price-tools').click();
      await page.getByTestId('tool-import').click();
      await page.getByTestId('import-file').setInputFiles({
        name: 'prices.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(
          'material,plant,price,unit\nDemo cement,AMM-01,abc,JOD/ton\nNope,AMM-01,5,JOD/ton',
        ),
      });
      await page.getByTestId('import-rows').waitFor();
      await shot(page, 'price-import');
    });
  }
}
