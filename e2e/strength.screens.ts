import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, type Page } from '@playwright/test';
import { restoreRules } from './lifecycle-world';
import { seedStrengthWorld } from './strength-world';
import { settled, start } from './support';

const outDir = join('docs', 'screens', process.env['MILESTONE'] ?? 'M5.2');
mkdirSync(outDir, { recursive: true });
let versions: string[] = [];
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(240_000);
  ({ versions } = await seedStrengthWorld('STR-SCR-1'));
});
test.afterAll(async () => {
  await restoreRules();
});

for (const lang of ['en', 'ar'] as const) {
  for (const width of [1440, 1024, 390] as const) {
    const tag = `${lang}-${width}`;
    const shot = async (page: Page, name: string) => {
      await settled(page);
      await page.screenshot({ path: join(outDir, `${name}-${tag}.png`), fullPage: true });
    };
    test(`strength models, evidence, sign dialog, adequacy ${tag}`, async ({ page }) => {
      test.setTimeout(90_000);
      await start(page, { role: 'qc_manager', lang, width });
      await page.setViewportSize({ width, height: 2600 });
      await page.goto('/library');
      await page.getByTestId('strength-tab-trigger').click();
      await page.getByTestId('refit').click();
      const card = page.locator('[data-testid="model-card"]').first();
      await card.waitFor();
      await shot(page, 'strength-list');
      await card.getByTestId('model-details').click();
      await card.getByTestId('model-chart').waitFor();
      await shot(page, 'strength-evidence');
      await card.getByTestId('model-approve').click();
      await page.getByTestId('model-sign-dialog').waitFor();
      await page.waitForTimeout(600);
      await shot(page, 'strength-sign');
      await page.getByTestId('model-reason').fill('SYNTHETIC screenshot approval');
      await page.getByTestId('model-sign-submit').click();
      await page.getByTestId('model-sign-dialog').waitFor({ state: 'detached' });
      await page.goto(`/library?design=${versions[1]}`);
      const sheet = page.getByTestId('design-sheet');
      await sheet.getByTestId('tab-evaluation').click();
      await sheet.getByTestId('evaluate-run').click();
      await sheet.getByTestId('adequacy-block').waitFor();
      await shot(page, 'design-adequacy-model');
      // leave no model in force for other specs
      await page.goto('/library');
      await page.getByTestId('strength-tab-trigger').click();
      await page.getByTestId('model-retire').first().click();
      await page.getByTestId('model-reason').fill('SYNTHETIC screenshot cleanup');
      await page.getByTestId('model-sign-submit').click();
      await page.getByTestId('model-sign-dialog').waitFor({ state: 'detached' });
    });
  }
}
