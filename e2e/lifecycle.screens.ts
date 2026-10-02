import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, type Page } from '@playwright/test';
import {
  advanceToTrialPassed,
  SECOND_MANAGER,
  seedLifecycleWorld,
  trialCandidate,
} from './lifecycle-world';
import { PASSWORD, settled, start } from './support';

const outDir = join('docs', 'screens', process.env['MILESTONE'] ?? 'M4.1');
mkdirSync(outDir, { recursive: true });
test.beforeAll(async () => {
  test.setTimeout(180_000);
  await seedLifecycleWorld();
});

for (const lang of ['en', 'ar'] as const) {
  for (const width of [1440, 1024, 390] as const) {
    const tag = `${lang}-${width}`;
    const shot = async (page: Page, name: string) => {
      await settled(page);
      await page.screenshot({ path: join(outDir, `${name}-${tag}.png`), fullPage: true });
    };
    test(`lifecycle: awaiting approval, gates, sign dialog ${tag}`, async ({ page }) => {
      const code = `LCY-SCR-${lang}-${width}`;
      const id = await trialCandidate(code);
      await advanceToTrialPassed(id);
      await start(page, { lang, width });
      await page.setViewportSize({ width, height: 2400 });
      const res = await page.request.post('/api/auth/sign-in/email', {
        data: { email: SECOND_MANAGER, password: PASSWORD },
      });
      if (!res.ok()) throw new Error('sign in failed');
      await page.goto('/library');
      await page.getByTestId('awaiting-tab').click();
      await page.getByTestId('design-row').filter({ hasText: code }).waitFor();
      await shot(page, 'library-awaiting');
      await page
        .getByTestId('design-row')
        .filter({ hasText: code })
        .getByRole('button')
        .first()
        .click();
      await page.getByTestId('gate-rules_verified').waitFor();
      await shot(page, 'lifecycle-gates');
      await page
        .getByTestId('accept-declared')
        .waitFor({ timeout: 1000 })
        .catch(() => {});
      await page.getByTestId('do-retire').click();
      await page.getByTestId('sign-dialog').waitFor();
      await shot(page, 'lifecycle-sign');
    });
  }
}
