import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, type Page } from '@playwright/test';
import { settled, start } from './support';

const outDir = join('docs', 'screens', process.env['MILESTONE'] ?? 'M1.3');
mkdirSync(outDir, { recursive: true });
const HEAD =
  'design_code,plant_code,design_name,fc_mpa,strength_basis,test_age_days,exposure_classes,slump_mm,nmas_mm,pumpable,material_name,material_category,quantity,unit,approval_reference,currently_in_production,avg_monthly_volume_m3';
const r = (n: string, c: string, q: string, u = 'kg/m3') =>
  `SHOT-1,AMM-01,Screenshot design,30,cylinder,28,F0;S0;W0;C1,125,19,true,${n},${c},${q},${u},Submittal 2025-14,true,2400`;
const FILE = [
  HEAD,
  r('إسمنت (تجريبي)', 'cement', '360'),
  r('ماء الخلط', 'water', '175'),
  r('رمل مغسول (تجريبي)', 'fine_agg', '820'),
  r('عدسية 20', 'coarse_agg', '1000'),
].join('\n');

for (const lang of ['en', 'ar'] as const) {
  for (const width of [1440, 1024, 390] as const) {
    const tag = `${lang}-${width}`;
    const shot = async (page: Page, name: string) => {
      await settled(page);
      await page.screenshot({ path: join(outDir, `${name}-${tag}.png`), fullPage: true });
    };
    test(`import wizard ${tag}`, async ({ page }) => {
      await start(page, { role: 'qc_manager', lang, width });
      await page.goto('/imports');
      await page
        .getByTestId('legacy-file')
        .setInputFiles({ name: 'legacy.csv', mimeType: 'text/csv', buffer: Buffer.from(FILE) });
      await page.getByTestId('review').waitFor();
      await shot(page, 'import-wizard');
    });
    test(`library ${tag}`, async ({ page }) => {
      await start(page, { role: 'qc_manager', lang, width });
      await page.goto('/library');
      await page.getByTestId('library-search').waitFor();
      await shot(page, 'library');
    });
    test(`design detail ${tag}`, async ({ page }) => {
      await start(page, { role: 'qc_manager', lang, width });
      // make sure a design exists in this fresh database (the importer is idempotent per code)
      const up = await page.request.post('/api/imports/legacy/upload?filename=shot.csv', {
        headers: { 'content-type': 'application/octet-stream' },
        data: Buffer.from(FILE.replace(/SHOT-1/g, `SHOT-${lang}-${width}`)),
      });
      const { batchId } = await up.json();
      await page.request.post(`/api/imports/legacy/${batchId}/commit`, {
        data: {
          decisions: {
            'water|ماء الخلط': { create: true },
            'coarse_agg|عدسية 20': { create: true },
          },
        },
      });
      await page.goto('/library');
      await page.getByTestId('design-row').first().getByRole('button').click();
      await page.getByTestId('design-sheet').waitFor();
      await shot(page, 'design-detail');
    });
  }
}
