import { expect, test } from '@playwright/test';
import { expectNoSeriousAxe, settled, start } from './support';

// Hand-written expectations: which cards each role sees on its dashboard.
const CARDS: Record<string, string[]> = {
  qc_manager: ['awaitingApproval', 'needsRevalidation', 'criticalAlerts', 'changeImpacts'],
  procurement: ['priceAlerts'],
  sales: ['approvedDesigns'],
  admin: ['failedJobs', 'users'],
};

for (const [role, expected] of Object.entries(CARDS)) {
  test(`dashboard for ${role} shows its own cards and links to the screen behind each`, async ({
    page,
  }) => {
    await start(page, { role: role as never, lang: 'en', theme: 'light' });
    await page.goto('/');
    await expect(page.getByTestId('dashboard')).toBeVisible();
    const ids = await page
      .getByTestId('dash-card')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-card')));
    for (const id of expected) expect(ids).toContain(id);
    if (role === 'admin') expect(ids).not.toContain('awaitingApproval');
    // a card is a real link
    const first = page.getByTestId('dash-card').first();
    await expect(first).toHaveAttribute('href', /\//);
  });
}

test('the Arabic dashboard is right-to-left, translated and accessible (dark)', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager', lang: 'ar', theme: 'dark' });
  await page.goto('/');
  await settled(page);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('dashboard')).toContainText('بانتظار الاعتماد');
  await expectNoSeriousAxe(page, 'dashboard ar');
});

test('the dashboard works on a phone without horizontal scrolling', async ({ page }) => {
  await start(page, { role: 'plant_manager', lang: 'en', theme: 'light', width: 390 });
  await page.goto('/');
  await expect(page.getByTestId('dashboard')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

// Mobile operational flows: the screens a person at the plant opens on a phone must not need sideways scrolling of the page.
for (const path of ['/insights', '/library', '/materials']) {
  test(`phone width: ${path} has no horizontal page scroll and the primary navigation is reachable`, async ({
    page,
  }) => {
    await start(page, { role: 'plant_manager', lang: 'ar', theme: 'light', width: 390 });
    await page.goto(path);
    await settled(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByTestId('nav-open')).toBeVisible();
  });
}
