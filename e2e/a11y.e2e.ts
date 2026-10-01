import { test } from '@playwright/test';
import { expectNoSeriousAxe, settled, start } from './support';

const COMBOS = [
  { lang: 'en', theme: 'light' },
  { lang: 'en', theme: 'dark' },
  { lang: 'ar', theme: 'light' },
  { lang: 'ar', theme: 'dark' },
] as const;

for (const c of COMBOS) {
  const label = `${c.lang}/${c.theme}`;
  test(`shell has no serious axe violations (${label})`, async ({ page }) => {
    await start(page, { role: 'qc_manager', ...c });
    await page.goto('/');
    await settled(page);
    await expectNoSeriousAxe(page, `shell ${label}`);
  });

  test(`sign-in has no serious axe violations (${label})`, async ({ page }) => {
    await start(page, c);
    await page.goto('/login');
    await settled(page);
    await expectNoSeriousAxe(page, `login ${label}`);
  });

  test(`component gallery has no serious axe violations (${label})`, async ({ page }) => {
    await start(page, c);
    await page.goto('/dev/components');
    await settled(page);
    await expectNoSeriousAxe(page, `gallery ${label}`);
  });
}

test('open overlays have no serious axe violations (palette, user menu, dialog)', async ({
  page,
}) => {
  await start(page, { role: 'admin', lang: 'ar', theme: 'dark' });
  await page.goto('/');
  await page.keyboard.press('Control+k');
  await settled(page);
  await expectNoSeriousAxe(page, 'palette');
  await page.keyboard.press('Escape');
  await page.getByTestId('user-menu').click();
  await expectNoSeriousAxe(page, 'user menu');
  await page.keyboard.press('Escape');
  await page.goto('/dev/components');
  await page
    .locator('[data-panel=rtl]')
    .getByRole('button')
    .filter({ hasText: 'فتح نافذة' })
    .first()
    .click();
  await expectNoSeriousAxe(page, 'dialog');
});
