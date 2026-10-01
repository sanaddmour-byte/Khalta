import { expect, test, type Page } from '@playwright/test';
import { settled, start } from './support';

const box = async (page: Page, sel: string) => {
  const b = await page.locator(sel).first().boundingBox();
  expect(b, sel).not.toBeNull();
  return b!;
};

test('language toggle flips lang/dir, mirrors the layout and remembers the choice', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager', lang: 'en' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  const ltrSidebar = await box(page, '[data-testid=sidebar]');
  const ltrMain = await box(page, '#main');
  expect(ltrSidebar.x).toBeLessThan(ltrMain.x); // sidebar at the start (left)

  await page.getByTestId('lang-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  const rtlSidebar = await box(page, '[data-testid=sidebar]');
  const rtlMain = await box(page, '#main');
  expect(rtlSidebar.x).toBeGreaterThan(rtlMain.x); // sidebar at the start (right)
  await expect(page.locator('a[data-nav=prices]')).toHaveText('الأسعار');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl'); // persisted
  await page.getByTestId('lang-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});

for (const lang of ['en', 'ar'] as const) {
  test(`menus open at the end edge in ${lang}`, async ({ page }) => {
    await start(page, { role: 'qc_manager', lang });
    await page.goto('/');
    const trigger = page.getByTestId('user-menu');
    const t = (await trigger.boundingBox())!;
    await trigger.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await page.waitForTimeout(250); // let the open animation settle (flaky under load otherwise)
    const m = (await menu.boundingBox())!;
    // end-aligned: the menu's end edge lines up with the trigger's end edge
    if (lang === 'en') expect(Math.abs(m.x + m.width - (t.x + t.width))).toBeLessThan(3);
    else expect(Math.abs(m.x - t.x)).toBeLessThan(3);
    await page.keyboard.press('Escape');
  });
}

for (const lang of ['en', 'ar'] as const) {
  test(`command palette opens with Ctrl+K and finds sections in either language (${lang})`, async ({
    page,
  }) => {
    await start(page, { role: 'qc_manager', lang });
    await page.goto('/');
    await expect(page.getByTestId('topbar')).toBeVisible();
    await page.keyboard.press('Control+k');
    const input = page.locator('[cmdk-input]');
    await expect(input).toBeVisible();
    await input.fill(lang === 'en' ? 'الأسعار' : 'prices'); // the other language
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/prices$/);
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Escape');
    await expect(page.locator('[cmdk-input]')).toHaveCount(0);
  });
}

test('plants are reachable from the palette ("prices AQB-01" style search)', async ({ page }) => {
  await start(page, { role: 'admin' });
  await page.goto('/');
  await expect(page.getByTestId('topbar')).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.locator('[cmdk-input]').fill('AQB-01');
  await page.getByRole('option').first().click();
  await expect(page.getByTestId('plant-switcher')).toContainText('AQB-01');
});

test('theme toggle changes tokens and survives reload', async ({ page }) => {
  await start(page, { role: 'qc_manager', theme: 'light' });
  await page.goto('/');
  const bg = () =>
    page.evaluate(() => getComputedStyle(document.body.parentElement!).backgroundColor);
  const light = await bg();
  await page.getByTestId('theme-toggle').click(); // light -> dark
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await bg()).not.toBe(light);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

for (const lang of ['en', 'ar'] as const) {
  test(`mobile: navigation is a drawer that slides in from the start edge (${lang})`, async ({
    page,
  }) => {
    await start(page, { role: 'qc_manager', lang, width: 390 });
    await page.goto('/');
    await expect(page.getByTestId('sidebar')).toBeHidden();
    await page.getByTestId('nav-open').click();
    const nav = page.getByRole('dialog').getByTestId('main-nav');
    await expect(nav).toBeVisible();
    await page.waitForTimeout(250); // let the slide animation finish
    const d = (await page.getByRole('dialog').boundingBox())!;
    if (lang === 'en') expect(d.x).toBeLessThan(2);
    else expect(Math.abs(d.x + d.width - 390)).toBeLessThan(2);
    await nav.locator('a[data-nav=library]').click();
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}

test('Western digits by default in Arabic (no Arabic-Indic digits on screen)', async ({ page }) => {
  await start(page, { lang: 'ar' });
  await page.goto('/dev/components');
  await settled(page);
  const text = await page.locator('[data-panel=rtl]').innerText();
  expect(text).toMatch(/360/);
  expect(text).not.toMatch(/[٠-٩]/);
});

test('dev gallery isolates codes and units in the RTL panel', async ({ page }) => {
  await start(page, { lang: 'en' });
  await page.goto('/dev/components');
  await expect(page.locator('[data-panel=rtl]')).toBeVisible(); // the gallery chunk is lazy: wait for it
  const tokens = page.locator('[data-panel=rtl] bdi[dir=ltr]');
  await expect.poll(() => tokens.count()).toBeGreaterThan(5);
  await expect(page.locator('[data-panel=rtl] bdi', { hasText: 'C30/37' })).toBeVisible();
});
