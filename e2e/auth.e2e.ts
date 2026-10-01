import { expect, test } from '@playwright/test';
import { emailFor, expectNoSeriousAxe, PASSWORD, settled, start } from './support';

test('unauthenticated users are redirected to the sign-in page', async ({ page }) => {
  await start(page);
  await page.goto('/prices');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('wrong password shows an error, correct password reaches the shell, sign-out returns', async ({
  page,
}) => {
  await start(page);
  await page.goto('/login');
  await page.getByLabel('Email').fill(emailFor('qc_manager'));
  await page.getByLabel('Password').fill('not-the-password-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('login-error')).toHaveText('Email or password is incorrect.');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('main-nav')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  await page.getByTestId('user-menu').click();
  await page.getByTestId('sign-out').click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/library');
  await expect(page).toHaveURL(/\/login$/); // the session is really gone
});

test('the sign-in page is Arabic-ready and accessible', async ({ page }) => {
  await start(page, { lang: 'ar' });
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'تسجيل الدخول' })).toBeVisible();
  await settled(page);
  await expectNoSeriousAxe(page, 'login ar');
});
