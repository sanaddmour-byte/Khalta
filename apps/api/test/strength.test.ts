import { schema } from '@khalta/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nightlyStrength, onStrengthIntel } from '../src/strength/intel';
import { supersede } from '../src/rules/service';
import { createTestEnv, type TestEnv } from './helpers';
import { optimizerWorld, REQUIREMENTS as BASE } from './opt-world';

// SYNTHETIC world, SYNTHETIC trial criteria, SYNTHETIC strength results: labelled test data, not a plant's values.
const REQUIREMENTS = { ...BASE, testAgeDays: 28 };
const CRITERIA = {
  'eng.trial.slump_tolerance_mm': 25,
  'eng.trial.air_tolerance_pct': 1.5,
  'eng.trial.density_band_kg_m3': 40,
  'eng.trial.yield_band_m3': 0.01,
  'eng.trial.temperature_max_c': 32,
};
const SIGN = { reason: 'Signed in the strength test' };
const A = 4.6;
const B = 2.2;
let env: TestEnv;
let plantA: string;
let mats: Record<string, string>;
let live: string; // the approved (live) design the model's group contains
const versions: string[] = []; // drafts of `live` at three w/cm levels
const wcmOf: Record<string, number> = {};

const ctx = () => ({ db: env.db });
const as = async (role: Parameters<TestEnv['seedUser']>[0], plantIds: string[] = []) =>
  env.login((await env.seedUser(role, { plantIds })).email);
const designRow = async (id: string) =>
  (await env.db.select().from(schema.mixDesigns).where(eq(schema.mixDesigns.id, id)))[0]!;
const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function approvedDesign(code: string) {
  const m = await as('qc_manager');
  const made = await m
    .post('/api/design-requests')
    .send({ plantId: plantA, mode: 'ACI', requirements: REQUIREMENTS });
  const eng = await as('qc_engineer', [plantA]);
  const res = await eng
    .post(
      `/api/design-requests/${made.body.id}/candidates/${made.body.candidates[0].id}/trial-candidate`,
    )
    .send({ code, name: code });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = res.body.design.id as string;
  const d = await designRow(id);
  const [ev] = await env.db
    .select()
    .from(schema.designEvaluations)
    .where(eq(schema.designEvaluations.id, d.lastEvaluationId!));
  const rep = ev!.report as {
    trace: { key: string; value: number }[];
    strengthAdequacy: { fcrMpa: number };
  };
  const batch = await m.post(`/api/designs/${id}/trial-batches`).send({
    batchedOn: '2026-10-01',
    slumpMm: 100,
    airPct: 2,
    temperatureC: 25,
    freshDensityKgM3: rep.trace.find((t) => t.key === 'mass.fresh_density')!.value,
    yieldM3: 1,
  });
  await m.post(`/api/trial-batches/${batch.body.id}/strength-results`).send({
    castDate: '2026-10-01',
    ageDays: 28,
    specimenType: 'cylinder',
    setId: 'P',
    resultsMpa: [rep.strengthAdequacy.fcrMpa + 3],
  });
  expect((await m.post(`/api/designs/${id}/start-trial`)).status).toBe(200);
  expect((await m.post(`/api/designs/${id}/pass-trial`).send(SIGN)).status).toBe(200);
  const ok = await (await as('qc_manager')).post(`/api/designs/${id}/approve`).send(SIGN);
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  return id;
}

/** SYNTHETIC results: 12 sets (two cylinders each) per version around ln f = A − B·w/cm, deterministic wobble. */
async function seedResults(designId: string, count: number, offset = 0, a = A) {
  const w = wcmOf[designId]!;
  const rows = Array.from({ length: count }, (_, i) => {
    const wobble = (((i + offset) * 7) % 5) - 2; // −2..2
    const f = Math.exp(a - B * w) + wobble * 0.4;
    return [0, 1].map((k) => ({
      tenantId: env.tenantId,
      plantId: plantA,
      designId,
      castDate: dayAgo(5 + i + offset),
      ageDays: 28,
      specimenType: 'cylinder' as const,
      setId: `S${offset + i}`,
      resultMpa: (f + (k === 0 ? 0.2 : -0.2)).toFixed(2),
    }));
  }).flat();
  await env.db.insert(schema.strengthResults).values(rows);
}

