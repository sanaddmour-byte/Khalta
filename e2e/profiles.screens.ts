import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, type Page } from '@playwright/test';
import { settled, start } from './support';
import { seedProfiles, SYN_PROFILES } from './studio-world';

const outDir = join('docs', 'screens', process.env['MILESTONE'] ?? 'M3.3');
mkdirSync(outDir, { recursive: true });
test.beforeAll(async () => {
  test.setTimeout(180_000);
  await seedProfiles();
});

for (const lang of ['en', 'ar'] as const) {
  for (const width of [1440, 1024, 390] as const) {
    const tag = `${lang}-${width}`;
    const shot = async (page: Page, name: string) => {
      await settled(page);
      await page.screenshot({ path: join(outDir, `${name}-${tag}.png`), fullPage: true });
    };
    test(`profiles: list, detail, studio picker ${tag}`, async ({ page }) => {
      await start(page, { role: 'qc_manager', lang, width });
      await page.setViewportSize({ width, height: 1800 });
      await page.goto('/profiles');
      await page.getByTestId('profile-row').first().waitFor();
      await shot(page, 'profiles-list');
      await page
        .getByTestId('profile-row')
        .filter({ hasText: lang === 'ar' ? 'C30' : SYN_PROFILES.family })
        .getByRole('button')
        .click();
      await page.getByTestId('profile-sheet').waitFor();
      await shot(page, 'profiles-detail');
      await page.keyboard.press('Escape');
      await page.goto('/studio');
      await page.getByTestId('req-plant').click();
      await page.getByRole('option', { name: /STU-01/ }).click();
      await page.getByTestId('profiles-apply-suggested').click();
      await page.getByTestId('char-origin-sand_ratio_pct').waitFor();
      await shot(page, 'studio-profile');
    });
  }
}
