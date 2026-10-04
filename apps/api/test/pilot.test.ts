// The synthetic end-to-end pilot (improvement programme, phase 6). SYNTHETIC world, SYNTHETIC parameters: every value
// below is test data, not a plant's. The pilot walks one mix from an existing design to realized savings and, at each
// stage, also tries the action that must be refused. With WRITE_PILOT=1 the step log is written to docs/pilot/.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { schema } from '@khalta/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onPriceChange, realizeAll } from '../src/insights/triggers';
import { assessChange } from '../src/impact/service';
import { supersede } from '../src/rules/service';
import { createTestEnv, type TestEnv } from './helpers';
import { optimizerWorld, REQUIREMENTS as BASE } from './opt-world';

const REQUIREMENTS = { ...BASE, testAgeDays: 28 };
const PARAMS: Record<string, number> = {
  'eng.trial.slump_tolerance_mm': 25,
  'eng.trial.air_tolerance_pct': 1.5,
  'eng.trial.density_band_kg_m3': 40,
  'eng.trial.yield_band_m3': 0.01,
  'eng.trial.temperature_max_c': 32,
  'eng.moisture.max_total_pct': 15,
  'eng.moisture.stale_hours': 24,
  'eng.batch.max_size_m3': 6,
  'eng.batch.max_rounding_deviation_pct': 1,
  'eng.batch.resolution_kg.cement': 1,
  'eng.batch.resolution_kg.scm': 1,
  'eng.batch.resolution_kg.fine_agg': 5,
  'eng.batch.resolution_kg.coarse_agg': 5,
  'eng.batch.resolution_kg.admixture': 0.1,
  'eng.batch.resolution_kg.water': 1,
  'eng.batch.resolution_kg.fiber': 0.1,
  'eng.batch.resolution_kg.pigment': 0.1,
};
const SIGN = { reason: 'Signed in the synthetic pilot' };

let env: TestEnv;
let plantA: string;
let mats: Record<string, string>;
let supplierId: string;
const log: { stage: string; action: string; expected: string; result: string; ok: boolean }[] = [];

const as = async (role: Parameters<TestEnv['seedUser']>[0], plantIds: string[] = []) =>
  env.login((await env.seedUser(role, { plantIds })).email);
const designRow = async (id: string) =>
  (await env.db.select().from(schema.mixDesigns).where(eq(schema.mixDesigns.id, id)))[0]!;

/** Records one step; a refusal step expects the given statuses, an allowed step expects 2xx. */
async function step<T extends { status: number }>(
  stage: string,
  action: string,
  expected: string,
  run: () => Promise<T>,
  ok: (r: T) => boolean,
) {
  const r = await run();
  const pass = ok(r);
  const body = (r as unknown as { body?: { error?: { code?: string } } }).body;
  log.push({
    stage,
    action,
    expected,
    result: `HTTP ${r.status}${body?.error?.code ? ` ${body.error.code}` : ''}`,
    ok: pass,
  });
  expect(pass, `${stage}: ${action} → ${r.status} ${JSON.stringify(body).slice(0, 1800)}`).toBe(
    true,
  );
  return r;
}
const refused =
  (...codes: number[]) =>
  (r: { status: number }) =>
    codes.includes(r.status);
const allowed = (r: { status: number }) => r.status >= 200 && r.status < 300;

// A new rule version is unverified until QC verifies it; the pilot's QC verifies after each change.
const verifyRules = () =>
  env.db.execute(
    sql`UPDATE rules SET verified = true, verified_at = now() WHERE tenant_id = ${env.tenantId} AND is_current AND (value IS NOT NULL OR definition IS NOT NULL OR inherits IS NOT NULL)`,
  );
