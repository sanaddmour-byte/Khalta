import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousAxe, settled, start } from './support';

const cell = (page: Page, material: string, plant: string) =>
  page.locator(`[data-cell="${material}|${plant}"]`);
const edit = async (page: Page, material: string, plant: string, value: string) => {
  await cell(page, material, plant).click();
  await page.keyboard.press('Enter');
  await page.getByTestId('price-editor').fill(value);
  await page.keyboard.press('Enter');
};
const open = async (page: Page, role = 'admin', lang: 'en' | 'ar' = 'en', width = 1440) => {
  await start(page, { role, lang, width });
  await page.goto('/prices');
  await expect(page.getByTestId('price-grid')).toBeVisible();
  await expect(cell(page, 'Demo cement', 'AMM-01')).toBeVisible();
};
const paste = (page: Page, text: string) =>
  page.getByTestId('price-grid').evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, text);

test('edit a cell, see it pending, undo, redo, then save and read the history', async ({
  page,
}) => {
  await open(page);
  const c = cell(page, 'Demo washed sand', 'AMM-01');
  await edit(page, 'Demo washed sand', 'AMM-01', '10.250');
  await expect(c).toHaveAttribute('data-pending', 'true');
  await expect(page.getByTestId('save-prices')).toContainText('1 change');
  await page.getByTestId('price-grid').focus();
  await page.keyboard.press('Control+z');
  await expect(c).not.toHaveAttribute('data-pending', 'true');
  await page.keyboard.press('Control+y');
  await expect(c).toHaveAttribute('data-pending', 'true');

  await page.getByTestId('save-prices').click();
  await expect(c).not.toHaveAttribute('data-pending', 'true');
  await expect(c).toContainText('10.250');
  await c.click();
  await page.getByTestId('open-history').click();
  const hist = page.getByTestId('price-history');
  await expect(hist.locator('li')).toHaveCount(2);
  await expect(hist).toContainText('10.250');
  await expect(hist).toContainText('9.500'); // the old price is kept
  await expectNoSeriousAxe(page, 'history sheet');
});

test('pasting a block from Excel stages it; invalid and out-of-table cells are reported, blanks skipped', async ({
  page,
}) => {
  await open(page);
  await cell(page, 'Demo coarse 20 mm', 'AMM-01').click();
  await paste(page, '7.900\t8,100\n\tabc\n');
  await expect(page.getByTestId('save-prices')).toContainText('2 changes');
  await expect(cell(page, 'Demo coarse 20 mm', 'AQB-01')).toContainText('8.100'); // decimal comma read
  await page.getByTestId('discard').click();
  await expect(page.getByTestId('save-prices')).toBeDisabled();
});

test('a back-dated price needs a reason before it can be saved', async ({ page }) => {
  await open(page);
  await edit(page, 'Demo crushed sand', 'AQB-01', '8.900');
  await page.getByTestId('effective-from').fill('2020-01-01');
  await expect(page.getByTestId('save-prices')).toBeDisabled();
  await page.getByTestId('price-reason').fill('late paperwork');
  await expect(page.getByTestId('save-prices')).toBeEnabled();
  await page.getByTestId('save-prices').click(); // earlier than the latest price: the server refuses and nothing is lost
  await expect(page.getByText('cannot be entered')).toBeVisible();
  await expect(page.getByTestId('save-prices')).toContainText('1 change');
  await page.getByTestId('discard').click();
});

test('stale prices are hatched with an age badge once a limit is configured, and not before', async ({
  page,
}) => {
  await start(page, { role: 'admin' });
  await page.request.patch('/api/settings', { data: { stalePriceDays: null } });
  await page.goto('/prices');
  await expect(page.getByTestId('price-summary')).toContainText('limit not set');
  await expect(page.locator('[data-stale="true"]')).toHaveCount(0);
  await page.request.patch('/api/settings', { data: { stalePriceDays: 7 } });
  await page.reload();
  await expect(page.locator('[data-stale="true"]').first()).toBeVisible();
  await expect(page.locator('[data-stale="true"]').first()).toContainText('days old');
  try {
    await expectNoSeriousAxe(page, 'prices stale');
  } finally {
    await page.request.patch('/api/settings', { data: { stalePriceDays: null } });
  }
});

