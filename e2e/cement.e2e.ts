import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousAxe, start } from './support';

const unique = (p: string) => `${p} ${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

async function choose(page: Page, trigger: ReturnType<Page['locator']>, option: string | RegExp) {
  await trigger.click();
  await page
    .getByRole(
      'option',
      typeof option === 'string' ? { name: option, exact: true } : { name: option },
    )
    .click();
}

test('a cement is classified by type and strength class; the market name suggests, a person confirms', async ({
  page,
}) => {
  await start(page, { role: 'qc_manager' });
  await page.goto('/materials');
  await page.getByTestId('new-material').click();
  await choose(page, page.locator('#m-cat'), 'Cement');
  const name = unique('White cement 52.5');
  await page.getByTestId('m-name-en').fill(name);

  // suggested from the name, never filled silently
  const suggestion = page.getByTestId('cement-suggestion');
  await expect(suggestion).toContainText('White 52.5');
  await expect(page.getByRole('combobox', { name: 'Cement type', exact: true })).toContainText(
    'Not set',
  );
  await suggestion.getByRole('button').click();
  await expect(page.getByRole('combobox', { name: 'Cement type', exact: true })).toContainText(
    'White',
  );
  await expect(page.getByRole('combobox', { name: 'Strength class' })).toContainText('52.5');
  await expectNoSeriousAxe(page, 'cement entry');

  await page.getByTestId('f-sg').fill('3.1');
  await page.getByTestId('declared-reason').fill('Supplier data sheet, certificate to follow');
  await page.getByTestId('entry-submit').click();
  await expect(page.getByTestId('entry-dialog')).toHaveCount(0);

  await page.goto('/materials');
  await choose(page, page.getByRole('combobox', { name: 'Category' }), 'Cement');
  const row = page.locator(`[data-testid="material-row"][data-material="${name}"]`);
  await expect(row.getByTestId('cement-label')).toContainText('White 52.5');
  await choose(page, page.getByTestId('cement-kind-filter'), 'White');
  await expect(row).toBeVisible();
  await choose(page, page.getByTestId('cement-kind-filter'), 'SRC');
  await expect(row).toHaveCount(0);
  await expectNoSeriousAxe(page, 'cement filter');
});
