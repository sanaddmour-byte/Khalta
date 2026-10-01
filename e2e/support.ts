import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'dev-password-change-me';
export const emailFor = (role: string) => `${role.replace('_', '.')}@khalta.test`;

/** Sign in through the real API (cookie lands in the page's context) and preset preferences. */
export async function start(
  page: Page,
  opts: { role?: string; lang?: 'en' | 'ar'; theme?: 'light' | 'dark'; width?: number } = {},
) {
  const { role, lang = 'en', theme = 'light', width = 1440 } = opts;
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(
    ([l, t]) => {
      // Only seed defaults: a test that toggles a preference must see it survive a reload.
      const ls = window.localStorage;
      if (ls.getItem('khalta.lang') === null) ls.setItem('khalta.lang', l!);
      if (ls.getItem('khalta.theme') === null) ls.setItem('khalta.theme', t!);
    },
    [lang, theme],
  );
  if (role) {
    const res = await page.request.post('/api/auth/sign-in/email', {
      data: { email: emailFor(role), password: PASSWORD },
    });
    expect(res.ok(), `sign in as ${role}`).toBe(true);
  }
}

export async function settled(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

export async function expectNoSeriousAxe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map(
      (v) =>
        `${v.id}: ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(' '))
          .join(' | ')}`,
    ),
    `axe (${label})`,
  ).toEqual([]);
}
