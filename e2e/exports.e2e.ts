import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { as, liveDesign, restoreRules, seedMoistureWorld, withDb } from './lifecycle-world';
import { expectNoSeriousAxe, settled, start, emailFor } from './support';

test.describe.configure({ mode: 'serial' });
let designId = '';
const CODE = 'EXP-E2E-1';

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await seedMoistureWorld();
  designId = await liveDesign(CODE);
  // SYNTHETIC production batch weights for the live design (moisture 2.5 % on every aggregate)
  const aggs = await withDb(async (c) => {
    const { rows } = await c.query(
      `SELECT l.material_id AS id FROM mix_design_lines l JOIN materials m ON m.id = l.material_id
       WHERE l.design_id = $1 AND m.category LIKE '%!_agg' ESCAPE '!'`,
      [designId],
    );
    return rows as { id: string }[];
  });
  const mgr = await as(emailFor('qc_manager'));
  const res = await mgr.post(`/api/designs/${designId}/batch-instances`, {
    data: { moisture: aggs.map((a) => ({ materialId: a.id, totalMoisturePct: 2.5 })) },
  });
  expect(res.ok(), await res.text()).toBe(true);
});
test.afterAll(async () => {
  await restoreRules();
});

test('the designs CSV downloads with the contract header, only approved designs, no cost, and a hash in the name', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  await page.goto('/library');
  await expect(page.getByTestId('export-note')).toBeVisible();
  await expectNoSeriousAxe(page, 'library with export');
  const dl = page.waitForEvent('download');
  await page.getByTestId('export-designs-csv').click();
  const d = await dl;
  expect(d.suggestedFilename()).toMatch(/^khalta-designs-all-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.csv$/);
  const text = readFileSync((await d.path())!, 'utf8');
  expect(text.startsWith('﻿design_code,plant_code,design_name,fc_mpa')).toBe(true);
  expect(text).toContain(CODE);
  expect(text).toContain('khalta.designs.v1');
  expect(text).not.toMatch(/jod|price|cost|margin|saving/i);
});

test('a saved production batch downloads as batch-weights CSV from the design sheet', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  await page.goto(`/library?design=${designId}`);
  const sheet = page.getByTestId('design-sheet');
  await expect(sheet.getByTestId('batch-history')).toBeVisible();
  const dl = page.waitForEvent('download');
  await sheet.getByTestId('export-batch').first().click();
  const d = await dl;
  expect(d.suggestedFilename()).toMatch(
    /^khalta-batch-[0-9a-f]{8}-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.csv$/,
  );
  const text = readFileSync((await d.path())!, 'utf8');
  expect(text).toContain('khalta.batch-weights.v1');
  expect(text).toContain(',pass,');
  expect(text).not.toMatch(/jod|price|cost|margin|saving/i);
  await settled(page);
  await expectNoSeriousAxe(page, 'batch export');
});

test('roles without the export capability see no export controls', async ({ page }) => {
  await start(page, { role: 'viewer' });
  await page.goto('/library');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByTestId('export-designs-csv')).toHaveCount(0);
  await expect(page.getByTestId('export-note')).toHaveCount(0);
});

test('the export control in Arabic is right-to-left and accessible', async ({ page }) => {
  await start(page, { role: 'qc_manager', lang: 'ar' });
  await page.goto('/library');
  await expect(page.getByTestId('export-designs-csv')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await settled(page);
  await expectNoSeriousAxe(page, 'library export ar');
});
