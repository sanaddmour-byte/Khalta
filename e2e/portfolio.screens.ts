import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, type Page } from '@playwright/test';
import { settled, start } from './support';

const outDir = join('docs', 'screens', process.env['MILESTONE'] ?? 'M2.2');
mkdirSync(outDir, { recursive: true });
const HEAD =
  'design_code,plant_code,design_name,fc_mpa,strength_basis,test_age_days,exposure_classes,slump_mm,nmas_mm,pumpable,material_name,material_category,quantity,unit,approval_reference,currently_in_production,avg_monthly_volume_m3';
const file = (code: string, exposure: string) => {
  const r = (n: string, c: string, q: string) =>
    `${code},AMM-01,Portfolio screenshot,30,cylinder,28,${exposure},100,19,true,${n},${c},${q},kg/m3,Submittal 2025-31,true,1800`;
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
    test(`portfolio, quality, editor, compliance table, savings ${tag}`, async ({ page }) => {
      await start(page, { role: 'qc_manager', lang, width });
      await page.setViewportSize({ width, height: 2600 });
      for (const [s, e] of [
        ['', 'F0'],
        ['-S2', 'S2'],
      ] as const) {
        const c = `PS-${lang}-${width}${s}`;
        const up = await page.request.post('/api/imports/legacy/upload?filename=ps.csv', {
          headers: { 'content-type': 'application/octet-stream' },
          data: Buffer.from(file(c, e)),
        });
        const { batchId } = await up.json();
        await page.request.post(`/api/imports/legacy/${batchId}/commit`, {
          data: { decisions: { [`water|ماء ${c}`]: { create: true } } },
        });
      }
      await page.goto('/library');
      await page.getByTestId('portfolio-tab').click();
      await page.getByTestId('evaluate-all').click();
      await page.getByTestId('portfolio-row').first().waitFor();
      await page.waitForTimeout(800);
      await shot(page, 'portfolio');
      await page.getByTestId('quality-tab').click();
      await page.getByTestId('dq-group').first().waitFor();
      await shot(page, 'data-quality');
      await page.getByTestId('portfolio-tab').click();
      const code = `PS-${lang}-${width}-S2`;
      await page.locator(`[data-testid="portfolio-row"][data-code="${code}"] button`).click();
      const sheet = page.getByTestId('design-sheet');
      await sheet.getByTestId('tab-evaluation').click();
      await sheet.getByTestId('checks-table').waitFor();
      await page.waitForTimeout(500);
      await shot(page, 'compliance-table');
      await sheet.getByTestId('trace-open').first().click();
      await shot(page, 'traceability');
      await page.keyboard.press('Escape');
      await sheet.getByTestId('tab-details').click();
      await sheet.getByTestId('edit-open').click();
      await page.getByTestId('preview-validator').waitFor();
      await page.waitForTimeout(500);
      await shot(page, 'editor');
      await page.keyboard.press('Escape');
      await page.goto('/savings');
      await page.getByTestId('savings-page').waitFor();
      await shot(page, 'savings');
    });
  }
}
