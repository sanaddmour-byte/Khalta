// A guided tour: one English screenshot of every page of the app (and its main states), at 1440 px, with a caption each.
// SYNTHETIC data only (the e2e worlds). Output: docs/screens/tour/NN-name.png and docs/screens/tour/README.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  as,
  liveDesign,
  restoreRules,
  seedInsight,
  seedMoistureWorld,
  trialCandidate,
  withDb,
} from './lifecycle-world';
import { seedProfiles } from './studio-world';
import { seedStrengthWorld } from './strength-world';
import { emailFor, settled, start } from './support';

const outDir = join('docs', 'screens', 'tour');
mkdirSync(outDir, { recursive: true });
const shots: { file: string; title: string; text: string }[] = [];
let n = 0;

const HEAD =
  'design_code,plant_code,design_name,fc_mpa,strength_basis,test_age_days,exposure_classes,slump_mm,nmas_mm,pumpable,material_name,material_category,quantity,unit,approval_reference,currently_in_production,avg_monthly_volume_m3';
const csv = (code: string) => {
  const row = (name: string, cat: string, q: string) =>
    `${code},AMM-01,Imported ${code},30,cylinder,28,F0;S0,100,19,true,${name},${cat},${q},kg/m3,Submittal ${code},true,1500`;
  return [
    HEAD,
    row('إسمنت (تجريبي)', 'cement', '360'),
    row(`ماء ${code}`, 'water', '175'),
    row('رمل مغسول (تجريبي)', 'fine_agg', '820'),
    row('Demo coarse 20 mm', 'coarse_agg', '1000'),
  ].join('\n');
};

test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await restoreRules();
  const md = [
    '# Khalta app tour (English)',
    '',
    'One screenshot per page and main state, taken at 1440 px with SYNTHETIC data. Numbers, names and prices are made up; the screens show how the app works, not real plant values.',
    '',
    ...shots.flatMap((s) => [`## ${s.title}`, '', `![${s.title}](${s.file})`, '', s.text, '']),
  ].join('\n');
  writeFileSync(join(outDir, 'README.md'), md);
  writeFileSync(join(outDir, 'captions.json'), JSON.stringify(shots, null, 2));
});

