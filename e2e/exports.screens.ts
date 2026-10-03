import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, type Page } from '@playwright/test';
import { as, liveDesign, restoreRules, seedMoistureWorld, withDb } from './lifecycle-world';
import { emailFor, settled, start } from './support';

const outDir = join('docs', 'screens', process.env['MILESTONE'] ?? 'M6.1');
mkdirSync(outDir, { recursive: true });
let designId = '';
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(240_000);
  await seedMoistureWorld();
  designId = await liveDesign('EXP-SCR-1');
  const aggs = await withDb(async (c) => {
    const { rows } = await c.query(
      `SELECT l.material_id AS id FROM mix_design_lines l JOIN materials m ON m.id = l.material_id
       WHERE l.design_id = $1 AND m.category LIKE '%!_agg' ESCAPE '!'`,
      [designId],
    );
    return rows as { id: string }[];
  });
  const mgr = await as(emailFor('qc_manager'));
  await mgr.post(`/api/designs/${designId}/batch-instances`, {
    data: { moisture: aggs.map((a) => ({ materialId: a.id, totalMoisturePct: 2.5 })) },
  });
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
    test(`library export and batch-weights download ${tag}`, async ({ page }) => {
      await start(page, { role: 'qc_manager', lang, width });
      await page.setViewportSize({ width, height: 2000 });
      await page.goto('/library');
      await page.getByTestId('export-note').waitFor();
      await shot(page, 'library-export');
      await page.goto(`/library?design=${designId}`);
      await page.getByTestId('batch-history').waitFor();
      await page.getByTestId('batch-history').scrollIntoViewIfNeeded();
      await shot(page, 'batch-export');
    });
  }
}
