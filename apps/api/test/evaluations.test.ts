import { schema } from '@khalta/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';

// A switch that makes the validator disagree with the evaluator (it is handed a report with a wrong w/cm),
// to prove a validator failure keeps a design in draft and is stored.
let corrupt = false;
vi.mock('@khalta/validator', async (orig) => {
  const mod = await orig<typeof import('@khalta/validator')>();
  return {
    ...mod,
    validateEvaluation: (s: never, r: { figures: Record<string, unknown> }) =>
      mod.validateEvaluation(
        s,
        corrupt ? ({ ...r, figures: { ...r.figures, 'ratio.wcm': 0.1 } } as never) : (r as never),
      ),
  };
});

let env: TestEnv;
let supplierId: string;
let n = 0;

beforeAll(async () => {
  env = await createTestEnv({}, { seedRules: true });
  const [s] = await env.db
    .insert(schema.suppliers)
    .values({ tenantId: env.tenantId, nameAr: 'مورد', nameEn: 'Supplier' })
    .returning();
  supplierId = s!.id;
});
afterAll(() => env.close());

const SIEVE = (rows: Record<string, number>) =>
  Object.entries(rows).map(([sieve_mm, passing_pct]) => ({
    sieve_mm: Number(sieve_mm),
    passing_pct,
  }));
const TESTS: Record<
  string,
  { category: string; props: Record<string, unknown>; price: [string, string] }
> = {
  cem: { category: 'cement', props: { sg: 3.15, c3a_pct: 7.5 }, price: ['75', 'JOD/ton'] },
  sand: {
    category: 'fine_agg',
    props: {
      sg_ssd: 2.6,
      absorption_pct: 1.5,
      chlorides_pct: 0.01,
      sieve_analysis: SIEVE({
        '9.5': 100,
        '4.75': 98,
        '2.36': 80,
        '1.18': 55,
        '0.6': 35,
        '0.3': 15,
        '0.15': 5,
      }),
    },
    price: ['8', 'JOD/ton'],
  },
  coarse: {
    category: 'coarse_agg',
    props: {
      sg_ssd: 2.65,
      absorption_pct: 1,
      chlorides_pct: 0.005,
      sieve_analysis: SIEVE({ '25': 100, '19': 95, '12.5': 40, '9.5': 15, '4.75': 3, '2.36': 0 }),
    },
    price: ['7', 'JOD/ton'],
  },
  water: {
    category: 'water',
    props: { sg: 1, sg_confirmed: true, chloride_mg_l: 200 },
    price: ['0.5', 'JOD/ton'],
  },
  sp: {
    category: 'admixture',
    props: {
      type: 'F',
      sg: 1.08,
      solids_pct: 40,
      chloride_pct: 0.05,
      min_dosage_pct: 0.4,
      max_dosage_pct: 1.5,
      water_convention: 'liquid_counts_as_water',
      water_reduction_table: [
        { dosage_pct: 0.4, water_reduction_pct: 8 },
        { dosage_pct: 0.8, water_reduction_pct: 14 },
        { dosage_pct: 1.5, water_reduction_pct: 22 },
      ],
    },
    price: ['1200', 'JOD/ton'],
  },
};
const LINES: Record<string, string> = {
  cem: '350.000',
  water: '175.000',
  sp: '3.500',
  sand: '780.000',
  coarse: '1035.000',
};

interface World {
  plantId: string;
  mat: Record<string, string>;
  design: (
    over?: Partial<typeof schema.mixDesigns.$inferInsert>,
    lines?: Record<string, string>,
  ) => Promise<string>;
}

async function world(
  code: string,
  opts: { skipTest?: string[]; skipPrice?: string[] } = {},
): Promise<World> {
  const plant = await env.seedPlant(code);
  const mat: Record<string, string> = {};
  for (const [key, t] of Object.entries(TESTS)) {
    const [m] = await env.db
      .insert(schema.materials)
      .values({
        tenantId: env.tenantId,
        plantId: plant.id,
        category: t.category,
        marketNameEn: `${code} ${key}`,
        marketNameAr: `${key} ${code}`,
      })
      .returning();
    mat[key] = m!.id;
    if (!opts.skipTest?.includes(key))
      await env.db.insert(schema.materialTests).values({
        tenantId: env.tenantId,
        materialId: m!.id,
        version: 1,
        isCurrent: true,
        source: 'supplier_datasheet',
        properties: t.props,
        testedAt: '2026-08-01',
      });
    if (!opts.skipPrice?.includes(key))
      await env.db.insert(schema.materialPrices).values({
        tenantId: env.tenantId,
        materialId: m!.id,
        plantId: plant.id,
        supplierId,
        price: t.price[0],
        unit: t.price[1] as 'JOD/ton',
        effectiveFrom: '2026-01-01',
      });
  }
  return {
    plantId: plant.id,
    mat,
    design: async (over = {}, lines = LINES) => {
      const [d] = await env.db
        .insert(schema.mixDesigns)
        .values({
          tenantId: env.tenantId,
          code: `${code}-D${++n}`,
          name: `Design ${n}`,
          plantId: plant.id,
          requirements: {
            fcMpa: 30,
            basis: 'cylinder',
            testAgeDays: 28,
            exposure: ['F0', 'S0', 'W0', 'C1'],
            slumpMm: 100,
            nmasMm: 19,
            pumpable: true,
            airPct: 2,
          },
          inputsSnapshot: {},
          ...over,
        })
        .returning();
      let i = 0;
      for (const [key, kg] of Object.entries(lines))
        await env.db.insert(schema.mixDesignLines).values({
          tenantId: env.tenantId,
          designId: d!.id,
          materialId: mat[key]!,
          quantityKgM3: kg,
          originalQuantity: kg,
          originalUnit: 'kg/m3',
          originalName: key,
          sourceLine: ++i,
          matchMethod: 'exact',
        });
      return d!.id;
    },
  };
}

