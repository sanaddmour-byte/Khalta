import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, type Page } from '@playwright/test';
import { settled, start } from './support';

const outDir = join('docs', 'screens', process.env['MILESTONE'] ?? 'M2.1');
mkdirSync(outDir, { recursive: true });
const HEAD =
  'design_code,plant_code,design_name,fc_mpa,strength_basis,test_age_days,exposure_classes,slump_mm,nmas_mm,pumpable,material_name,material_category,quantity,unit,approval_reference,currently_in_production,avg_monthly_volume_m3';
const file = (code: string, exposure: string) => {
  const r = (n: string, c: string, q: string) =>
    `${code},AMM-01,Evaluation screenshot,30,cylinder,28,${exposure},100,19,true,${n},${c},${q},kg/m3,Submittal 2025-21,true,1800`;
  return [
    HEAD,
    r('إسمنت (تجريبي)', 'cement', '360'),
    r(`ماء ${code}`, 'water', '175'),
    r('رمل مغسول (تجريبي)', 'fine_agg', '820'),
    r('Demo coarse 20 mm', 'coarse_agg', '1000'),
  ].join('\n');
};

for (const lang of ['en', 'ar'] as const) {
  for (const width of [1440, 1024, 390] as const) {
    const tag = `${lang}-${width}`;
    const shot = async (page: Page, name: string) => {
      await settled(page);
      await page.screenshot({ path: join(outDir, `${name}-${tag}.png`), fullPage: true });
    };
    test(`evaluation ${tag}`, async ({ page }) => {
      await start(page, { role: 'qc_manager', lang, width });
      // the design sheet scrolls inside the viewport: make it tall enough to capture the whole report
      await page.setViewportSize({ width, height: 2600 });
      const code = `EVS-${lang}-${width}`;
      for (const [suffix, exposure] of [
        ['', 'F0;S0;W0;C1'],
        ['-S2', 'S2'],
      ] as const) {
        const c = `${code}${suffix}`;
        const up = await page.request.post('/api/imports/legacy/upload?filename=eval.csv', {
          headers: { 'content-type': 'application/octet-stream' },
          data: Buffer.from(file(c, exposure)),
        });
        const { batchId } = await up.json();
        await page.request.post(`/api/imports/legacy/${batchId}/commit`, {
          data: { decisions: { [`water|ماء ${c}`]: { create: true } } },
        });
      }
      for (const [suffix, name] of [
        ['', 'evaluation-pass'],
        ['-S2', 'evaluation-fail'],
      ] as const) {
        await page.goto('/library');
        await page.getByTestId('library-search').fill(`${code}${suffix}`);
        await page.locator(`[data-code="${code}${suffix}"]`).getByRole('button').click();
        const sheet = page.getByTestId('design-sheet');
        await sheet.getByTestId('tab-evaluation').click();
        await sheet.getByTestId('evaluate-run').click();
        await sheet.getByTestId('evaluation-verdict').waitFor();
        await page.waitForTimeout(500);
        await shot(page, name);
        await page.keyboard.press('Escape');
      }
    });
  }
}
