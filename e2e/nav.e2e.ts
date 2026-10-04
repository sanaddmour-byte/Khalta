import { expect, test } from '@playwright/test';
import { start } from './support';

// Hand-written from 01-domain.md §10 and the nav mapping; deliberately not computed from the code under test.
const EXPECTED: Record<string, string[]> = {
  admin: [
    'dashboard',
    'studio',
    'library',
    'profiles',
    'insights',
    'savings',
    'materials',
    'prices',
    'plants',
    'rules',
    'imports',
    'settings',
  ],
  qc_manager: [
    'dashboard',
    'studio',
    'library',
    'profiles',
    'insights',
    'savings',
    'materials',
    'prices',
    'rules',
    'imports',
  ],
  qc_engineer: [
    'dashboard',
    'studio',
    'library',
    'profiles',
    'insights',
    'savings',
    'materials',
    'prices',
    'rules',
  ],
  procurement: ['dashboard', 'library', 'savings', 'materials', 'prices'],
  plant_manager: ['dashboard', 'library', 'savings', 'materials', 'prices'],
  sales: ['dashboard', 'library'],
  viewer: ['dashboard', 'library'],
};

for (const [role, expected] of Object.entries(EXPECTED)) {
  test(`navigation for ${role} shows exactly the permitted sections`, async ({ page }) => {
    await start(page, { role });
    await page.goto('/');
    const nav = page.getByTestId('sidebar').getByTestId('main-nav');
    await expect(nav).toBeVisible();
    const ids = await nav
      .locator('a[data-nav]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-nav')));
    expect(ids).toEqual(expected);
  });
}

test('every visible section opens and is marked current', async ({ page }) => {
  await start(page, { role: 'admin' });
  await page.goto('/');
  for (const id of EXPECTED['admin']!) {
    await page.getByTestId('sidebar').locator(`a[data-nav="${id}"]`).click();
    await expect(page.getByTestId('sidebar').locator(`a[data-nav="${id}"]`)).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
});

test('a section hidden from the role is explained, not rendered, on direct access', async ({
  page,
}) => {
  await start(page, { role: 'sales' });
  await page.goto('/prices');
  await expect(page.getByText('Not available for your role')).toBeVisible();
  await expect(page.getByTestId('sidebar').locator('a[data-nav="prices"]')).toHaveCount(0);
});

test("plant switcher is scoped to the user's plants", async ({ page }) => {
  await start(page, { role: 'plant_manager' }); // seeded with AMM-01 only
  await page.goto('/');
  const sw = page.getByTestId('plant-switcher');
  await expect(sw).toContainText('AMM-01');
  await sw.click();
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Escape');

  await start(page, { role: 'admin' }); // unscoped: "all plants" + each plant (other specs may add plants)
  const count = async () =>
    ((await (await page.request.get('/api/plants')).json()) as unknown[]).length;
  const before = await count();
  await page.goto('/');
  await page.getByTestId('plant-switcher').click();
  const shown = await page.getByRole('option').count();
  const after = await count(); // a parallel spec may add a plant while the page loads
  expect(shown).toBeGreaterThanOrEqual(before + 1);
  expect(shown).toBeLessThanOrEqual(after + 1);
});
