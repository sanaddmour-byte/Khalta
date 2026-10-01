import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@playwright/test';
import { settled, start } from './support';

const milestone = process.env['MILESTONE'] ?? 'M0.3';
const outDir = join('docs', 'screens', milestone);
const WIDTHS = [1440, 1024, 390] as const;
const LANGS = ['en', 'ar'] as const;
mkdirSync(outDir, { recursive: true });

for (const lang of LANGS) {
  for (const width of WIDTHS) {
    const tag = `${lang}-${width}`;
    test(`sign-in ${tag}`, async ({ page }) => {
      await start(page, { lang, width });
      await page.goto('/login');
      await settled(page);
      await page.screenshot({ path: join(outDir, `login-${tag}.png`), fullPage: true });
    });
    test(`shell dashboard ${tag}`, async ({ page }) => {
      await start(page, { role: 'qc_manager', lang, width });
      await page.goto('/');
      await settled(page);
      await page.screenshot({ path: join(outDir, `shell-${tag}.png`), fullPage: true });
    });
    test(`section placeholder ${tag}`, async ({ page }) => {
      await start(page, { role: 'admin', lang, width });
      await page.goto('/materials');
      await settled(page);
      await page.screenshot({ path: join(outDir, `section-materials-${tag}.png`), fullPage: true });
    });
    test(`component gallery ${tag}`, async ({ page }) => {
      await start(page, { lang, width });
      await page.goto('/dev/components');
      await settled(page);
      await page.screenshot({ path: join(outDir, `components-${tag}.png`), fullPage: true });
    });
  }

  test(`dark shell and gallery ${lang}`, async ({ page }) => {
    await start(page, { role: 'qc_manager', lang, theme: 'dark', width: 1440 });
    await page.goto('/');
    await settled(page);
    await page.screenshot({ path: join(outDir, `shell-${lang}-1440-dark.png`), fullPage: true });
    await page.goto('/dev/components');
    await settled(page);
    await page.screenshot({
      path: join(outDir, `components-${lang}-1440-dark.png`),
      fullPage: true,
    });
  });

  test(`open states ${lang}`, async ({ page }) => {
    await start(page, { role: 'admin', lang, width: 1440 });
    await page.goto('/');
    await settled(page);
    await page.getByTestId('user-menu').click();
    await page.waitForTimeout(250); // let the open animation finish
    await page.screenshot({ path: join(outDir, `user-menu-${lang}.png`) });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(outDir, `palette-${lang}.png`) });
  });

  test(`mobile drawer ${lang}`, async ({ page }) => {
    await start(page, { role: 'qc_manager', lang, width: 390 });
    await page.goto('/');
    await settled(page);
    await page.getByTestId('nav-open').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, `drawer-${lang}-390.png`) });
  });
}
