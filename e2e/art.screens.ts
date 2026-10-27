import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, type Page } from '@playwright/test';
import { settled, start } from './support';

const outDir = join('docs', 'screens', process.env['MILESTONE'] ?? 'art');
mkdirSync(outDir, { recursive: true });

for (const lang of ['en', 'ar'] as const) {
  for (const width of [1440, 390] as const) {
    const tag = `${lang}-${width}`;
    const shot = async (page: Page, name: string) => {
      await settled(page);
      await page.screenshot({ path: join(outDir, `${name}-${tag}.png`), fullPage: true });
    };
    test(`sign-in ${tag}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((l) => localStorage.setItem('khalta.lang', l), lang);
      await page.goto('/login');
      await page.getByRole('button').first().waitFor();
      await shot(page, 'sign-in');
    });
    for (const [name, path] of [
      ['dashboard', '/'],
      ['materials', '/materials'],
      ['library', '/library'],
    ] as const) {
      test(`${name} ${tag}`, async ({ page }) => {
        await start(page, { role: 'qc_manager', lang, width });
        await page.goto(path);
        await shot(page, name);
      });
    }
  }
}