async function shot(page: Page, name: string, title: string, text: string, full = true) {
  await settled(page);
  await page.waitForTimeout(400);
  const file = `${String(++n).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: join(outDir, file), fullPage: full });
  shots.push({ file, title, text });
}

test('the tour', async ({ page }) => {
  test.setTimeout(900_000);
  await seedMoistureWorld();
  await seedProfiles().catch(() => {});
  const live = await liveDesign('TOUR-APPROVED');
  await trialCandidate('TOUR-TRIAL');
  const { versions } = await seedStrengthWorld('TOUR-MODEL');

  // legacy designs in different states (imported, evaluated; one attested later through the UI is not needed)
  await start(page, { role: 'qc_manager', width: 1440 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const code of ['TOUR-LEGACY-1', 'TOUR-LEGACY-2']) {
    const up = await page.request.post('/api/imports/legacy/upload?filename=tour.csv', {
      headers: { 'content-type': 'application/octet-stream' },
      data: Buffer.from(csv(code)),
    });
    const { batchId } = await up.json();
    await page.request.post(`/api/imports/legacy/${batchId}/commit`, {
      data: { decisions: { [`water|ماء ${code}`]: { create: true } } },
    });
  }
  // a batch instance, a production volume, a price snapshot and a cost baseline on the approved design
  const mgr = await as(emailFor('qc_manager'));
  const aggs = await withDb(
    async (c) =>
      (
        await c.query(
          `SELECT l.material_id AS id FROM mix_design_lines l JOIN materials m ON m.id = l.material_id WHERE l.design_id = $1 AND m.category LIKE '%!_agg' ESCAPE '!'`,
          [live],
        )
      ).rows as { id: string }[],
  );
  await mgr.post(`/api/designs/${live}/batch-instances`, {
    data: { moisture: aggs.map((a) => ({ materialId: a.id, totalMoisturePct: 2.5 })) },
  });
  const prev = new Date();
  prev.setMonth(prev.getMonth() - 1);
  await mgr.post('/api/production-volumes', {
    data: { designId: live, month: prev.toISOString().slice(0, 7), volumeM3: 1850 },
  });
  const admin = await as(emailFor('admin'));
  const plantId = await withDb(
    async (c) =>
      (await c.query(`SELECT plant_id AS id FROM mix_designs WHERE id = $1`, [live])).rows[0]
        .id as string,
  );
  const snap = await admin.post('/api/price-snapshots', {
    data: {
      name: 'Tour baseline',
      asOf: new Date().toISOString().slice(0, 10),
      plantIds: [plantId],
    },
  });
  if (snap.ok())
    await mgr.post('/api/baselines', {
      data: {
        designId: live,
        priceSnapshotId: ((await snap.json()) as { id: string }).id,
        mode: 'ACI',
      },
    });
  await seedInsight(plantId, {
    type: 'opportunity',
    severity: 'medium',
    designId: live,
    key: 'tour-opp',
    payload: { designCode: 'TOUR-APPROVED', designVersion: 1, request: {}, candidate: {} },
    savingJodPerM3: '1.250',
    annualJod: '15000.000',
  });
  await seedInsight(plantId, {
    type: 'test_drift',
    severity: 'high',
    key: 'tour-drift',
    payload: { materialName: 'SYNTHETIC cement', drift: [{ field: 'sg' }], affectedDesigns: 2 },
  });
  await seedInsight(plantId, {
    type: 'low_strength',
    severity: 'critical',
    designId: live,
    key: 'tour-low',
    payload: { designCode: 'TOUR-APPROVED', averageMpa: 31.2, requiredFcrMpa: 38.5 },
  });
  await seedInsight(plantId, {
    type: 'prices_stale',
    severity: 'info',
    key: 'tour-stale',
    payload: { stale: [{}, {}, {}] },
  });

  // ------------------------------------------------------------------ signed out
  const ctx = page.context();
  await ctx.clearCookies();
  await page.goto('/login');
  await shot(
    page,
    'sign-in',
    'Sign in',
    'Every user signs in with an email and password. There is no self-registration: an admin creates accounts.',
    false,
  );
  await start(page, { role: 'qc_manager', width: 1440 });

  // ------------------------------------------------------------------ the sidebar pages as a QC manager
  await page.goto('/');
  await shot(
    page,
    'dashboard',
    'Dashboard',
    'The home screen. The sidebar lists only what your role may use; the top bar has the plant switcher, search/command palette, language, theme and your account.',
  );

  await page.goto('/studio');
  await page.getByTestId('req-plant').click();
  await page.getByRole('option', { name: /STU-01/ }).click();
  await page.getByTestId('req-mode').click();
  await page.getByRole('option', { name: 'ACI', exact: true }).click();
  await page.getByTestId('pool-chip').first().waitFor();
  await shot(
    page,
    'studio-requirements',
    'Design Studio: requirements',
    'Stage 1 of 4. Choose a plant and code (ACI, JS or both), the strength, slump and exposure, and what the optimizer may use. Candidates are trial proposals, never approved mixes.',
  );
  await page.getByTestId('generate').click();
  await page.getByTestId('candidate-card').first().waitFor({ timeout: 40_000 });
  await shot(
    page,
    'studio-candidates',
    'Design Studio: candidates',
    'Stage 2. Ranked trial candidates with cost per m³, the evidence behind each and what governs it. Pin two to compare.',
  );
  await page.getByTestId('inspect-1').click();
  await page
    .getByTestId('tab-gradation')
    .click()
    .catch(() => {});
  await shot(
    page,
    'studio-inspect',
    'Design Studio: inspect and validate',
    "Stage 3. Every figure with its trace, the combined grading, and the independent validator's verdict. From here you request a trial, which saves the design as TRIAL CANDIDATE.",
  );

  await page.goto('/library');
  await page.getByTestId('design-row').first().waitFor();
  await shot(
    page,
    'library',
    'Mix Library',
    'All designs with their lifecycle state (draft, evaluated, trial, approved, in production, suspended, retired). Tabs below filter by what needs attention. Admin-only actions are hidden for roles that cannot use them.',
  );

  await page
    .getByTestId('design-row')
    .filter({ hasText: 'TOUR-APPROVED' })
    .getByRole('button')
    .first()
    .click();
  await page.getByTestId('design-sheet').waitFor();
  await shot(
    page,
    'design-details',
    'A design: details',
    'The design sheet: proportions, the author and approval, lifecycle actions (suspend, release, retire), trial batches and strength results, batch weights (with the independent check), production volumes and the PDF submittal.',
    false,
  );
  await page.getByTestId('tab-evaluation').click();
  await page.getByTestId('evaluate-run').click();
  await page.getByTestId('adequacy-block').waitFor({ timeout: 30_000 });
  await shot(
    page,
    'design-evaluation',
    'A design: evaluation',
    'Compliance checks with clause references and evidence chips, the f′cr derivation, strength adequacy, cost per m³, data quality, and the validator result. Nothing here approves a design.',
  );

  await page.goto('/library');
  for (const [tab, name, title, text] of [
    [
      'portfolio-tab',
      'library-portfolio',
      'Library: portfolio',
      'Every design at a glance: verdict counts, filters, evaluate all, and export of the portfolio (prices and costs, logged).',
    ],
    [
      'quality-tab',
      'library-quality',
      'Library: data quality',
      'What is blocking or weakening designs: missing tests, stale prices, unverified rules, grouped by cause.',
    ],
    [
      'strength-tab-trigger',
      'library-strength',
      'Library: strength models',
      'Plant strength models fitted from your own results: proposals with their evidence, approved by a QC manager with an e-signature. Also the proposals for s and β.',
    ],
    [
      'trial-tab',
      'library-trial',
      'Library: in trial',
      'Designs at TRIAL CANDIDATE or TRIAL IN PROGRESS.',
    ],
    [
      'awaiting-tab',
      'library-awaiting',
      'Library: awaiting approval',
      'Designs whose trial passed. A different QC manager than the author approves them (four-eyes).',
    ],
  ] as const) {
    await page
      .getByTestId(tab)
      .click()
      .catch(() => {});
    await page.waitForTimeout(300);
    if (tab === 'strength-tab-trigger') {
      await page
        .getByTestId('refit')
        .click()
        .catch(() => {});
      await page
        .getByTestId('model-card')
        .first()
        .waitFor({ timeout: 15_000 })
        .catch(() => {});
    }
    await shot(page, name, title, text);
  }

  await page.goto(`/library?design=${versions[1]}`);
  await page.getByTestId('design-sheet').waitFor();

  await page.goto('/profiles');
  await shot(
    page,
    'profiles',
    'Profiles',
    'Characteristic profiles: reusable sets of your own preferences (sand ratio, minimum binder, admixture choices, material preferences) that tighten, and never loosen, code limits. Versioned and approved by a QC manager.',
  );

  await page.goto('/insights');
  await page.getByTestId('insight-card').first().waitFor();
  await shot(
    page,
    'insights',
    'Insights',
    'The proactive inbox: cost opportunities (theoretical, trial-only), expired tests, stale prices, drift, rule changes and strength alerts. Accept creates a trial draft; snooze and dismiss need no code change. Critical alerts also show a banner at the top.',
  );

  await page.goto('/savings');
  await page.getByTestId('savings-page').waitFor();
  await shot(
    page,
    'savings',
    'Savings',
    'Cost baselines at a named price snapshot, then savings in three separate states: theoretical, approved and realized. They are never added together. Months that cannot be measured yet are listed with the reason.',
  );

  await page.goto('/materials');
  await page.getByTestId('material-row').first().waitFor();
  await shot(
    page,
    'materials',
    'Materials',
    'Every material with its current test and price freshness. Tests are versioned; a new test never overwrites an old one.',
  );
  await page
    .getByTestId('material-row')
    .first()
    .getByRole('button')
    .first()
    .click()
    .catch(() => {});
  await page.waitForTimeout(600);
  await shot(
    page,
    'material-sheet',
    'A material: tests and history',
    'The latest test values with their source (lab report, supplier datasheet, or declared by a user), the grading chart and the version history.',
    false,
  );

  await page.goto('/prices');
  await page.getByTestId('price-grid').waitFor();
  await shot(
    page,
    'prices',
    'Prices',
    'The price matrix: materials by plant, edited like a spreadsheet and saved with a reason. Tools: bulk change, copy between plants, import, snapshots and export.',
  );

  await restoreRules(); // the Rules screen shows unverified rules, as a real database starts
  await page.goto('/rules');
  await page
    .getByTestId('rules-banner')
    .waitFor()
    .catch(() => {});
  await shot(
    page,
    'rules',
    'Rules',
    'Every code value (ACI 318, ACI 211.1, JS) and engineering parameter, with its clause, class and verification state. Unverified rules make results provisional until a QC manager checks them against the licensed document.',
  );
  const firstRule = page.locator('[data-testid^="rule-open-"]').first();
  if (await firstRule.count()) {
    await firstRule.click();
    await page.waitForTimeout(600);
    await shot(
      page,
      'rule-sheet',
      'A rule',
      'One rule: value or table, applicability, source clause, version history and the verify action with a signed note.',
      false,
    );
  }

  await page.goto('/imports');
  await shot(
    page,
    'imports',
    'Imports',
    'Bring in legacy mix designs (a CSV or Excel file) or JS rule values. You map columns, confirm material matches (Arabic names first) and see a validation preview before anything is created. Imported designs are legacy and need attestation.',
  );

  // ------------------------------------------------------------------ admin-only pages
  await ctx.clearCookies();
  await start(page, { role: 'admin', width: 1440 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/plants');
  await page.getByTestId('plants-table').waitFor();
  await shot(
    page,
    'plants',
    'Plants',
    'Create and edit plants (Arabic and English names, code). Users are assigned to plants; most roles only see their own.',
  );
  await page.goto('/settings');
  await shot(
    page,
    'settings',
    'Settings: general',
    'Organisation settings: number format, whether sales may see cost, stale-price and near-limit thresholds, production and letterhead settings, insight thresholds.',
  );
  await page.getByRole('tab').nth(1).click();
  await page.waitForTimeout(500);
  await shot(
    page,
    'settings-users',
    'Settings: users',
    'Create users, set their role and plants, deactivate them. Every change is audited.',
  );
  expect(n).toBeGreaterThan(15);
});
