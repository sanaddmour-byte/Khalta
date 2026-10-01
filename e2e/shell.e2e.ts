import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('shell renders and has no serious accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Khalta');
  await expect(page.getByTestId('app-shell')).toBeAttached();

  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious).toEqual([]);
});
