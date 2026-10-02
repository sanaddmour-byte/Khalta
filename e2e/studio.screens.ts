import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, type Page } from '@playwright/test';
import { settled, start } from './support';
import { seedStudioWorld } from './studio-world';

const outDir = join('docs', 'screens', process.env['MILESTONE'] ?? 'M3.2');
mkdirSync(outDir, { recursive: true });
test.beforeAll(async () => {
  test.setTimeout(180_000);
  await seedStudioWorld();
});

for (const lang of ['en', 'ar'] as const) {
  for (const width of [1440, 1024, 390] as const) {
    const tag = `${lang}-${width}`;
    const shot = async (page: Page, name: string) => {
      await settled(page);
      await page.screenshot({ path: join(outDir, `${name}-${tag}.png`), fullPage: true });
    };
    test(`studio: requirements, candidates, inspect, blocked, conflict ${tag}`, async ({
      page,
    }) => {
      await start(page, { role: 'qc_manager', lang, width });
      await page.setViewportSize({ width, height: 2400 });
      await page.goto('/studio');
      const pick = async (testId: string, name: string | RegExp) => {
        await page.getByTestId(testId).click();
        await page
          .getByRole('option', typeof name === 'string' ? { name, exact: true } : { name })
          .click();
      };
      await pick('req-plant', /STU-01/);
      await pick('req-mode', lang === 'ar' ? /ACI/ : 'ACI');
      await page.getByTestId('pool-chip').first().waitFor();
      await shot(page, 'studio-requirements');
      await page.getByTestId('generate').click();
      await page.getByTestId('candidate-card').first().waitFor({ timeout: 30_000 });
      await page.getByTestId('pin-1').click();
      await page.getByTestId('pin-2').click();
      await shot(page, 'studio-candidates');
      await page.getByTestId('inspect-1').click();
      await page.getByTestId('tab-gradation').click();
      await page.getByTestId('combined-chart').waitFor();
      await shot(page, 'studio-inspect-gradation');
      await page.getByTestId('stage-requirements').click();
      await pick('req-mode', /JS/);
      await page.getByTestId('blocked-panel').waitFor();
      await shot(page, 'studio-blocked');
    });
  }
}
