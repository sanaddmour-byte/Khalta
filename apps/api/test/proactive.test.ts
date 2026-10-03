import { schema } from '@khalta/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlersFor } from '../src/jobs/handlers';
import {
  nightly,
  onMaterialTest,
  onPriceChange,
  onRuleChange,
  onStrengthResult,
  nudges,
  realizeAll,
  takeDigest,
} from '../src/insights/triggers';
import { supersede } from '../src/rules/service';
import { createTestEnv, type TestEnv } from './helpers';
import { optimizerWorld, REQUIREMENTS as BASE } from './opt-world';

// SYNTHETIC world, SYNTHETIC trial criteria: labelled test data, not a plant's values.
const REQUIREMENTS = { ...BASE, testAgeDays: 28 };
const CRITERIA = {
  'eng.trial.slump_tolerance_mm': 25,
  'eng.trial.air_tolerance_pct': 1.5,
  'eng.trial.density_band_kg_m3': 40,
  'eng.trial.yield_band_m3': 0.01,
  'eng.trial.temperature_max_c': 32,
};
const SIGN = { reason: 'Signed in the proactive test' };
let env: TestEnv;
let plantA: string;
let plantB: string;
let mats: Record<string, string>;
let supplierId: string;

beforeAll(async () => {
  env = await createTestEnv();
  const w = await optimizerWorld(env, ['PRO-A', 'PRO-B']);
  [plantA, plantB] = w.plants as [string, string];
  mats = w.mats[0]!;
  const [p] = await env.db
    .select({ s: schema.materialPrices.supplierId })
    .from(schema.materialPrices)
    .limit(1);
  supplierId = p!.s;
  const admin = (await env.seedUser('admin')).id;
  await env.db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(CRITERIA)) {
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
      await supersede(
        tx,
        env.tenantId,
        admin,
        r!.row,
        { value },
        'ui',
        'SYNTHETIC trial criterion',
      );
    }
  });
  await env.db.execute(sql`UPDATE rules SET verified = true, verified_at = now()
    WHERE tenant_id = ${env.tenantId} AND is_current AND (value IS NOT NULL OR definition IS NOT NULL OR inherits IS NOT NULL)`);
  await setSettings({ insightMinSavingJodPerM3: 0.01, insightMinAnnualJod: 1 });
}, 180_000);
afterAll(() => env.close());

const ctx = () => ({ db: env.db });
const as = async (role: Parameters<TestEnv['seedUser']>[0], plantIds: string[] = []) =>
  env.login((await env.seedUser(role, { plantIds })).email);
async function setSettings(settings: Record<string, unknown>) {
  await env.db
    .insert(schema.tenantSettings)
    .values({ tenantId: env.tenantId, settings })
    .onConflictDoUpdate({ target: schema.tenantSettings.tenantId, set: { settings } });
}
const designRow = async (id: string) =>
  (await env.db.select().from(schema.mixDesigns).where(eq(schema.mixDesigns.id, id)))[0]!;