const setSettings = (settings: object) =>
  env.db
    .insert(schema.tenantSettings)
    .values({ tenantId: env.tenantId, settings })
    .onConflictDoUpdate({ target: schema.tenantSettings.tenantId, set: { settings } });
const designRow = async (id: string) =>
  (await env.db.select().from(schema.mixDesigns).where(eq(schema.mixDesigns.id, id)))[0]!;
const asRole = async (role: Parameters<TestEnv['seedUser']>[0], plantIds?: string[]) =>
  env.login((await env.seedUser(role, plantIds ? { plantIds } : {})).email);

describe('POST /api/designs/:id/evaluate', () => {
  it('evaluates a draft, runs the independent validator, stores both and moves it to evaluated (audited)', async () => {
    const w = await world('EV-A');
    const id = await w.design();
    const qc = await asRole('qc_engineer', [w.plantId]);
    const res = await qc.post(`/api/designs/${id}/evaluate`).send({ mode: 'ACI' });
    expect(res.status).toBe(200);
    expect(res.body.validator).toMatchObject({ status: 'pass', mismatches: [] });
    expect(res.body.report).toMatchObject({ verdict: 'pass', provisional: true });
    expect(res.body.report.cost.totalJodPerM3).toBe('44.023');
    expect(res.body.report.figures['volume.total']).toBeCloseTo(0.999918, 6);
    expect(res.body.design).toMatchObject({ status: 'evaluated', needsRevalidation: false });
    expect(res.body.transition).toEqual({ moved: true, blocker: null });

    const d = await designRow(id);
    expect(d).toMatchObject({
      status: 'evaluated',
      evaluationPending: false,
      lastVerdict: 'pass',
      needsRevalidation: false,
    });
    const evals = await env.db
      .select()
      .from(schema.designEvaluations)
      .where(eq(schema.designEvaluations.designId, id));
    expect(evals).toHaveLength(1);
    expect(evals[0]).toMatchObject({
      validatorStatus: 'pass',
      verdict: 'pass',
      mode: 'ACI',
      costJodPerM3: '44.023',
      evaluatorVersion: expect.any(String),
      validatorVersion: expect.any(String),
    });
    expect((evals[0]!.ruleVersions as unknown[]).length).toBeGreaterThan(10);
    expect(evals[0]!.priceBasis).toMatchObject({ kind: 'live' });
    const [tr] = await env.db
      .select()
      .from(schema.designTransitions)
      .where(eq(schema.designTransitions.designId, id));
    expect(tr).toMatchObject({
      fromStatus: 'draft',
      toStatus: 'evaluated',
      evidence: { kind: 'evaluation_verified', evaluationId: evals[0]!.id, validator: 'pass' },
    });
    const audit = (await env.auditRows()).filter(
      (a) => a.entityId === id && a.action === 'design.evaluate',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toMatchObject({
      status: 'evaluated',
      verdict: 'pass',
      validator: 'pass',
      evaluationId: evals[0]!.id,
    });
  });

  it('defaults to BOTH and says so; a second evaluation keeps the state and keeps the first one', async () => {
    const w = await world('EV-B');
    const id = await w.design();
    const qc = await asRole('qc_manager');
    const first = await qc.post(`/api/designs/${id}/evaluate`).send({});
    expect(first.body.evaluation.mode).toBe('BOTH');
    expect(first.body.report.mode).toBe('BOTH');
    const second = await qc.post(`/api/designs/${id}/evaluate`).send({ mode: 'ACI' });
    expect(second.body.design.status).toBe('evaluated');
    expect(second.body.transition.moved).toBe(false);
    const list = await qc.get(`/api/designs/${id}/evaluations`);
    expect(list.body.map((e: { mode: string }) => e.mode)).toEqual(['ACI', 'BOTH']);
    expect(
      await env.db
        .select()
        .from(schema.designTransitions)
        .where(eq(schema.designTransitions.designId, id)),
    ).toHaveLength(1);
  });

  it('a design that fails compliance is still evaluated: failures are shown, not hidden', async () => {
    const w = await world('EV-C');
    const id = await w.design({
      requirements: {
        fcMpa: 30,
        basis: 'cylinder',
        testAgeDays: 28,
        exposure: ['S2'],
        slumpMm: 100,
        nmasMm: 19,
        pumpable: false,
        airPct: 2,
      },
    });
    const res = await (
      await asRole('qc_manager')
    )
      .post(`/api/designs/${id}/evaluate`)
      .send({ mode: 'ACI' });
    expect(res.status).toBe(200);
    expect(res.body.report.verdict).toBe('fail');
    expect(res.body.report.checks.find((c: { id: string }) => c.id === 'max_wcm').status).toBe(
      'fail',
    );
    expect(res.body.design.status).toBe('evaluated');
  });

  it('missing minimum data keeps the design in draft and names the gap', async () => {
    const w = await world('EV-D', { skipTest: ['sand'] });
    const id = await w.design();
    const res = await (
      await asRole('qc_manager')
    )
      .post(`/api/designs/${id}/evaluate`)
      .send({ mode: 'ACI' });
    expect(res.status).toBe(200);
    expect(res.body.design.status).toBe('draft');
    expect(res.body.transition).toEqual({ moved: false, blocker: 'minimum_data_missing' });
    expect(res.body.report.minimumData.missing).toEqual([
      { materialId: w.mat['sand'], field: 'sg_ssd' },
    ]);
    expect(
      res.body.report.dataQuality.find((q: { code: string }) => q.code === 'test_missing'),
    ).toMatchObject({ severity: 'blocker', materialId: w.mat['sand'] });
    expect((await designRow(id)).evaluationPending).toBe(false);
    expect(
      await env.db
        .select()
        .from(schema.designTransitions)
        .where(eq(schema.designTransitions.designId, id)),
    ).toHaveLength(0);
  });

  it('a validator failure overrides the evaluator: the design stays draft and the disagreement is stored', async () => {
    const w = await world('EV-E');
    const id = await w.design();
    corrupt = true;
    try {
      const res = await (
        await asRole('qc_manager')
      )
        .post(`/api/designs/${id}/evaluate`)
        .send({ mode: 'ACI' });
      expect(res.status).toBe(200);
      expect(res.body.validator.status).toBe('fail');
      expect(
        res.body.validator.mismatches.map(
          (m: { kind: string; key: string }) => `${m.kind}:${m.key}`,
        ),
      ).toContain('figure_mismatch:ratio.wcm');
      expect(res.body.design.status).toBe('draft');
      expect(res.body.transition).toEqual({ moved: false, blocker: 'validator_failed' });
      const [e] = await env.db
        .select()
        .from(schema.designEvaluations)
        .where(eq(schema.designEvaluations.designId, id));
      expect(e).toMatchObject({ validatorStatus: 'fail' });
    } finally {
      corrupt = false;
    }
  });

  it('prices: the live price in force at the plant on the evaluation date; the basis is stored; a gap makes the cost incomplete', async () => {
    const w = await world('EV-F', { skipPrice: ['coarse'] });
    const id = await w.design();
    const qc = await asRole('qc_manager');
    const res = await qc
      .post(`/api/designs/${id}/evaluate`)
      .send({ mode: 'ACI', evaluationDate: '2026-10-01' });
    expect(res.body.report.cost).toMatchObject({
      state: 'incomplete',
      totalJodPerM3: null,
      basis: { kind: 'live', date: '2026-10-01' },
    });
    expect(res.body.report.cost.missing).toEqual([
      { materialId: w.mat['coarse'], reason: expect.stringMatching(/no price in force/) },
    ]);
    // the same date before any price was in force: nothing is priced
    const early = await qc
      .post(`/api/designs/${id}/evaluate`)
      .send({ mode: 'ACI', evaluationDate: '2025-06-01' });
    expect(
      early.body.report.cost.lines.every((l: { state: string }) => l.state === 'unavailable'),
    ).toBe(true);
  });

  it('a named price snapshot can be the basis', async () => {
    const w = await world('EV-G');
    const id = await w.design();
    const [snap] = await env.db
      .insert(schema.priceSnapshots)
      .values({
        tenantId: env.tenantId,
        name: 'Q3',
        asOf: '2026-09-30',
        plantIds: [w.plantId],
        lineCount: 5,
        contentHash: 'x',
      })
      .returning();
    for (const [key, t] of Object.entries(TESTS))
      await env.db.insert(schema.priceSnapshotLines).values({
        snapshotId: snap!.id,
        materialId: w.mat[key]!,
        plantId: w.plantId,
        supplierId,
        priceId: crypto.randomUUID(),
        status: 'ok',
        price: key === 'cem' ? '100' : t.price[0],
        unit: t.price[1],
        includesDelivery: true,
        effectiveFrom: '2026-01-01',
      });
    const res = await (
      await asRole('qc_manager')
    )
      .post(`/api/designs/${id}/evaluate`)
      .send({ mode: 'ACI', priceSnapshotId: snap!.id });
    expect(res.body.report.cost.basis).toMatchObject({ kind: 'snapshot', snapshotId: snap!.id });
    expect(
      res.body.report.cost.lines.find((l: { materialId: string }) => l.materialId === w.mat['cem'])
        .jod,
    ).toBe('35.000'); // 350 kg × 0.1 JOD/kg
    const missing = await (
      await asRole('qc_manager')
    )
      .post(`/api/designs/${id}/evaluate`)
      .send({ mode: 'ACI', priceSnapshotId: crypto.randomUUID() });
    expect(missing.status).toBe(404);
  });

  it('retired and superseded designs are not evaluated; unknown or malformed requests are rejected', async () => {
    const w = await world('EV-H');
    const qc = await asRole('qc_manager');
    for (const status of ['retired', 'superseded'] as const) {
      const id = await w.design({ status });
      expect((await qc.post(`/api/designs/${id}/evaluate`).send({})).status).toBe(409);
    }
    expect((await qc.post(`/api/designs/${crypto.randomUUID()}/evaluate`).send({})).status).toBe(
      404,
    );
    const id = await w.design();
    expect((await qc.post(`/api/designs/${id}/evaluate`).send({ mode: 'XYZ' })).status).toBe(400);
    expect((await qc.post(`/api/designs/${id}/evaluate`).send({ surprise: 1 })).status).toBe(400);
    expect((await qc.post(`/api/designs/not-a-uuid/evaluate`).send({})).status).toBe(400);
  });

  it('S3 needs its option, and project overrides can only tighten', async () => {
    const w = await world('EV-I');
    const id = await w.design({
      requirements: {
        fcMpa: 35,
        basis: 'cylinder',
        testAgeDays: 28,
        exposure: ['S3'],
        slumpMm: 100,
        nmasMm: 19,
        pumpable: false,
        airPct: 2,
      },
    });
    const qc = await asRole('qc_manager');
    const none = await qc.post(`/api/designs/${id}/evaluate`).send({ mode: 'ACI' });
    expect(none.body.report.verdict).not.toBe('pass');
    expect(
      none.body.report.dataQuality.some(
        (q: { code: string; severity: string }) =>
          q.code === 'context_missing' && q.severity === 'blocker',
      ),
    ).toBe(true);
    const opt = await qc.post(`/api/designs/${id}/evaluate`).send({ mode: 'ACI', s3Option: 1 });
    expect(opt.body.report.checks.find((c: { id: string }) => c.id === 'scm_required').status).toBe(
      'fail',
    );
    const w2 = await world('EV-J');
    const id2 = await w2.design({
      requirements: {
        fcMpa: 30,
        basis: 'cylinder',
        testAgeDays: 28,
        exposure: ['S1'],
        slumpMm: 100,
        nmasMm: 19,
        pumpable: false,
        airPct: 2,
      },
    });
    const tight = await qc
      .post(`/api/designs/${id2}/evaluate`)
      .send({ mode: 'ACI', projectOverrides: [{ requirement: 'max_wcm', value: 0.45 }] });
    expect(tight.body.report.checks.find((c: { id: string }) => c.id === 'max_wcm')).toMatchObject({
      limit: 0.45,
      status: 'fail',
    });
    const loose = await qc
      .post(`/api/designs/${id2}/evaluate`)
      .send({ mode: 'ACI', projectOverrides: [{ requirement: 'max_wcm', value: 0.6 }] });
    expect(loose.body.report.checks.find((c: { id: string }) => c.id === 'max_wcm').limit).toBe(
      0.5,
    );
    expect(loose.body.report.dataQuality.map((q: { code: string }) => q.code)).toContain(
      'override_rejected',
    );
  });
});

describe('attested designs', () => {
  const attested = async (w: World, requirements: object) =>
    w.design({
      status: 'in_production',
      approvalSource: 'legacy_attested',
      externalApprovalRef: 'Submittal 7',
      approvedBy: (await env.seedUser('qc_manager')).id,
      approvedAt: new Date('2025-03-01'),
      requirements,
    });

  it('keep their state; a failed hard check raises the revalidation flag, a clean one clears it', async () => {
    const w = await world('EV-K');
    const bad = await attested(w, {
      fcMpa: 30,
      basis: 'cylinder',
      testAgeDays: 28,
      exposure: ['S2'],
      slumpMm: 100,
      nmasMm: 19,
      pumpable: false,
      airPct: 2,
    });
    const qc = await asRole('qc_manager');
    const res = await qc.post(`/api/designs/${bad}/evaluate`).send({ mode: 'ACI' });
    expect(res.body.design).toMatchObject({ status: 'in_production', needsRevalidation: true });
    expect(res.body.transition.moved).toBe(false);
    expect(await designRow(bad)).toMatchObject({
      status: 'in_production',
      evaluationPending: false,
      needsRevalidation: true,
      approvalSource: 'legacy_attested',
    });
    expect(
      await env.db
        .select()
        .from(schema.designTransitions)
        .where(eq(schema.designTransitions.designId, bad)),
    ).toHaveLength(0);

    const flagged = await qc.get('/api/designs?revalidation=true');
    expect(flagged.body.map((d: { id: string }) => d.id)).toEqual([bad]);
    expect(flagged.body[0]).toMatchObject({ needsRevalidation: true, lastVerdict: 'fail' });

    const good = await attested(w, {
      fcMpa: 30,
      basis: 'cylinder',
      testAgeDays: 28,
      exposure: ['F0'],
      slumpMm: 100,
      nmasMm: 19,
      pumpable: false,
      airPct: 2,
    });
    const ok = await qc.post(`/api/designs/${good}/evaluate`).send({ mode: 'ACI' });
    expect(ok.body.design).toMatchObject({ status: 'in_production', needsRevalidation: false });
  });

  it('an unusable validator result leaves the flag as it was', async () => {
    const w = await world('EV-L');
    const id = await attested(w, {
      fcMpa: 30,
      basis: 'cylinder',
      testAgeDays: 28,
      exposure: ['S2'],
      slumpMm: 100,
      nmasMm: 19,
      pumpable: false,
      airPct: 2,
    });
    corrupt = true;
    try {
      const res = await (
        await asRole('qc_manager')
      )
        .post(`/api/designs/${id}/evaluate`)
        .send({ mode: 'ACI' });
      expect(res.body.validator.status).toBe('fail');
      expect(res.body.design.needsRevalidation).toBe(false);
    } finally {
      corrupt = false;
    }
  });

  it('an evaluated imported design can still be attested, through the lifecycle graph', async () => {
    const w = await world('EV-M');
    const [batch] = await env.db
      .insert(schema.legacyImportBatches)
      .values({
        tenantId: env.tenantId,
        filename: 'x.csv',
        rows: [],
        header: [],
        status: 'committed',
        createdBy: (await env.seedUser('qc_manager')).id,
      })
      .returning();
    const author = await env.seedUser('qc_manager');
    const id = await w.design({ importBatchId: batch!.id, createdBy: author.id });
    const qc = await asRole('qc_manager');
    expect(
      (await qc.post(`/api/designs/${id}/evaluate`).send({ mode: 'ACI' })).body.design.status,
    ).toBe('evaluated');
    const queue = await (await asRole('qc_manager')).get('/api/designs?queue=true');
    expect(queue.body.map((d: { id: string }) => d.id)).toContain(id);
    const attest = await (await asRole('qc_manager')).post(`/api/designs/${id}/attest`).send({
      approvalReference: 'Submittal 9',
      inProduction: false,
      note: 'approved by the plant QC',
    });
    expect(attest.status).toBe(200);
    expect(attest.body.status).toBe('approved');
    const trs = await env.db
      .select()
      .from(schema.designTransitions)
      .where(eq(schema.designTransitions.designId, id));
    expect(trs.map((t) => `${t.fromStatus}>${t.toStatus}`).sort()).toEqual([
      'draft>evaluated',
      'evaluated>approved',
    ]);
  });
});

describe('access, scope and what each role sees', () => {
  it('only QC roles evaluate; everyone with library.read can read evaluations', async () => {
    const w = await world('EV-N');
    const id = await w.design();
    for (const role of ['admin', 'procurement', 'sales', 'viewer', 'plant_manager'] as const) {
      const agent = await asRole(role, [w.plantId]);
      expect((await agent.post(`/api/designs/${id}/evaluate`).send({})).status, role).toBe(403);
      expect(
        (
          await agent
            .post('/api/characteristics/validate')
            .send({ designId: id, characteristics: {} })
        ).status,
        role,
      ).toBe(403);
    }
    await (await asRole('qc_manager')).post(`/api/designs/${id}/evaluate`).send({ mode: 'ACI' });
    for (const role of ['admin', 'procurement', 'sales', 'viewer'] as const)
      expect(
        (await (await asRole(role, [w.plantId])).get(`/api/designs/${id}/evaluations`)).status,
        role,
      ).toBe(200);
    const unassigned = await asRole('viewer');
    expect((await unassigned.get(`/api/designs/${id}/evaluations`)).status).toBe(404);
  });

  it('plant scoping: a plant manager sees evaluations of their own plant only (404 elsewhere)', async () => {
    const a = await world('EV-O1');
    const b = await world('EV-O2');
    const idA = await a.design();
    const idB = await b.design();
    const qc = await asRole('qc_manager');
    await qc.post(`/api/designs/${idA}/evaluate`).send({ mode: 'ACI' });
    await qc.post(`/api/designs/${idB}/evaluate`).send({ mode: 'ACI' });
    const pm = await asRole('plant_manager', [a.plantId]);
    expect((await pm.get(`/api/designs/${idA}/evaluations`)).status).toBe(200);
    expect((await pm.get(`/api/designs/${idB}/evaluations`)).status).toBe(404);
    const [e] = await env.db
      .select()
      .from(schema.designEvaluations)
      .where(eq(schema.designEvaluations.designId, idB));
    expect((await pm.get(`/api/designs/${idB}/evaluations/${e!.id}`)).status).toBe(404);
    expect((await pm.get(`/api/designs/${idA}/evaluations/${e!.id}`)).status).toBe(404); // another design's evaluation id
  });

  it('cost is stripped on the server for roles without cost.view (list, detail and evaluate response)', async () => {
    const w = await world('EV-P');
    const id = await w.design();
    const qc = await asRole('qc_manager');
    const done = await qc
      .post(`/api/designs/${id}/evaluate`)
      .send({ mode: 'ACI', characteristics: { max_cost_jod_m3: { mode: 'range', max: 100 } } });
    expect(done.body.report.cost.totalJodPerM3).toBe('44.023');
    expect(done.body.report.characteristics.rows.map((r: { key: string }) => r.key)).toContain(
      'max_cost_jod_m3',
    );
    const evalId = done.body.evaluation.id;

    const seeing = await (
      await asRole('plant_manager', [w.plantId])
    ).get(`/api/designs/${id}/evaluations/${evalId}`);
    expect(seeing.body.report.cost.totalJodPerM3).toBe('44.023');
    expect(seeing.body.priceBasis).toMatchObject({ kind: 'live' });
    expect(
      (await (await asRole('plant_manager', [w.plantId])).get(`/api/designs/${id}/evaluations`))
        .body[0].costJodPerM3,
    ).toBe('44.023');

    const blind = await asRole('viewer', [w.plantId]);
    const detail = await blind.get(`/api/designs/${id}/evaluations/${evalId}`);
    const text = JSON.stringify(detail.body);
    expect(detail.body.report.cost).toMatchObject({ totalJodPerM3: null, lines: [], missing: [] });
    expect(Object.keys(detail.body.report.figures).filter((k) => k.startsWith('cost.'))).toEqual(
      [],
    );
    expect(detail.body.report.trace.some((t: { key: string }) => t.key.startsWith('cost.'))).toBe(
      false,
    );
    expect(
      detail.body.report.characteristics.rows.map((r: { key: string }) => r.key),
    ).not.toContain('max_cost_jod_m3');
    expect(detail.body.priceBasis).toBeNull();
    expect(text).not.toContain('44.023');
    expect(text).not.toContain('26.250'); // the cement line
    expect((await blind.get(`/api/designs/${id}/evaluations`)).body[0].costJodPerM3).toBeNull();
    // sales only with the setting
    const sales = await asRole('sales', [w.plantId]);
    expect(
      (await sales.get(`/api/designs/${id}/evaluations/${evalId}`)).body.report.cost.totalJodPerM3,
    ).toBeNull();
    await setSettings({ salesCanViewCost: true });
    expect(
      (await sales.get(`/api/designs/${id}/evaluations/${evalId}`)).body.report.cost.totalJodPerM3,
    ).toBe('44.023');
    await setSettings({});
  });
});

describe('stored evaluations are immutable and honest about changed inputs', () => {
  it('the database rejects UPDATE and DELETE of a stored evaluation', async () => {
    const w = await world('EV-Q');
    const id = await w.design();
    await (await asRole('qc_manager')).post(`/api/designs/${id}/evaluate`).send({ mode: 'ACI' });
    const [e] = await env.db
      .select()
      .from(schema.designEvaluations)
      .where(eq(schema.designEvaluations.designId, id));
    await expect(
      env.pool.query(`UPDATE design_evaluations SET verdict = 'pass' WHERE id = $1`, [e!.id]),
    ).rejects.toThrow(/append-only|immutable|not allowed/i);
    await expect(
      env.pool.query(`DELETE FROM design_evaluations WHERE id = $1`, [e!.id]),
    ).rejects.toThrow();
    await expect(
      env.pool.query(`UPDATE design_evaluations SET report = '[]'::jsonb WHERE id = $1`, [e!.id]),
    ).rejects.toThrow();
    await expect(
      env.pool.query(`UPDATE mix_designs SET last_verdict = NULL WHERE id = $1`, [id]),
    ).rejects.toThrow(/last_evaluation_consistent/);
  });

  it('a newer material test shows up as "inputs changed since this evaluation" without recomputing anything', async () => {
    const w = await world('EV-R');
    const id = await w.design();
    const qc = await asRole('qc_manager');
    const done = await qc.post(`/api/designs/${id}/evaluate`).send({ mode: 'ACI' });
    const before = await qc.get(`/api/designs/${id}/evaluations/${done.body.evaluation.id}`);
    expect(before.body.inputsChanged).toEqual({ materials: [], rules: 0 });
    await env.db
      .update(schema.materialTests)
      .set({ isCurrent: false, supersededAt: new Date() })
      .where(
        and(
          eq(schema.materialTests.materialId, w.mat['sand']!),
          eq(schema.materialTests.isCurrent, true),
        ),
      );
    await env.db.insert(schema.materialTests).values({
      tenantId: env.tenantId,
      materialId: w.mat['sand']!,
      version: 2,
      isCurrent: true,
      source: 'supplier_datasheet',
      properties: TESTS['sand']!.props,
      testedAt: '2026-09-15',
    });
    const after = await qc.get(`/api/designs/${id}/evaluations/${done.body.evaluation.id}`);
    expect(after.body.inputsChanged.materials).toEqual([
      { materialId: w.mat['sand'], evaluated: 1, current: 2 },
    ]);
    expect(after.body.report).toEqual(before.body.report); // the stored report did not change
    expect(after.body.snapshot.design.id).toBe(id);
  });
});

describe('characteristics: the API cannot be used to bypass the form', () => {
  const S2 = {
    fcMpa: 30,
    basis: 'cylinder',
    testAgeDays: 28,
    exposure: ['S2'],
    slumpMm: 100,
    nmasMm: 19,
    pumpable: false,
    airPct: 2,
  };
  const F3 = {
    fcMpa: 40,
    basis: 'cylinder',
    testAgeDays: 28,
    exposure: ['F3'],
    slumpMm: 100,
    nmasMm: 19,
    pumpable: false,
    airPct: 6,
  };

  it('every limit-backed characteristic that would loosen a hard limit is rejected with rule, clause and bound', async () => {
    const w = await world('EV-S');
    const s2 = await w.design({ requirements: S2 });
    const f3 = await w.design({ requirements: F3 });
    const qc = await asRole('qc_manager');
    const post = (id: string, characteristics: object, extra: object = {}) =>
      qc
        .post('/api/characteristics/validate')
        .send({ designId: id, mode: 'ACI', characteristics, ...extra });

    const wcm = await post(s2, { wcm: { mode: 'fixed', value: 0.5 } });
    expect(wcm.status).toBe(200);
    expect(wcm.body.ok).toBe(false);
    expect(wcm.body.rejected[0]).toMatchObject({
      key: 'wcm',
      code: 'override_loosens',
      allowed: 0.45,
      rule: 'durability.S2.max_wcm',
      clause: 'ACI 318-19 Table 19.3.2.1',
      source: 'ACI',
    });

    const fcr = await post(s2, { fcr_mpa: { mode: 'fixed', value: 20 } });
    expect(fcr.body.rejected[0]).toMatchObject({ key: 'fcr_mpa', allowed: 38.3 });

    const air = await post(f3, { air_pct: { mode: 'fixed', value: 2 } });
    expect(air.body.rejected[0]).toMatchObject({
      key: 'air_pct',
      allowed: [4.5, 7.5],
      code: 'override_loosens',
    });

    const dose = await post(s2, {
      admixture: { mode: 'fixed', product: w.mat['sp'], dosage_pct: 5 },
    });
    expect(dose.body.rejected[0]).toMatchObject({
      key: 'admixture',
      code: 'outside_product_range',
    });

    const ok = await post(s2, {
      wcm: { mode: 'fixed', value: 0.4 },
      cement_kg: { mode: 'range', min: 330 },
    });
    expect(ok.body).toMatchObject({ ok: true, rejected: [], invalid: [] });
    expect(ok.body.characteristics.map((c: { key: string }) => c.key)).toEqual([
      'cement_kg',
      'wcm',
    ]);

    const bad = await post(s2, { wcm: { mode: 'range' } });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.invalid.length).toBeGreaterThan(0);
    const unknownKey = await post(s2, { turbo: { mode: 'fixed', value: 1 } });
    expect(unknownKey.body.ok).toBe(false);
  });

  it('SCM percentage above the code limit is rejected for the SCM it names', async () => {
    const w = await world('EV-T');
    const [fa] = await env.db
      .insert(schema.materials)
      .values({
        tenantId: env.tenantId,
        plantId: w.plantId,
        category: 'scm',
        marketNameEn: 'Fly ash EV-T',
      })
      .returning();
    await env.db.insert(schema.materialTests).values({
      tenantId: env.tenantId,
      materialId: fa!.id,
      version: 1,
      isCurrent: true,
      source: 'supplier_datasheet',
      properties: { scm_type: 'fly_ash', sg: 2.2 },
      testedAt: '2026-08-01',
    });
    const id = await w.design({ requirements: F3 });
    await env.db.insert(schema.mixDesignLines).values({
      tenantId: env.tenantId,
      designId: id,
      materialId: fa!.id,
      quantityKgM3: '50.000',
      originalQuantity: '50.000',
      originalUnit: 'kg/m3',
      originalName: 'fa',
      sourceLine: 99,
      matchMethod: 'exact',
    });
    const qc = await asRole('qc_manager');
    const res = await qc.post('/api/characteristics/validate').send({
      designId: id,
      mode: 'ACI',
      characteristics: { scm: { mode: 'fixed', product: fa!.id, pct: 30 } },
    });
    expect(res.body.rejected[0]).toMatchObject({
      key: 'scm',
      allowed: 25,
      rule: 'scm.max.fly_ash_pozzolan_pct',
    });
  });

  it('POST evaluate rejects the same payload (400, nothing stored); an accepted payload is reported as requested vs achieved', async () => {
    const w = await world('EV-U');
    const id = await w.design({ requirements: S2 });
    const qc = await asRole('qc_manager');
    const rejected = await qc
      .post(`/api/designs/${id}/evaluate`)
      .send({ mode: 'ACI', characteristics: { wcm: { mode: 'fixed', value: 0.5 } } });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('characteristics_rejected');
    expect(rejected.body.error.details.rejected[0]).toMatchObject({
      key: 'wcm',
      allowed: 0.45,
      rule: 'durability.S2.max_wcm',
    });
    expect(
      await env.db
        .select()
        .from(schema.designEvaluations)
        .where(eq(schema.designEvaluations.designId, id)),
    ).toHaveLength(0);
    expect((await designRow(id)).status).toBe('draft');
    const malformed = await qc
      .post(`/api/designs/${id}/evaluate`)
      .send({ mode: 'ACI', characteristics: { wcm: { mode: 'range' } } });
    expect(malformed.status).toBe(400);

    const accepted = await qc.post(`/api/designs/${id}/evaluate`).send({
      mode: 'ACI',
      characteristics: {
        wcm: { mode: 'range', max: 0.45 },
        binder_kg: { mode: 'fixed', value: 350 },
      },
    });
    expect(accepted.status).toBe(200);
    const rows = accepted.body.report.characteristics.rows;
    expect(rows.find((r: { key: string }) => r.key === 'wcm')).toMatchObject({
      status: 'deviated',
      klass: 'USER_SPECIFIED',
      origin: 'request',
      requested: '≤ 0.45',
    });
    expect(rows.find((r: { key: string }) => r.key === 'binder_kg')).toMatchObject({
      status: 'met',
      achieved: 350,
    });
    expect(accepted.body.validator.status).toBe('pass');
  });

  it('the validate endpoint writes nothing and can be audited as a read-only POST', async () => {
    const w = await world('EV-V');
    const id = await w.design();
    const qc = await asRole('qc_manager');
    const before = (await env.auditRows()).length;
    await qc
      .post('/api/characteristics/validate')
      .send({ designId: id, characteristics: { wcm: { mode: 'fixed', value: 0.4 } } });
    expect((await env.auditRows()).length).toBe(before);
    expect(
      (
        await qc
          .post('/api/characteristics/validate')
          .send({ designId: crypto.randomUUID(), characteristics: {} })
      ).status,
    ).toBe(404);
  });
});

