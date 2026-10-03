import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@playwright/test';
import { settled, start } from './support';

const outDir = join('docs', 'screens', process.env['MILESTONE'] ?? 'M7.1');
mkdirSync(outDir, { recursive: true });

for (const lang of ['en', 'ar'] as const) {
  for (const width of [1440, 1024, 390] as const) {
    const tag = `${lang}-${width}`;
    test(`cement entry and list ${tag}`, async ({ page }) => {
      await start(page, { role: 'qc_manager', lang, width });
      await page.goto('/materials');
      await page.getByTestId('new-material').click();
      await page.locator('#m-cat').click();
      await page
        .getByRole('option')
        .filter({ hasText: /^(Cement|إسمنت)/ })
        .first()
        .click();
      await page.getByTestId('m-name-en').fill('White cement 52.5');
      await page.getByTestId('cement-suggestion').waitFor();
      await settled(page);
      await page.screenshot({ path: join(outDir, `cement-entry-${tag}.png`), fullPage: true });
    });
  }
}