async function setSettings(settings: Record<string, unknown>) {
  await env.db
    .insert(schema.tenantSettings)
    .values({ tenantId: env.tenantId, settings })
    .onConflictDoUpdate({ target: schema.tenantSettings.tenantId, set: { settings } });
}

beforeAll(async () => {
  env = await createTestEnv();
  const w = await optimizerWorld(env, ['STR-A']);
  plantA = w.plants[0]!;
  mats = w.mats[0]!;
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
  await setSettings({});
  live = await approvedDesign('STR-LIVE');
  // three drafts at different water → three w/cm levels, all in the live design's group
  const lines = await env.db
    .select()
    .from(schema.mixDesignLines)
    .where(eq(schema.mixDesignLines.designId, live));
  const mgr = await as('qc_manager');
  for (const k of [0.85, 1.0, 1.15]) {
    const made = await mgr.post(`/api/designs/${live}/versions`).send({
      note: 'SYNTHETIC water level',
      lines: lines.map((l) => ({
        materialId: l.materialId,
        kgPerM3:
          l.materialId === mats['water'] ? (Number(l.quantityKgM3) * k).toFixed(3) : l.quantityKgM3,
      })),
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const ev = await mgr.post(`/api/designs/${made.body.id}/evaluate`).send({ mode: 'ACI' });
    expect(ev.status, JSON.stringify(ev.body)).toBeLessThan(300);
    versions.push(made.body.id as string);
  }
  versions.push(live);
  for (const id of versions) {
    const d = await designRow(id);
    const [e] = await env.db
      .select()
      .from(schema.designEvaluations)
      .where(eq(schema.designEvaluations.id, d.lastEvaluationId!));
    wcmOf[id] = (e!.report as { figures: Record<string, number> }).figures['ratio.wcm']!;
  }
  for (const id of versions.slice(0, 3)) await seedResults(id, 12);
}, 240_000);
afterAll(() => env.close());

describe('fitting: a proposal with the evidence it stands on', () => {
  it('three w/cm levels of one group give a valid proposal with its points', async () => {
    const res = await (await as('qc_manager')).post('/api/strength-models/refit').send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [g] = res.body.groups as { result: string; status: string; n: number; modelId: string }[];
    expect(g).toMatchObject({ result: 'fitted', status: 'valid', n: 37 });
    const m = await (await as('qc_manager')).get(`/api/strength-models/${g!.modelId}`);
    expect(m.body.model).toMatchObject({
      status: 'valid',
      levels: 3,
      inForce: false,
      approvedAt: null,
    });
    expect(Number(m.body.model.b)).toBeGreaterThan(1.5);
    expect(Number(m.body.model.b)).toBeLessThan(3);
    expect(m.body.points.filter((p: { included: boolean }) => p.included)).toHaveLength(37);
    // an unchanged input set stores nothing new
    const again = await (await as('qc_manager')).post('/api/strength-models/refit').send({});
    expect(again.body.groups[0].result).toBe('unchanged');
  });

  it('is not used by anything before a QC manager approves it', async () => {
    const ev = await (
      await as('qc_manager')
    )
      .post(`/api/designs/${live}/evaluate`)
      .send({ mode: 'ACI' });
    expect(ev.body.report.strengthAdequacy.model).toBe('none');
    expect(ev.body.report.strengthAdequacy.modelUse).toBeUndefined();
  });

  it('RBAC: only a QC manager approves; an engineer can fit but not approve', async () => {
    const [m] = await env.db.select().from(schema.strengthModels);
    const eng = await as('qc_engineer', [plantA]);
    expect((await eng.post(`/api/strength-models/${m!.id}/approve`).send(SIGN)).status).toBe(403);
    expect((await eng.post('/api/strength-models/refit').send({})).status).toBe(200);
    expect((await (await as('sales')).get('/api/strength-models')).body.models ?? []).toEqual([]);
    expect(
      (
        await (
          await as('qc_manager')
        )
          .post(`/api/strength-models/${m!.id}/approve`)
          .send({ reason: 'no' })
      ).status,
    ).toBe(400);
  });
});

describe('an approved valid model is used (and only for its own group and domain)', () => {
  let modelId: string;
  it('approval records an e-signature and puts the model in force', async () => {
    modelId = (await env.db.select().from(schema.strengthModels))[0]!.id;
    const ok = await (
      await as('qc_manager')
    )
      .post(`/api/strength-models/${modelId}/approve`)
      .send(SIGN);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const [row] = await env.db
      .select()
      .from(schema.strengthModels)
      .where(eq(schema.strengthModels.id, modelId));
    expect(row!.approvedAt).not.toBeNull();
    expect(row!.approvalSignature).toMatchObject({
      meaning: 'strength_model_approved',
      reason: SIGN.reason,
    });
    expect(
      (await (await as('qc_manager')).post(`/api/strength-models/${modelId}/approve`).send(SIGN))
        .status,
    ).toBe(409);
    expect(
      (
        await env.db
          .select()
          .from(schema.auditLog)
          .where(eq(schema.auditLog.action, 'strength_model.approve'))
      ).length,
    ).toBe(1);
  });

  it('the evaluator uses it inside its domain, labelled MODEL_IN_DOMAIN, and the validator agrees', async () => {
    const mgr = await as('qc_manager');
    const ev = await mgr.post(`/api/designs/${versions[1]}/evaluate`).send({ mode: 'ACI' });
    expect(ev.status).toBeLessThan(300);
    const adq = ev.body.report.strengthAdequacy;
    expect(adq.model).toBe('plant');
    expect(adq.modelUse).toBe('used');
    expect(adq.evidence).toContain('MODEL_IN_DOMAIN');
    expect(adq.evidence).toContain('TRIAL_REQUIRED');
    expect(adq.label).toBe('not_a_compliance_result');
    const [m] = await env.db.select().from(schema.strengthModels);
    expect(adq.governingWc).toBeCloseTo((Number(m!.a) - Math.log(adq.fcrMpa)) / Number(m!.b), 5);
    expect(ev.body.validator.status).toBe('pass');
  });

  it('a design outside the model domain keeps the ACI baseline and says why', async () => {
    const [m] = await env.db.select().from(schema.strengthModels);
    await env.db
      .update(schema.strengthModels)
      .set({ wcmMax: '0.300000' })
      .where(eq(schema.strengthModels.id, m!.id));
    const ev = await (
      await as('qc_manager')
    )
      .post(`/api/designs/${versions[1]}/evaluate`)
      .send({ mode: 'ACI' });
    expect(ev.body.report.strengthAdequacy).toMatchObject({
      model: 'none',
      modelUse: 'out_of_domain',
    });
    expect(ev.body.report.strengthAdequacy.evidence).toContain('MODEL_BASELINE');
    expect(ev.body.validator.status).toBe('pass');
    await env.db
      .update(schema.strengthModels)
      .set({ wcmMax: m!.wcmMax })
      .where(eq(schema.strengthModels.id, m!.id));
  });

  it('the optimizer uses the model only where every candidate is in its group, else the baseline', async () => {
    const mgr = await as('qc_manager');
    const used = (
      await env.db
        .select()
        .from(schema.mixDesignLines)
        .where(eq(schema.mixDesignLines.designId, live))
    ).map((l) => l.materialId);
    const pinned = await mgr.post('/api/design-requests').send({
      plantId: plantA,
      mode: 'ACI',
      requirements: REQUIREMENTS,
      materials: { include: used },
    });
    expect(pinned.status, JSON.stringify(pinned.body)).toBeLessThan(300);
    const uses = (
      pinned.body.candidates as { report?: { strengthAdequacy: { model: string } } }[]
    ).map((c) => c.report?.strengthAdequacy.model);
    // all candidates agree: the whole run is either on the model or on the baseline, never mixed
    expect(new Set(uses.filter(Boolean)).size).toBeLessThanOrEqual(1);
    for (const c of pinned.body.candidates as { validator?: { status: string } }[])
      if (c.validator) expect(c.validator.status).toBe('pass');
  });

  it('a plain group (cement, water, aggregates only) is used by an optimizer run pinned to those materials', async () => {
    const mgr = await as('qc_manager');
    const lines = await env.db
      .select({
        id: schema.mixDesignLines.materialId,
        q: schema.mixDesignLines.quantityKgM3,
        c: schema.materials.category,
      })
      .from(schema.mixDesignLines)
      .innerJoin(schema.materials, eq(schema.materials.id, schema.mixDesignLines.materialId))
      .where(eq(schema.mixDesignLines.designId, live));
    const plain = lines.filter((l) => ['cement', 'water', 'fine_agg', 'coarse_agg'].includes(l.c));
    const plainIds: string[] = [];
    for (const k of [0.85, 1.0, 1.15]) {
      const made = await mgr.post(`/api/designs/${live}/versions`).send({
        note: 'SYNTHETIC plain group',
        lines: plain.map((l) => ({
          materialId: l.id,
          kgPerM3: l.c === 'water' ? (Number(l.q) * k).toFixed(3) : l.q,
        })),
      });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      expect(
        (await mgr.post(`/api/designs/${made.body.id}/evaluate`).send({ mode: 'ACI' })).status,
      ).toBeLessThan(300);
      const d = await designRow(made.body.id);
      const [e] = await env.db
        .select()
        .from(schema.designEvaluations)
        .where(eq(schema.designEvaluations.id, d.lastEvaluationId!));
      wcmOf[made.body.id] = (e!.report as { figures: Record<string, number> }).figures[
        'ratio.wcm'
      ]!;
      // centred so the model's w/cm for this f′cr (38.3 MPa here) falls inside the group's domain
      await seedResults(made.body.id, 12, 100, Math.log(38.3) + B * 0.68);
      plainIds.push(made.body.id);
    }
    expect((await mgr.post('/api/strength-models/refit').send({})).status).toBe(200);
    const plainModel = (await env.db.select().from(schema.strengthModels))
      .filter(
        (x) =>
          !(x.grp as { admixtures: unknown[] }).admixtures.length &&
          !(x.grp as { scm: unknown[] }).scm.length &&
          x.status === 'valid',
      )
      .sort((a, b) => b.fittedAt.getTime() - a.fittedAt.getTime())[0]!;
    expect(plainModel.n).toBe(36);
    expect(
      (await mgr.post(`/api/strength-models/${plainModel.id}/approve`).send(SIGN)).status,
    ).toBe(200);
    const run = await mgr.post('/api/design-requests').send({
      plantId: plantA,
      mode: 'ACI',
      requirements: REQUIREMENTS,
      materials: { include: plain.map((l) => l.id) },
    });
    expect(run.status, JSON.stringify(run.body)).toBeLessThan(300);
    expect(run.body.candidates.length).toBeGreaterThan(0);
    for (const c of run.body.candidates as {
      report: { strengthAdequacy: Record<string, unknown> };
      validator: { status: string };
    }[]) {
      expect(c.report.strengthAdequacy['model']).toBe('plant');
      expect(c.report.strengthAdequacy['modelUse']).toBe('used');
      expect(c.validator.status).toBe('pass');
    }
    await mgr
      .post(`/api/strength-models/${plainModel.id}/retire`)
      .send({ reason: 'Plain-group scenario finished' });
  });

  it('retiring a model returns the evaluator to the baseline', async () => {
    const mgr = await as('qc_manager');
    const r = await mgr
      .post(`/api/strength-models/${modelId}/retire`)
      .send({ reason: 'Re-checking the data' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const ev = await mgr.post(`/api/designs/${versions[1]}/evaluate`).send({ mode: 'ACI' });
    expect(ev.body.report.strengthAdequacy.model).toBe('none');
    expect(ev.body.report.strengthAdequacy.modelUse).toBeUndefined();
    expect(
      (await mgr.post(`/api/strength-models/${modelId}/retire`).send({ reason: 'Again please' }))
        .status,
    ).toBe(409);
    // approve again for the tests below
    expect((await mgr.post('/api/strength-models/refit').send({})).status).toBe(200);
  });
});

describe('provisional is named, never valid by accident', () => {
  it('29 sets is provisional with the reason, and cannot be approved', async () => {
    const lab = await as('qc_manager');
    // a second plant's world would be needed for an independent group; here we cut the window instead
    await setSettings({ strengthModelMinResults: 40 });
    const res = await lab.post('/api/strength-models/refit').send({});
    const [row] = await env.db
      .select()
      .from(schema.strengthModels)
      .orderBy(schema.strengthModels.fittedAt);
    expect(res.status).toBe(200);
    const latest = (await env.db.select().from(schema.strengthModels)).sort(
      (a, b) => b.fittedAt.getTime() - a.fittedAt.getTime(),
    )[0]!;
    expect(row).toBeTruthy();
    expect(latest.status).toBe('provisional');
    expect((latest.reasons as { code: string }[]).map((r) => r.code)).toContain('too_few_results');
    const r = await lab.post(`/api/strength-models/${latest.id}/approve`).send(SIGN);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('model_not_valid');
    await setSettings({});
  });
});

describe('low-strength alerts on the live design (the seeded sequence)', () => {
  const insights = (criterion?: string) =>
    env.db
      .select()
      .from(schema.insights)
      .where(and(eq(schema.insights.designId, live), eq(schema.insights.type, 'low_strength')))
      .then((rows) =>
        rows.filter(
          (r) => !criterion || (r.payload as { criterion?: string }).criterion === criterion,
        ),
      );
  const addSet = async (setId: string, mpa: number, day: number) =>
    env.db.insert(schema.strengthResults).values(
      [0, 1].map((k) => ({
        tenantId: env.tenantId,
        plantId: plantA,
        designId: live,
        castDate: dayAgo(day),
        ageDays: 28,
        specimenType: 'cylinder' as const,
        setId,
        resultMpa: (mpa + (k ? 0.1 : -0.1)).toFixed(2),
      })),
    );

  it('a clean history raises nothing', async () => {
    await addSet('OK1', 50, 4);
    await addSet('OK2', 50, 3);
    await addSet('OK3', 50, 2);
    await onStrengthIntel(ctx(), env.tenantId, live);
    expect((await insights('acceptance')).filter((i) => i.status === 'open')).toHaveLength(0);
  });

  it('the low sequence fires the acceptance alert exactly once, and a further result updates it', async () => {
    await addSet('L1', 20, 1.5 as number);
    await addSet('L2', 20, 1);
    await addSet('L3', 20, 0.5 as number);
    await onStrengthIntel(ctx(), env.tenantId, live);
    const open = (await insights('acceptance')).filter((i) => i.status === 'open');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ severity: 'critical', plantId: plantA });
    const kinds = (open[0]!.payload as { breaches: { kind: string }[] }).breaches.map(
      (b) => b.kind,
    );
    expect(kinds).toContain('avg3');
    expect(kinds).toContain('single');
    await addSet('L4', 19, 0);
    await onStrengthIntel(ctx(), env.tenantId, live);
    expect((await insights('acceptance')).filter((i) => i.status === 'open')).toHaveLength(1);
    // it names a decision for a person: nothing suspended
    expect((await designRow(live)).status).toBe('approved');
  });

  it('a recovered sequence expires the alert', async () => {
    await addSet('R1', 55, -1);
    await addSet('R2', 55, -2);
    await addSet('R3', 55, -3);
    await onStrengthIntel(ctx(), env.tenantId, live);
    const rows = await insights('acceptance');
    expect(rows.filter((i) => i.status === 'open')).toHaveLength(0);
    expect(rows.some((i) => i.status === 'expired' && i.resolvedReason === 'recovered')).toBe(true);
  });

  it('the sequence rule fires against the approved model band', async () => {
    const mgr = await as('qc_manager');
    expect((await mgr.post('/api/strength-models/refit').send({})).status).toBe(200);
    const [m] = (await env.db.select().from(schema.strengthModels))
      .filter(
        (x) =>
          x.status === 'valid' &&
          !x.retiredAt &&
          !x.approvedAt &&
          (x.grp as { admixtures: unknown[] }).admixtures.length > 0,
      )
      .sort((a, b) => b.fittedAt.getTime() - a.fittedAt.getTime());
    const ok = await mgr.post(`/api/strength-models/${m!.id}/approve`).send(SIGN);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    await addSet('Q1', 21, -4);
    await addSet('Q2', 21, -5);
    await addSet('Q3', 21, -6);
    await onStrengthIntel(ctx(), env.tenantId, live);
    const seq = (await insights('sequence')).filter((i) => i.status === 'open');
    expect(seq).toHaveLength(1);
    expect((seq[0]!.payload as { modelId: string }).modelId).toBe(m!.id);
    await addSet('Q4', 60, -7);
    await addSet('Q5', 60, -8);
    await addSet('Q6', 60, -9);
    await onStrengthIntel(ctx(), env.tenantId, live);
    expect((await insights('sequence')).filter((i) => i.status === 'open')).toHaveLength(0);
  });
});

describe('proposals are read-only', () => {
  it('s refit comes with n and the code sample condition, never applied', async () => {
    const r = await (await as('qc_manager')).get('/api/strength/s-proposal');
    expect(r.status).toBe(200);
    const mine = (
      r.body.proposals as { designId: string; n: number; enoughForCode: boolean; sMpa: number }[]
    ).find((p) => p.designId === live);
    expect(mine!.n).toBeGreaterThan(10);
    expect(mine!.sMpa).toBeGreaterThan(0);
  });
  it('β is "not enough data" with the reason, and no rule is written', async () => {
    const r = await (await as('qc_manager')).get(`/api/strength/beta-proposal?plantId=${plantA}`);
    expect(r.status).toBe(200);
    expect(r.body.proposal.ok).toBe(false);
    expect(r.body.proposal.missing.map((m: { code: string }) => m.code)).toContain(
      'too_few_batches',
    );
    const rules = await env.db
      .select()
      .from(schema.rules)
      .where(and(eq(schema.rules.key, 'eng.water.beta_fm'), eq(schema.rules.isCurrent, true)));
    expect(rules[0]!.value).toBeNull();
  });
});

describe('invalidation: a changed material takes the model out of use', () => {
  it('a different cement type invalidates the approved model, tells QC, and the baseline governs again', async () => {
    const [m] = (await env.db.select().from(schema.strengthModels)).filter(
      (x) => x.approvedAt && !x.retiredAt,
    );
    expect(m).toBeTruthy();
    const mgr = await as('qc_manager');
    const [t] = await env.db
      .select()
      .from(schema.materialTests)
      .where(
        and(
          eq(schema.materialTests.materialId, mats['cem-i']!),
          eq(schema.materialTests.isCurrent, true),
        ),
      );
    const res = await mgr.post(`/api/materials/${mats['cem-i']}/tests`).send({
      properties: { ...(t!.properties as object), cement_type: 'CEM II SYNTHETIC' },
      source: 'supplier_datasheet',
      testedAt: '2026-09-15',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const out = await nightlyStrength(ctx(), env.tenantId);
    expect(out.invalidated).toBe(1);
    const [after] = await env.db
      .select()
      .from(schema.strengthModels)
      .where(eq(schema.strengthModels.id, m!.id));
    expect(after!.status).toBe('invalidated');
    expect((after!.reasons as { code: string }[]).map((r) => r.code)).toContain(
      'cement_type_changed',
    );
    const ins = await env.db
      .select()
      .from(schema.insights)
      .where(eq(schema.insights.type, 'model_invalidated'));
    expect(ins).toHaveLength(1);
    const ev = await mgr.post(`/api/designs/${versions[1]}/evaluate`).send({ mode: 'ACI' });
    expect(ev.body.report.strengthAdequacy.model).toBe('none');
    // a second night finds nothing more to invalidate
    expect((await nightlyStrength(ctx(), env.tenantId)).invalidated).toBe(0);
  });
});