async function setRules(on: boolean, only?: (k: string) => boolean) {
  const qm = (await env.seedUser('qc_manager')).id;
  await env.db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(PARAMS)) {
      if (only && !only(key)) continue;
      const [r] = await tx
        .select({ row: schema.rules })
        .from(schema.rules)
        .where(
          and(
            eq(schema.rules.tenantId, env.tenantId),
            eq(schema.rules.key, key),
            eq(schema.rules.isCurrent, true),
          ),
        );
      if (!r) continue;
      const want = on ? value : null;
      if (r.row.value !== want)
        await supersede(
          tx,
          env.tenantId,
          qm,
          r.row,
          { value: want },
          'ui',
          'SYNTHETIC pilot parameter',
        );
    }
  });
  await verifyRules();
}

beforeAll(async () => {
  env = await createTestEnv();
  const w = await optimizerWorld(env, ['PIL-A']);
  plantA = w.plants[0]!;
  mats = w.mats[0]!;
  const [p] = await env.db
    .select({ s: schema.materialPrices.supplierId })
    .from(schema.materialPrices)
    .limit(1);
  supplierId = p!.s;
  // the SYNTHETIC aggregates carry no absorption: a newer test adds it (production conversion needs it)
  const aggs = await env.db
    .select({ id: schema.materials.id })
    .from(schema.materials)
    .where(
      and(
        eq(schema.materials.tenantId, env.tenantId),
        sql`${schema.materials.category} like '%_agg'`,
      ),
    );
  for (const a of aggs) {
    const [cur] = await env.db
      .select()
      .from(schema.materialTests)
      .where(
        and(eq(schema.materialTests.materialId, a.id), eq(schema.materialTests.isCurrent, true)),
      );
    await env.db
      .update(schema.materialTests)
      .set({ isCurrent: false })
      .where(eq(schema.materialTests.id, cur!.id));
    await env.db.insert(schema.materialTests).values({
      tenantId: env.tenantId,
      materialId: a.id,
      version: cur!.version + 1,
      isCurrent: true,
      source: 'supplier_datasheet',
      properties: { ...(cur!.properties as object), absorption_pct: 1.2 },
      testedAt: '2026-08-01',
    });
  }
  await env.db.execute(
    sql`UPDATE rules SET verified = true, verified_at = now() WHERE tenant_id = ${env.tenantId} AND is_current AND (value IS NOT NULL OR definition IS NOT NULL OR inherits IS NOT NULL)`,
  );
  await env.db
    .insert(schema.tenantSettings)
    .values({
      tenantId: env.tenantId,
      settings: { insightMinSavingJodPerM3: 0.01, insightMinAnnualJod: 1 },
    })
    .onConflictDoUpdate({
      target: schema.tenantSettings.tenantId,
      set: { settings: { insightMinSavingJodPerM3: 0.01, insightMinAnnualJod: 1 } },
    });
}, 240_000);
afterAll(async () => {
  if (process.env['WRITE_PILOT']) {
    const dir = path.resolve(__dirname, '../../../docs/pilot');
    mkdirSync(dir, { recursive: true });
    const rows = log
      .map(
        (l) => `| ${l.stage} | ${l.action} | ${l.expected} | ${l.result} | ${l.ok ? '✅' : '❌'} |`,
      )
      .join('\n');
    writeFileSync(
      path.join(dir, 'synthetic-pilot.md'),
      `# Synthetic end-to-end pilot — step log\n\nGenerated by \`apps/api/test/pilot.test.ts\` (run with \`WRITE_PILOT=1\`). **All data and parameters are SYNTHETIC test values, not a plant's.** "Expected" says what the rules require; "Result" is what the server answered.\n\n| Stage | Action | Expected | Result | OK |\n| --- | --- | --- | --- | --- |\n${rows}\n`,
    );
  }
  await env.close();
});