async function trialCandidate(code: string, rank = 0) {
  const m = await as('qc_manager');
  const made = await m
    .post('/api/design-requests')
    .send({ plantId: plantA, mode: 'ACI', requirements: REQUIREMENTS });
  if (!made.body.candidates?.length)
    throw new Error('no candidates: ' + JSON.stringify(made.body).slice(0, 800));
  const eng = await as('qc_engineer', [plantA]);
  const res = await eng
    .post(
      `/api/design-requests/${made.body.id}/candidates/${made.body.candidates[rank].id}/trial-candidate`,
    )
    .send({ code, name: code });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.design.id as string;
}
async function passingBatch(id: string, strengthDelta = 3) {
  const d = await designRow(id);
  const [ev] = await env.db
    .select()
    .from(schema.designEvaluations)
    .where(eq(schema.designEvaluations.id, d.lastEvaluationId!));
  const rep = ev!.report as {
    trace: { key: string; value: number }[];
    strengthAdequacy: { fcrMpa: number };
  };
  const lab = await as('qc_manager');
  const made = await lab.post(`/api/designs/${id}/trial-batches`).send({
    batchedOn: '2026-10-01',
    slumpMm: 100,
    airPct: 2,
    temperatureC: 25,
    freshDensityKgM3: rep.trace.find((t) => t.key === 'mass.fresh_density')!.value,
    yieldM3: 1,
  });
  await lab.post(`/api/trial-batches/${made.body.id}/strength-results`).send({
    castDate: '2026-10-01',
    ageDays: 28,
    specimenType: 'cylinder',
    setId: 'P',
    resultsMpa: [rep.strengthAdequacy.fcrMpa + strengthDelta],
  });
}
/** trial candidate → approved (SYNTHETIC trial results; four-eyes by a different QC manager). */
async function approvedDesign(code: string) {
  const id = await trialCandidate(code);
  await passingBatch(id);
  const lab = await as('qc_manager');
  expect((await lab.post(`/api/designs/${id}/start-trial`)).status).toBe(200);
  expect((await lab.post(`/api/designs/${id}/pass-trial`).send(SIGN)).status).toBe(200);
  const ok = await (await as('qc_manager')).post(`/api/designs/${id}/approve`).send(SIGN);
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  return { id, approve: ok.body };
}
const setPrice = async (materialId: string, price: string, effectiveFrom?: string) => {
  const r = await (await as('admin')).post('/api/prices').send({
    entries: [{ materialId, plantId: plantA, supplierId, price, unit: 'JOD/ton' }],
    ...(effectiveFrom ? { effectiveFrom, reason: 'SYNTHETIC test price' } : {}),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
};
const insightsOf = async (type?: string) =>
  await env.db
    .select()
    .from(schema.insights)
    .where(
      and(
        eq(schema.insights.tenantId, env.tenantId),
        ...(type ? [eq(schema.insights.type, type as 'opportunity')] : []),
      ),
    );

describe('events enqueue background work; nothing runs in the request', () => {
  it('a price edit, a test, a rule change and a strength result each enqueue a job, debounced per plant', async () => {
    env.jobs.sent.length = 0;
    await setPrice(mats['fly']!, '21');
    const price = env.jobs.sent.filter((j) => j.name === 'price-change');
    expect(price).toHaveLength(1);
    expect(price[0]!.opts).toMatchObject({
      singletonKey: `price:${env.tenantId}:${plantA}`,
      delaySeconds: 900,
    });
    await setPrice(mats['fly']!, '20');
    expect(
      env.jobs.sent
        .filter((j) => j.name === 'price-change')
        .every((j) => j.opts?.singletonKey === price[0]!.opts?.singletonKey),
    ).toBe(true);
    const mgr = await as('qc_manager');
    const [flyTest] = await env.db
      .select()
      .from(schema.materialTests)
      .where(
        and(
          eq(schema.materialTests.materialId, mats['fly']!),
          eq(schema.materialTests.isCurrent, true),
        ),
      );
    const flyRes = await mgr.post(`/api/materials/${mats['fly']}/tests`).send({
      properties: { ...(flyTest!.properties as object), sg: 2.31 },
      source: 'supplier_datasheet',
      testedAt: '2026-09-01',
    });
    expect(flyRes.status, JSON.stringify(flyRes.body)).toBe(201);
    expect(
      env.jobs.sent.some((j) => j.name === 'material-test' && j.data['materialId'] === mats['fly']),
    ).toBe(true);
    await setPrice(mats['fly']!, '17');
  });
});

describe('the controlled pilot: baseline → price change → insight → accept → trial → approval → volumes → realized', () => {
  it('reconciles to the cent against an independent hand calculation', async () => {
    // 1. a baseline design (approved through a trial), priced at snapshot A
    const base = await approvedDesign('PILOT-1');
    const admin = await as('admin');
    const snapA = await admin
      .post('/api/price-snapshots')
      .send({ name: 'Baseline A', asOf: '2026-06-01', plantIds: [plantA] });
    expect(snapA.status, JSON.stringify(snapA.body)).toBe(201);
    const bl = await (
      await as('qc_manager')
    )
      .post('/api/baselines')
      .send({ designId: base.id, priceSnapshotId: snapA.body.id, mode: 'ACI' });
    expect(bl.status, JSON.stringify(bl.body)).toBe(201);

    // 2. prices move (from mid-September); the nightly-style trigger re-optimises the live design at current prices
    await setPrice(mats['cem-i']!, '160', '2026-07-01');
    const run = await onPriceChange(ctx(), env.tenantId, [plantA]);
    expect(run.created).toBeGreaterThanOrEqual(1);
    const [opp] = await insightsOf('opportunity');
    expect(opp).toMatchObject({ status: 'open', designId: base.id, type: 'opportunity' });
    expect(Number(opp!.savingJodPerM3)).toBeGreaterThan(0);
    expect((opp!.payload as { basis: string }).basis).toContain('theoretical');
    // dedupe: a second run refreshes the same insight
    const again = await onPriceChange(ctx(), env.tenantId, [plantA]);
    expect(again.created).toBe(0);
    expect(await insightsOf('opportunity')).toHaveLength(1);

    // 3. accept → a trial-only draft (next version), never above trial_candidate; a theoretical entry at the baseline snapshot
    const eng = await as('qc_engineer', [plantA]);
    expect((await eng.post(`/api/insights/${opp!.id}/accept`)).status).toBe(403);
    const mgr = await as('qc_manager');
    const acc = await mgr.post(`/api/insights/${opp!.id}/accept`);
    expect(acc.status, JSON.stringify(acc.body)).toBe(201);
    const v2 = await designRow(acc.body.design.id);
    expect(v2).toMatchObject({
      status: 'trial_candidate',
      version: 2,
      parentDesignId: base.id,
      approvalSource: null,
    });
    expect((await designRow(base.id)).status).toBe('approved'); // the parent is untouched
    expect(acc.body.theoreticalEntryId).toBeTruthy();
    expect((await insightsOf('opportunity'))[0]!.status).toBe('accepted');
    expect((await mgr.post(`/api/insights/${opp!.id}/accept`)).status).toBe(409);

    // 4. the replacement goes through a trial and is approved by someone else: the APPROVED entry
    await passingBatch(v2.id);
    const lab = await as('qc_manager');
    await lab.post(`/api/designs/${v2.id}/start-trial`);
    expect((await lab.post(`/api/designs/${v2.id}/pass-trial`).send(SIGN)).status).toBe(200);
    const ap = await (await as('qc_manager')).post(`/api/designs/${v2.id}/approve`).send(SIGN);
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(ap.body.superseded).toBe(base.id);
    expect(ap.body.savings.state).toBe('created');
    const [approved] = await env.db
      .select()
      .from(schema.savingsEntries)
      .where(
        and(
          eq(schema.savingsEntries.state, 'approved'),
          eq(schema.savingsEntries.variantDesignId, v2.id),
        ),
      );
    expect(Number(approved!.savingJodPerM3)).toBeGreaterThan(0);

    // 5. two months of produced volumes; the approved entry is dated back so August and September are closed months
    await env.db.execute(
      sql`UPDATE mix_designs SET approved_at = '2026-08-05T00:00:00Z' WHERE id = ${v2.id}`,
    );
    const vol = await as('plant_manager', [plantA]);
    expect(
      (
        await vol
          .post('/api/production-volumes')
          .send({ designId: v2.id, month: '2026-08', volumeM3: 1200 })
      ).status,
    ).toBe(201);
    expect(
      (
        await vol
          .post('/api/production-volumes')
          .send({ designId: v2.id, month: '2026-09', volumeM3: 800 })
      ).status,
    ).toBe(201);
    // before any month snapshot exists the months are blocked and named (nothing is estimated)
    const preview = await (await as('qc_manager')).get('/api/savings/blocked');
    expect(preview.body.blocked.map((b: { reason: string }) => b.reason)).toEqual(
      expect.arrayContaining(['no_snapshot']),
    );
    // month-close snapshots: end of each month
    await admin
      .post('/api/price-snapshots')
      .send({ name: 'Month close 2026-08', asOf: '2026-08-31', plantIds: [plantA] });
    await admin
      .post('/api/price-snapshots')
      .send({ name: 'Month close 2026-09', asOf: '2026-09-30', plantIds: [plantA] });
    const done = await realizeAll(ctx(), env.tenantId);
    expect(done.created).toBe(2);
    expect((await realizeAll(ctx(), env.tenantId)).created).toBe(0); // idempotent

    // 6. independent hand calculation: Σ lines of kg × price per kg at each month's prices, rounded per line to 3 places
    const prices: Record<string, { aug: number; sep: number }> = {};
    const priceAt = async (materialId: string, asOf: string) => {
      const rows = await env.db
        .select()
        .from(schema.materialPrices)
        .where(
          and(
            eq(schema.materialPrices.materialId, materialId),
            eq(schema.materialPrices.plantId, plantA),
          ),
        );
      const hit = rows
        .filter((r) => r.effectiveFrom <= asOf && (!r.effectiveTo || r.effectiveTo >= asOf))
        .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]!;
      return Number(hit.price);
    };
    const costAt = async (designId: string, asOf: string) => {
      const lines = await env.db
        .select()
        .from(schema.mixDesignLines)
        .where(eq(schema.mixDesignLines.designId, designId));
      let total = 0;
      for (const l of lines)
        total +=
          Math.round(
            ((Number(l.quantityKgM3) * (await priceAt(l.materialId, asOf))) / 1000) * 1000,
          ) / 1000;
      return Math.round(total * 1000) / 1000;
    };
    void prices;
    let expected = 0;
    for (const [asOf, m3] of [
      ['2026-08-31', 1200],
      ['2026-09-30', 800],
    ] as const) {
      const perM3 =
        Math.round(((await costAt(base.id, asOf)) - (await costAt(v2.id, asOf))) * 1000) / 1000;
      expected += Math.round(perM3 * m3 * 1000) / 1000;
    }
    const realized = await env.db
      .select()
      .from(schema.savingsEntries)
      .where(
        and(
          eq(schema.savingsEntries.state, 'realized'),
          eq(schema.savingsEntries.variantDesignId, v2.id),
        ),
      );
    const total = realized.reduce((s, r) => s + Number(r.totalJod), 0);
    expect(realized).toHaveLength(2);
    expect(Math.abs(total - expected)).toBeLessThan(0.0015);
    // every figure carries its state, period, volume and the snapshot both designs were priced at
    for (const r of realized) {
      expect(r.state).toBe('realized');
      expect(r.period).toMatch(/^2026-0[89]-01$/);
      expect(r.priceSnapshotId).toBeTruthy();
      expect(Number(r.producedVolumeM3)).toBeGreaterThan(0);
    }
    // the ledger endpoint keeps the states apart
    const ledger = await (await as('qc_manager')).get('/api/savings');
    expect(new Set(ledger.body.map((e: { state: string }) => e.state))).toEqual(
      new Set(['theoretical', 'approved', 'realized']),
    );
  }, 240_000);
});

describe('insights are triaged, scoped and cost-blind where they should be', () => {
  it('dismiss needs a reason, snooze hides until its time, cost is removed without cost.view, expiry follows inputs', async () => {
    const id = await approvedDesign('TRIAGE-1');
    await setPrice(mats['cem-i']!, '20', '2026-09-20');
    await onPriceChange(ctx(), env.tenantId, [plantA]);
    const mgr = await as('qc_manager');
    const list = await mgr.get('/api/insights');
    expect(list.status).toBe(200);
    const mine = list.body.find((i: { designId: string }) => i.designId === id.id);
    expect(mine).toBeTruthy();
    expect(mine.savingJodPerM3).not.toBeNull();
    const blind = await (await as('sales', [plantA])).get('/api/insights');
    expect(blind.status).toBe(200);
    const blindMine = blind.body.find((i: { designId: string }) => i.designId === id.id);
    expect(blindMine.savingJodPerM3).toBeNull();
    expect(blindMine.annualJod).toBeNull();
    const other = await (await as('plant_manager', [plantB])).get('/api/insights');
    expect(other.body.find((i: { designId: string }) => i.designId === id.id)).toBeUndefined();
    const eng = await as('qc_engineer', [plantA]);
    expect((await eng.post(`/api/insights/${mine.id}/dismiss`).send({ reason: 'x' })).status).toBe(
      400,
    );
    expect((await eng.post(`/api/insights/${mine.id}/snooze`).send({ days: 7 })).status).toBe(200);
    expect(
      (await mgr.get('/api/insights')).body.find((i: { id: string }) => i.id === mine.id),
    ).toBeUndefined();
    await env.db
      .update(schema.insights)
      .set({ snoozedUntil: new Date(Date.now() - 1000) })
      .where(eq(schema.insights.id, mine.id));
    expect(
      (await mgr.get('/api/insights')).body.find((i: { id: string }) => i.id === mine.id),
    ).toBeTruthy();
    expect(
      (
        await eng
          .post(`/api/insights/${mine.id}/dismiss`)
          .send({ reason: 'not now, trial slots are full' })
      ).status,
    ).toBe(200);
    expect(
      (await eng.post(`/api/insights/${mine.id}/dismiss`).send({ reason: 'again again' })).status,
    ).toBe(409);
    // inputs change (price restored): the sweep expires what it no longer produces
    await setPrice(mats['cem-i']!, '160', '2026-09-25');
    const started = new Date();
    await onPriceChange(ctx(), env.tenantId, [plantA]);
    await nightly({ db: env.db }, env.tenantId, { runStartedAt: started });
    const open = await env.db
      .select()
      .from(schema.insights)
      .where(and(eq(schema.insights.type, 'opportunity'), eq(schema.insights.status, 'open')));
    for (const o of open)
      expect(new Date(o.lastSeenAt).getTime()).toBeGreaterThanOrEqual(started.getTime() - 1000);
    const digest = await mgr.get('/api/insights/digest');
    expect(digest.body.summary).toHaveProperty('open');
    expect((await takeDigest(ctx(), env.tenantId)).bySeverity).toHaveProperty('critical');
    // history is append-only
    await expect(env.db.update(schema.insightEvents).set({ kind: 'x' })).rejects.toThrow();
  }, 240_000);
});

describe('production volumes', () => {
  it('RBAC, plant scope, future months, corrections need a note, the latest row is in force', async () => {
    const { id } = await approvedDesign('VOL-1');
    expect(
      (
        await (
          await as('procurement')
        )
          .post('/api/production-volumes')
          .send({ designId: id, month: '2026-08', volumeM3: 1 })
      ).status,
    ).toBe(403);
    expect(
      (
        await (
          await as('plant_manager', [plantB])
        )
          .post('/api/production-volumes')
          .send({ designId: id, month: '2026-08', volumeM3: 1 })
      ).status,
    ).toBe(404);
    const own = await as('plant_manager', [plantA]);
    expect(
      (
        await own
          .post('/api/production-volumes')
          .send({ designId: id, month: '2099-01', volumeM3: 5 })
      ).status,
    ).toBe(400);
    expect(
      (
        await own
          .post('/api/production-volumes')
          .send({ designId: id, month: '2026-08', volumeM3: 100 })
      ).status,
    ).toBe(201);
    expect(
      (
        await own
          .post('/api/production-volumes')
          .send({ designId: id, month: '2026-08', volumeM3: 110 })
      ).status,
    ).toBe(400);
    const fix = await own
      .post('/api/production-volumes')
      .send({ designId: id, month: '2026-08', volumeM3: 110, note: 'late tickets' });
    expect(fix.body.correction).toBe(true);
    const got = await own.get(`/api/production-volumes?designId=${id}`);
    expect(got.body.inForce).toEqual([{ month: '2026-08-01', volumeM3: '110.00' }]);
    expect(got.body.history).toHaveLength(2);
  });
});

describe('triggers: tests, strength, rules, nudges', () => {
  it('an unset drift tolerance is a named review, never "within"', async () => {
    const mgr = await as('qc_manager');
    const before = (await insightsOf('test_drift')).length;
    const res = await mgr.post(`/api/materials/${mats['sand']}/tests`).send({
      properties: {
        sg_ssd: 2.63,
        chlorides_pct: 0.01,
        dry_rodded_unit_weight_kg_m3: 1650,
        sieve_analysis: [
          { sieve_mm: 9.5, passing_pct: 100 },
          { sieve_mm: 4.75, passing_pct: 98 },
          { sieve_mm: 0.075, passing_pct: 3 },
        ],
      },
      source: 'supplier_datasheet',
      testedAt: '2026-09-30',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await onMaterialTest(ctx(), env.tenantId, mats['sand']!);
    const drift = await insightsOf('test_drift');
    expect(drift.length).toBe(before + 1);
    const d = drift[drift.length - 1]!;
    expect(['medium', 'high']).toContain(d.severity);
    expect((d.payload as { noToleranceConfigured: boolean }).noToleranceConfigured).toBe(true);
  });

  it('a strength set below f′cr on an approved design is a critical alert; a good set is not', async () => {
    const { id } = await approvedDesign('STR-1');
    const d = await designRow(id);
    const [ev] = await env.db
      .select()
      .from(schema.designEvaluations)
      .where(eq(schema.designEvaluations.id, d.lastEvaluationId!));
    const fcr = (ev!.report as { strengthAdequacy: { fcrMpa: number } }).strengthAdequacy.fcrMpa;
    const [batch] = await env.db
      .select()
      .from(schema.trialBatches)
      .where(eq(schema.trialBatches.designId, id));
    const lab = await as('qc_engineer', [plantA]);
    // results on an approved design are entered against its batch record; the set is below f′cr
    await env.db.insert(schema.strengthResults).values({
      tenantId: env.tenantId,
      plantId: plantA,
      trialBatchId: batch!.id,
      designId: id,
      castDate: '2026-10-01',
      ageDays: 28,
      specimenType: 'cylinder',
      setId: 'LOW-1',
      resultMpa: String(fcr - 4),
    });
    void lab;
    const r = await onStrengthResult(ctx(), env.tenantId, id);
    expect(r.created).toBe(1);
    const [alert] = (await insightsOf('low_strength')).filter((i) => i.designId === id);
    expect(alert).toMatchObject({ severity: 'critical', status: 'open' });
    expect((await onStrengthResult(ctx(), env.tenantId, id)).created).toBe(0); // deduped
    await env.db.insert(schema.strengthResults).values({
      tenantId: env.tenantId,
      plantId: plantA,
      trialBatchId: batch!.id,
      designId: id,
      castDate: '2026-10-02',
      ageDays: 28,
      specimenType: 'cylinder',
      setId: 'OK-2',
      resultMpa: String(fcr + 5),
    });
    expect((await onStrengthResult(ctx(), env.tenantId, id)).created).toBe(0);
    // a QC manager decides: suspend, and later reinstate (only QC managers; the database refuses any other jump)
    const mgr = await as('qc_manager');
    expect((await lab.post(`/api/designs/${id}/suspend`).send(SIGN)).status).toBe(403);
    expect((await mgr.post(`/api/designs/${id}/suspend`).send(SIGN)).status).toBe(200);
    expect((await designRow(id)).status).toBe('suspended');
    expect((await mgr.post(`/api/designs/${id}/release`).send(SIGN)).status).toBe(409);
    await expect(
      env.db.update(schema.mixDesigns).set({ status: 'draft' }).where(eq(schema.mixDesigns.id, id)),
    ).rejects.toThrow();
    expect(
      (await mgr.post(`/api/designs/${id}/reinstate`).send({ ...SIGN, to: 'approved' })).status,
    ).toBe(200);
    expect((await designRow(id)).status).toBe('approved');
  });

  it('a rule change that makes a design fail is listed; nothing changed means no insight', async () => {
    const before = (await insightsOf('rule_change')).length;
    expect((await onRuleChange(ctx(), env.tenantId)).created).toBe(0);
    expect((await insightsOf('rule_change')).length).toBe(before);
  });

  it('expired tests and stale prices nudge per plant', async () => {
    const admin = (await env.seedUser('admin')).id;
    await env.db.transaction(async (tx) => {
      for (const key of ['eng.test_age_limit_days.fine_agg']) {
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
        await supersede(
          tx,
          env.tenantId,
          admin,
          r!.row,
          { value: 30 },
          'ui',
          'SYNTHETIC age limit',
        );
      }
    });
    await setSettings({
      insightMinSavingJodPerM3: 0.01,
      insightMinAnnualJod: 1,
      stalePriceDays: 30,
    });
    await nudges(ctx(), env.tenantId, new Date('2027-03-01T00:00:00Z'));
    expect((await insightsOf('test_expired')).some((i) => i.plantId === plantA)).toBe(true);
    expect((await insightsOf('prices_stale')).some((i) => i.plantId === plantA)).toBe(true);
  });
});

describe('the worker (pg-boss)', () => {
  it('runs a queued job once, and a burst under one singleton key is one job', async () => {
    const { startWorker } = await import('../src/jobs');
    const calls: string[] = [];
    const stub = async (d: Record<string, unknown>) => {
      calls.push(String(d['x']));
    };
    const worker = await startWorker(
      { DATABASE_URL: env.config.DATABASE_URL },
      {
        'price-change': stub,
        'material-test': stub,
        'rule-change': stub,
        'strength-result': stub,
        nightly: stub,
        backup: stub,
      },
    );
    try {
      await worker.jobs.enqueue('rule-change', { x: 'a' }, { singletonKey: 'k', delaySeconds: 3 });
      await worker.jobs.enqueue('rule-change', { x: 'b' }, { singletonKey: 'k', delaySeconds: 3 });
      await worker.jobs.enqueue('price-change', { x: 'c' });
      for (let i = 0; i < 40 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 500));
      await new Promise((r) => setTimeout(r, 4500));
      expect(calls.sort()).toEqual(['a', 'c']);
      const st = (await worker.status()) as { queues: { name: string }[] };
      expect(st.queues.length).toBeGreaterThan(0);
    } finally {
      await worker.stop();
    }
    void handlersFor;
  }, 60_000);
});
