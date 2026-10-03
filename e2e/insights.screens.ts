import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, type Page } from '@playwright/test';
import { liveDesign, restoreRules, seedInsight, seedLifecycleWorld } from './lifecycle-world';
import { settled, start } from './support';

const outDir = join('docs', 'screens', process.env['MILESTONE'] ?? 'M5.1');
mkdirSync(outDir, { recursive: true });
let plantId = '';
let designId = '';
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(180_000);
  plantId = await seedLifecycleWorld();
  designId = await liveDesign('INS-SCR-1');
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
    test(`insights inbox, savings board, volumes, suspend ${tag}`, async ({ page }) => {
      // SYNTHETIC fixtures
      await seedInsight(plantId, {
        type: 'opportunity',
        severity: 'medium',
        designId,
        key: `scr-opp-${tag}`,
        payload: { designCode: 'INS-SCR-1', request: {}, candidate: {} },
        savingJodPerM3: '1.250',
        annualJod: '15000.000',
      });
      await seedInsight(plantId, {
        type: 'low_strength',
        severity: 'critical',
        designId,
        key: `scr-low-${tag}`,
        payload: { designCode: 'INS-SCR-1', averageMpa: 31.2, requiredFcrMpa: 38.5 },
      });
      await seedInsight(plantId, {
        type: 'test_drift',
        severity: 'high',
        key: `scr-drift-${tag}`,
        payload: { materialName: 'SYNTHETIC cement', drift: [{}], affectedDesigns: 2 },
      });
      await start(page, { role: 'qc_manager', lang, width });
      await page.setViewportSize({ width, height: 2400 });
      await page.goto('/insights');
      await page.getByTestId('insight-card').first().waitFor();
      await shot(page, 'insights-inbox');
      await page.getByTestId('insight-dismiss').first().click();
      await page.getByTestId('dismiss-dialog').waitFor();
      await shot(page, 'insights-dismiss');
      await page.keyboard.press('Escape');
      await page.goto('/savings');
      await page.getByTestId('savings-page').waitFor();
      await shot(page, 'savings-board');
      await page.goto(`/library?design=${designId}`);
      await page.getByTestId('volumes-section').waitFor();
      await shot(page, 'design-volumes');
      await page.getByTestId('do-suspend').click();
      await page.getByTestId('sign-dialog').waitFor();
      await shot(page, 'suspend-sign');
      // leave no open alert behind for other specs
      const open = (await (await page.request.get('/api/insights')).json()) as { id: string }[];
      for (const i of open)
        await page.request.post(`/api/insights/${i.id}/dismiss`, {
          data: { reason: 'screenshot run cleanup' },
        });
    });
  }
}