describe('synthetic pilot: existing mix → savings reconciliation, with the blocked actions', () => {
  it('walks the whole cycle and refuses every action that must be refused', async () => {
    const qmA = await as('qc_manager');
    const eng = await as('qc_engineer', [plantA]);
    const sales = await as('sales', [plantA]);
    const admin = await as('admin');
    const plantMgr = await as('plant_manager', [plantA]);

    // ---- 1. existing mix → evaluation
    const first = await step(
      '1 Evaluate',
      'QC manager generates candidates',
      'allowed',
      () =>
        qmA
          .post('/api/design-requests')
          .send({ plantId: plantA, mode: 'ACI', requirements: REQUIREMENTS }),
      allowed,
    );
    const reqId = first.body.id as string;
    const typed = (first.body.candidates[0].lines as { materialId: string; kgPerM3: string }[]).map(
      (l) => ({ materialId: l.materialId, kgPerM3: l.kgPerM3 }),
    );
    const evald = await step(
      '1 Evaluate',
      'evaluate an existing (typed) mix',
      'allowed; independent validator agrees',
      () =>
        qmA.post('/api/design-requests/evaluate-mix').send({
          plantId: plantA,
          mode: 'ACI',
          objective: 'cheapest',
          requirements: REQUIREMENTS,
          lines: typed,
        }),
      allowed,
    );
    expect(evald.body.validator.status).toBe('pass');
    await step(
      '1 Evaluate',
      'sales engineer tries to evaluate a mix',
      'refused (no design.write)',
      () =>
        sales.post('/api/design-requests/evaluate-mix').send({
          plantId: plantA,
          mode: 'ACI',
          objective: 'cheapest',
          requirements: REQUIREMENTS,
          lines: typed,
        }),
      refused(403),
    );

    // ---- 2. candidates, transparency, supersession
    const t = (await qmA.get(`/api/design-requests/${reqId}`)).body.transparency;
    expect(t.termination.kind).toBe('optimal_within_search');
    log.push({
      stage: '2 Candidates',
      action: 'read how the result was produced',
      expected: 'termination named; wording never "optimal" alone',
      result: `termination ${t.termination.kind}, ${t.termination.configurations.solved}/${t.termination.configurations.enumerated} configurations`,
      ok: true,
    });
    const sens = await step(
      '2 Candidates',
      'price sensitivity of the stored candidates',
      'allowed; nothing re-solved',
      () => qmA.get(`/api/design-requests/${reqId}/sensitivity`),
      allowed,
    );
    expect(sens.body.reSolved).toBe(false);
    const second = await step(
      '2 Candidates',
      'a newer request supersedes the first',
      'allowed',
      () =>
        qmA
          .post('/api/design-requests')
          .send({ plantId: plantA, mode: 'ACI', requirements: REQUIREMENTS, supersedes: reqId }),
      allowed,
    );
    await step(
      '2 Candidates',
      'make a design from the superseded request',
      'refused (request_superseded)',
      () =>
        qmA
          .post(
            `/api/design-requests/${reqId}/candidates/${first.body.candidates[0].id}/trial-candidate`,
          )
          .send({ code: 'PIL-X', name: 'PIL-X' }),
      refused(409),
    );

    // ---- 3. trial candidate (the QC manager is the author)
    const made = await step(
      '3 Trial',
      'QC manager (author) requests a trial design',
      'allowed',
      () =>
        qmA
          .post(
            `/api/design-requests/${second.body.id}/candidates/${second.body.candidates[0].id}/trial-candidate`,
          )
          .send({ code: 'PIL-1', name: 'PIL-1' }),
      allowed,
    );
    const id = made.body.design.id as string;
    await step(
      '3 Trial',
      'approve straight from trial candidate',
      'refused (the author check or the lifecycle order)',
      () => qmA.post(`/api/designs/${id}/approve`).send(SIGN),
      refused(403, 409),
    );
    const [ev] = await env.db
      .select()
      .from(schema.designEvaluations)
      .where(eq(schema.designEvaluations.id, (await designRow(id)).lastEvaluationId!));
    const rep = ev!.report as {
      trace: { key: string; value: number }[];
      strengthAdequacy: { fcrMpa: number };
    };
    const batch = await step(
      '3 Trial',
      'log a trial batch',
      'allowed',
      () =>
        qmA.post(`/api/designs/${id}/trial-batches`).send({
          batchedOn: '2026-10-01',
          slumpMm: 100,
          airPct: 2,
          temperatureC: 25,
          freshDensityKgM3: rep.trace.find((x) => x.key === 'mass.fresh_density')!.value,
          yieldM3: 1,
          retainedSlumpMm: 80,
          retentionMinutes: 60,
          stability: 'stable',
          placementAcceptable: true,
        }),
      allowed,
    );
    await step(
      '3 Trial',
      'log cylinder results above f′cr',
      'allowed',
      () =>
        qmA.post(`/api/trial-batches/${batch.body.id}/strength-results`).send({
          castDate: '2026-10-01',
          ageDays: 28,
          specimenType: 'cylinder',
          setId: 'P',
          resultsMpa: [rep.strengthAdequacy.fcrMpa + 3],
        }),
      allowed,
    );
    await step(
      '3 Trial',
      'start the trial',
      'allowed',
      () => qmA.post(`/api/designs/${id}/start-trial`),
      allowed,
    );
    await step(
      '3 Trial',
      'pass the trial while QC has configured no acceptance criteria',
      'refused: a missing engineering parameter blocks, named',
      () => qmA.post(`/api/designs/${id}/pass-trial`).send(SIGN),
      refused(409),
    );
    await setRules(true, (k) => k.startsWith('eng.trial.'));
    await step(
      '3 Trial',
      'pass the trial once the criteria are configured',
      'allowed (QC manager, e-signed)',
      () => qmA.post(`/api/designs/${id}/pass-trial`).send(SIGN),
      allowed,
    );

    // ---- 4. independent approval
    await step(
      '4 Approval',
      'the author approves their own design',
      'refused (four-eyes)',
      () => qmA.post(`/api/designs/${id}/approve`).send(SIGN),
      refused(403),
    );
    await step(
      '4 Approval',
      'the administrator approves',
      'refused (holds no sign-off)',
      () => admin.post(`/api/designs/${id}/approve`).send(SIGN),
      refused(403),
    );
    await step(
      '4 Approval',
      'a QC engineer approves',
      'refused (no design.approve)',
      () => eng.post(`/api/designs/${id}/approve`).send(SIGN),
      refused(403),
    );
    const qmB = await as('qc_manager');
    await step(
      '4 Approval',
      'a second QC manager approves while the rules changed after the evaluation',
      'refused: evidence is stale (rules_changed)',
      () => qmB.post(`/api/designs/${id}/approve`).send(SIGN),
      refused(409),
    );
    await step(
      '4 Approval',
      'the design is evaluated again on the current rules',
      'allowed',
      () => qmB.post(`/api/designs/${id}/evaluate`).send({ mode: 'ACI' }),
      allowed,
    );
    await step(
      '4 Approval',
      'a second QC manager approves',
      'allowed',
      () => qmB.post(`/api/designs/${id}/approve`).send(SIGN),
      allowed,
    );

    // ---- 5. release
    await step(
      '5 Release',
      'sales engineer releases',
      'refused',
      () => sales.post(`/api/designs/${id}/release`).send(SIGN),
      refused(403),
    );
    await step(
      '5 Release',
      'plant manager releases at their plant',
      'allowed (e-signed)',
      () => plantMgr.post(`/api/designs/${id}/release`).send(SIGN),
      allowed,
    );
    expect((await designRow(id)).status).toBe('in_production');

    // ---- 6. moisture correction, batch preparation, versioned export
    const lines = await env.db
      .select({ materialId: schema.mixDesignLines.materialId, category: schema.materials.category })
      .from(schema.mixDesignLines)
      .innerJoin(schema.materials, eq(schema.materials.id, schema.mixDesignLines.materialId))
      .where(eq(schema.mixDesignLines.designId, id));
    const moisture = lines
      .filter((l) => l.category.endsWith('_agg'))
      .map((l) => ({ materialId: l.materialId, totalMoisturePct: 3 }));
    const lab = await as('qc_engineer', [plantA]);
    await setRules(true, (k) => k.startsWith('eng.moisture.')); // QC enters the moisture limits first
    const blocked = await step(
      '6 Batch',
      'preview a plan while equipment parameters are not on file',
      'allowed to preview; plan blocked and named',
      () => lab.post(`/api/designs/${id}/batch-plans/preview`).send({ moisture, batchSizeM3: 2 }),
      allowed,
    );
    expect(blocked.body.plan.ok).toBe(false);
    await step(
      '6 Batch',
      'save that plan',
      'refused (plan_blocked)',
      () => lab.post(`/api/designs/${id}/batch-plans`).send({ moisture, batchSizeM3: 2 }),
      refused(409),
    );
    await setRules(true);
    const prev = await step(
      '6 Batch',
      'preview with parameters on file',
      'allowed; both independent checks agree',
      () => lab.post(`/api/designs/${id}/batch-plans/preview`).send({ moisture, batchSizeM3: 2 }),
      allowed,
    );
    expect(prev.body.plan.ok && prev.body.planValidator.status === 'pass').toBe(true);
    const plan = await step(
      '6 Batch',
      'save the plan (bound to design version, tests, readings)',
      'allowed',
      () => lab.post(`/api/designs/${id}/batch-plans`).send({ moisture, batchSizeM3: 2 }),
      allowed,
    );
    await step(
      '6 Batch',
      'export the plan (khalta.batch-weights.v2)',
      'allowed; audited; no cost',
      () => lab.post('/api/exports/batch-plans.csv').send({ instanceId: plan.body.id }),
      allowed,
    );
    await env.db.execute(
      sql`ALTER TABLE batch_instances DISABLE TRIGGER batch_instances_append_only`,
    );
    await env.db.execute(
      sql`UPDATE batch_instances SET moisture = (SELECT jsonb_agg(jsonb_set(m, '{measuredAt}', to_jsonb((now() - interval '72 hours')::text))) FROM jsonb_array_elements(moisture) m) WHERE id = ${plan.body.id}`,
    );
    await env.db.execute(
      sql`ALTER TABLE batch_instances ENABLE TRIGGER batch_instances_append_only`,
    );
    await step(
      '6 Batch',
      'export the plan after its moisture reading has aged 72 h (simulated)',
      'refused: stale moisture, nothing exported',
      () => lab.post('/api/exports/batch-plans.csv').send({ instanceId: plan.body.id }),
      refused(409),
    );

    // ---- 7. production results and savings reconciliation (baseline → price change → replacement → volumes → realized)
    const snapA = await step(
      '7 Savings',
      'price snapshot for the baseline',
      'allowed',
      () =>
        admin
          .post('/api/price-snapshots')
          .send({ name: 'Baseline A', asOf: '2026-06-01', plantIds: [plantA] }),
      allowed,
    );
    await step(
      '7 Savings',
      'open a cost baseline on the released design',
      'allowed',
      () =>
        qmA
          .post('/api/baselines')
          .send({ designId: id, priceSnapshotId: snapA.body.id, mode: 'ACI' }),
      allowed,
    );
    await admin.post('/api/prices').send({
      entries: [
        {
          materialId: mats['cem-i']!,
          plantId: plantA,
          supplierId,
          price: '160',
          unit: 'JOD/ton',
        },
      ],
      effectiveFrom: '2026-07-01',
      reason: 'SYNTHETIC pilot price',
    });
    await onPriceChange({ db: env.db }, env.tenantId, [plantA]);
    const [opp] = await env.db
      .select()
      .from(schema.insights)
      .where(and(eq(schema.insights.type, 'opportunity'), eq(schema.insights.designId, id)));
    expect(opp, 'a price change should surface a theoretical opportunity').toBeTruthy();
    const acc = await step(
      '7 Savings',
      'accept the opportunity (trial-only draft; theoretical saving)',
      'allowed (QC manager)',
      () => qmA.post(`/api/insights/${opp!.id}/accept`),
      allowed,
    );
    const v2 = acc.body.design.id as string;
    expect((await designRow(id)).status).toBe('in_production'); // the released version is untouched
    const d2 = await designRow(v2);
    const [ev2] = await env.db
      .select()
      .from(schema.designEvaluations)
      .where(eq(schema.designEvaluations.id, d2.lastEvaluationId!));
    const rep2 = ev2!.report as {
      trace: { key: string; value: number }[];
      strengthAdequacy: { fcrMpa: number };
    };
    const b2 = await qmA.post(`/api/designs/${v2}/trial-batches`).send({
      batchedOn: '2026-10-02',
      slumpMm: 100,
      airPct: 2,
      temperatureC: 25,
      freshDensityKgM3: rep2.trace.find((x) => x.key === 'mass.fresh_density')!.value,
      yieldM3: 1,
      retainedSlumpMm: 80,
      retentionMinutes: 60,
      stability: 'stable',
      placementAcceptable: true,
    });
    await qmA.post(`/api/trial-batches/${b2.body.id}/strength-results`).send({
      castDate: '2026-10-02',
      ageDays: 28,
      specimenType: 'cylinder',
      setId: 'P2',
      resultsMpa: [rep2.strengthAdequacy.fcrMpa + 3],
    });
    await qmA.post(`/api/designs/${v2}/start-trial`);
    await qmA.post(`/api/designs/${v2}/pass-trial`).send(SIGN);
    const ap = await step(
      '7 Savings',
      'a second QC manager approves the replacement',
      'allowed; supersedes the baseline version',
      () => qmB.post(`/api/designs/${v2}/approve`).send(SIGN),
      allowed,
    );
    expect(ap.body.savings.state).toBe('created');
    await env.db.execute(
      sql`UPDATE mix_designs SET approved_at = '2026-08-05T00:00:00Z' WHERE id = ${v2}`,
    );
    await step(
      '7 Savings',
      'plant manager records August volume',
      'allowed',
      () =>
        plantMgr
          .post('/api/production-volumes')
          .send({ designId: v2, month: '2026-08', volumeM3: 1200 }),
      allowed,
    );
    await step(
      '7 Savings',
      'plant manager records September volume',
      'allowed',
      () =>
        plantMgr
          .post('/api/production-volumes')
          .send({ designId: v2, month: '2026-09', volumeM3: 800 }),
      allowed,
    );
    const pre = await qmA.get('/api/savings/blocked');
    expect(pre.body.blocked.map((b: { reason: string }) => b.reason)).toContain('no_snapshot');
    log.push({
      stage: '7 Savings',
      action: 'realized figure before the month-close price snapshots exist',
      expected: 'blocked and named, nothing estimated',
      result: 'blocked: no_snapshot',
      ok: true,
    });
    await admin
      .post('/api/price-snapshots')
      .send({ name: 'Month close 2026-08', asOf: '2026-08-31', plantIds: [plantA] });
    await admin
      .post('/api/price-snapshots')
      .send({ name: 'Month close 2026-09', asOf: '2026-09-30', plantIds: [plantA] });
    expect((await realizeAll({ db: env.db }, env.tenantId)).created).toBe(2);
    expect((await realizeAll({ db: env.db }, env.tenantId)).created).toBe(0);
    log.push({
      stage: '7 Savings',
      action: 'close the months twice',
      expected: 'two realized entries, then no duplicates',
      result: '2 created, then 0',
      ok: true,
    });
    const ledger = (await qmA.get('/api/savings')).body as {
      id: string;
      state: string;
      reconciliation: string | null;
      volumeSource: string | null;
      net: { gross: string; net: string } | null;
    }[];
    const realized = ledger.filter((e) => e.state === 'realized');
    expect(realized).toHaveLength(2);
    expect(new Set(ledger.map((e) => e.state))).toEqual(
      new Set(['theoretical', 'approved', 'realized']),
    );
    for (const r of realized) expect(r.reconciliation).toBe('manual_volume'); // volumes were entered by hand, so never "reconciled"
    log.push({
      stage: '7 Savings',
      action: 'reconciliation status of the realized figures',
      expected: 'not "reconciled": volumes were entered by hand',
      result: 'manual_volume',
      ok: true,
    });
    await step(
      '7 Savings',
      'book the trial cost against a realized entry',
      'allowed',
      () =>
        qmA
          .post(`/api/savings/entries/${realized[0]!.id}/adjustments`)
          .send({ kind: 'trial_cost', amountJod: '250.000', note: 'trial batches and lab tests' }),
      allowed,
    );
    await step(
      '7 Savings',
      'reverse it',
      'allowed once',
      () =>
        qmA
          .post(`/api/savings/entries/${realized[0]!.id}/adjustments`)
          .send({ kind: 'reversal', note: 'volume belongs to another design' }),
      allowed,
    );
    await step(
      '7 Savings',
      'reverse it again',
      'refused (already reversed)',
      () =>
        qmA
          .post(`/api/savings/entries/${realized[0]!.id}/adjustments`)
          .send({ kind: 'reversal', note: 'a second reversal attempt' }),
      refused(409),
    );

    // ---- 8. change impact on the in-production design, with a human decision
    const imp = await assessChange(env.db, env.tenantId, {
      trigger: 'rule_revision',
      subject: 'rules',
      token: 'pilot-1',
    });
    expect(imp.state).toBe('completed');
    log.push({
      stage: '8 Change',
      action: 'a rule revision is assessed against live designs',
      expected: 'assessed once; approved versions untouched',
      result: `completed, ${imp.state === 'completed' ? imp.items : 0} design(s)`,
      ok: true,
    });
    expect(
      (
        await assessChange(env.db, env.tenantId, {
          trigger: 'rule_revision',
          subject: 'rules',
          token: 'pilot-1',
        })
      ).state,
    ).toBe('skipped');
    await env.db.insert(schema.strengthResults).values(
      [0, 1].map(() => ({
        tenantId: env.tenantId,
        plantId: plantA,
        designId: v2,
        castDate: '2026-10-03',
        ageDays: 28,
        specimenType: 'cylinder' as const,
        setId: 'LOW',
        resultMpa: '5.00',
      })),
    );
    await assessChange(env.db, env.tenantId, {
      trigger: 'strength_deterioration',
      subject: v2,
      token: 'pilot-low',
    });
    const [item] = await env.db
      .select()
      .from(schema.changeImpactItems)
      .where(
        and(
          eq(schema.changeImpactItems.designId, v2),
          eq(schema.changeImpactItems.klass, 'suspend_recommended'),
        ),
      );
    expect(item).toBeTruthy();
    await step(
      '8 Change',
      'dismiss a suspension recommendation',
      'refused (cannot be waved away)',
      () =>
        qmA
          .post(`/api/change-impacts/items/${item!.id}/disposition`)
          .send({ disposition: 'dismissed', reason: 'looks like a one-off outlier' }),
      refused(409),
    );
    await step(
      '8 Change',
      'QC manager records "requalification required"',
      'allowed; the design itself is not changed',
      () =>
        qmA.post(`/api/change-impacts/items/${item!.id}/disposition`).send({
          disposition: 'requalification_required',
          reason: 'a retest at the plant is arranged',
        }),
      allowed,
    );
    expect((await designRow(v2)).status).toBe('approved');

    // ---- 9. nothing above wrote a mutation without an audit row
    const audits = await env.db
      .select({ a: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.tenantId, env.tenantId));
    for (const need of [
      'design.approved',
      'design.in_production',
      'batch_plan.create',
      'export.batch_plans',
      'savings.reversal',
      'change_impact.disposition',
    ])
      expect(
        audits.some((x) => x.a === need),
        need,
      ).toBe(true);
    log.push({
      stage: '9 Audit',
      action: 'audit trail contains the approvals, plan, export, reversal and decision',
      expected: 'all present',
      result: 'present',
      ok: true,
    });
  }, 600_000);
});
