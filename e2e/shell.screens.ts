import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@playwright/test';

const milestone = process.env['MILESTONE'] ?? 'M0.1';
const outDir = join('docs', 'screens', milestone);
const widths = [1440, 1024, 390] as const;
// The language toggle arrives in M0.3; until then both language runs capture the same page.
const languages = ['en', 'ar'] as const;

mkdirSync(outDir, { recursive: true });

for (const lang of languages) {
  for (const width of widths) {
    test(`shell ${lang} ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/?lang=${lang}`);
      await page.screenshot({ path: join(outDir, `shell-${lang}-${width}.png`), fullPage: true });
    });
  }
}