describe('settings feed the evaluation', () => {
  it('safety margin, near-limit percentage and yield tolerance come from tenant settings and are stored in the snapshot', async () => {
    const w = await world('EV-W');
    const id = await w.design({
      requirements: {
        fcMpa: 30,
        basis: 'cylinder',
        testAgeDays: 28,
        exposure: ['S1'],
        slumpMm: 100,
        nmasMm: 19,
        pumpable: false,
        airPct: 2,
      },
    });
    const admin = await asRole('admin');
    expect(
      (
        await admin
          .patch('/api/settings')
          .send({ nearLimitPct: 5, safetyMarginMpa: 1.5, yieldTolerance: 0.004 })
      ).status,
    ).toBe(200);
    expect((await admin.patch('/api/settings').send({ nearLimitPct: 80 })).status).toBe(400);
    expect((await admin.patch('/api/settings').send({ yieldTolerance: 0 })).status).toBe(400);
    const res = await (
      await asRole('qc_manager')
    )
      .post(`/api/designs/${id}/evaluate`)
      .send({ mode: 'ACI' });
    expect(res.body.report.strength).toMatchObject({
      safetyMarginMpa: 1.5,
      marginConfigured: true,
      fcrMpa: 39.8,
    });
    const check = res.body.report.checks.find((c: { id: string }) => c.id === 'yield');
    expect(check.limit).toBe(0.004);
    const [e] = await env.db
      .select()
      .from(schema.designEvaluations)
      .where(eq(schema.designEvaluations.designId, id));
    expect((e!.snapshot as { settings: unknown }).settings).toMatchObject({
      nearLimitPct: 5,
      safetyMarginMpa: 1.5,
      yieldTolerance: 0.004,
    });
    await admin
      .patch('/api/settings')
      .send({ nearLimitPct: null, safetyMarginMpa: null, yieldTolerance: 0.005 });
  });
});