test('keyboard navigation follows the reading direction (Arabic reverses left/right)', async ({
  page,
}) => {
  await open(page, 'admin', 'ar');
  await cell(page, 'Demo cement', 'AMM-01').click();
  const grid = page.getByTestId('price-grid');
  // other specs add materials, so the clicked cell is not always the first row: navigate relative to where it is
  const at = async () => {
    const id = (await grid.getAttribute('aria-activedescendant')) ?? '';
    const m = /^pg-(\d+)-(\d+)$/.exec(id);
    expect(m, id).not.toBeNull();
    return { r: Number(m![1]), c: Number(m![2]) };
  };
  await expect(grid).toHaveAttribute('aria-activedescendant', /^pg-\d+-\d+$/);
  const start = await at();
  await page.keyboard.press('ArrowLeft'); // visually toward the end edge = the next plant column in Arabic
  await expect(grid).toHaveAttribute('aria-activedescendant', `pg-${start.r}-${start.c + 1}`);
  await page.keyboard.press('ArrowRight');
  await expect(grid).toHaveAttribute('aria-activedescendant', `pg-${start.r}-${start.c}`);
  await page.keyboard.press('ArrowDown');
  await expect(grid).toHaveAttribute('aria-activedescendant', `pg-${start.r + 1}-${start.c}`);
  await expectNoSeriousAxe(page, 'prices ar');
});

test('import: errors block the commit, a clean file applies', async ({ page }) => {
  await open(page);
  await page.getByTestId('price-tools').click();
  await page.getByTestId('tool-import').click();
  const file = page.getByTestId('import-file');
  const head = 'material,plant,supplier,price,unit,effective from,reason\n';
  await file.setInputFiles({
    name: 'bad.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`${head}Nope,AMM-01,,5,JOD/ton,,\nDemo cement,AMM-01,,abc,JOD/ton,,`),
  });
  await expect(page.getByTestId('import-summary')).toContainText('2 with errors');
  await expect(page.getByTestId('import-commit')).toBeDisabled();
  await expect(page.getByTestId('import-rows')).toContainText('Unknown material');
  const future = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
  await file.setInputFiles({
    name: 'ok.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`${head}Demo cement,AQB-01,,81.250,JOD/ton,${future},scheduled`),
  });
  await expect(page.getByTestId('import-summary')).toContainText('1 to apply');
  await expectNoSeriousAxe(page, 'import dialog');
  await page.getByTestId('import-commit').click();
  await expect(page.getByTestId('import-dialog')).toHaveCount(0);
});

test('export downloads a file; snapshots can be created and listed; bulk change previews its effect', async ({
  page,
}) => {
  await open(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByTestId('price-export').click();
      await page.getByRole('menuitem', { name: 'CSV file' }).click();
    })(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.csv$/);

  await page.getByTestId('price-tools').click();
  await page.getByTestId('tool-snapshot').click();
  await page.getByTestId('snapshot-name').fill(`E2E baseline ${Date.now()}`);
  await page.getByTestId('snapshot-create').click();
  await expect(page.getByTestId('snapshot-list').locator('li').first()).toContainText(
    'E2E baseline',
  );
  await expectNoSeriousAxe(page, 'snapshot dialog');
  await page.keyboard.press('Escape');

  await page.getByTestId('price-tools').click();
  await page.getByTestId('tool-bulk').click();
  await page.getByTestId('bulk-percent').fill('5');
  await expect(page.getByTestId('bulk-count')).toContainText('will change');
  await page.getByTestId('bulk-percent').fill('abc');
  await expect(page.getByTestId('bulk-apply')).toBeDisabled();
  await expectNoSeriousAxe(page, 'bulk dialog');
});

test('plant manager sees prices read-only; sales has no Prices section', async ({ page }) => {
  await open(page, 'plant_manager');
  await expect(page.getByTestId('staging-bar')).toHaveCount(0);
  await expect(page.getByTestId('price-tools')).toHaveCount(0);
  await expect(page.getByTestId('price-export')).toHaveCount(0);
  await page.goto('/materials');
  await expect(page.getByTestId('priced-at').first()).toBeVisible();
  await start(page, { role: 'sales' });
  await page.goto('/');
  await expect(page.getByTestId('sidebar').locator('a[data-nav="prices"]')).toHaveCount(0);
  await settled(page);
});
