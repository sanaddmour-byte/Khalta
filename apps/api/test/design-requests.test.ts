import { schema } from '@khalta/db';
import { OPT_MATERIALS, syntheticRules } from '@khalta/engine/testing/optimizer';
import { loadSeeds } from '@khalta/rules/loader';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncRules } from '../src/rules/service';
import { createTestEnv, type TestEnv } from './helpers';
import { makeSupplier } from './world';

// SYNTHETIC world: invented materials and engineering parameters (see engine/src/testing/optimizer.ts).
let env: TestEnv;
let plantA: string;
let plantB: string;
let mat: Record<string, string>;
const REQUIREMENTS = {
  fcMpa: 30,
  basis: 'cylinder',
  exposure: ['F0', 'S0', 'W0', 'C1'],
  slumpMm: 100,
  nmasMm: 19,
};

async function seedMaterials(plantId: string, supplierId: string) {
  const ids: Record<string, string> = {};
  for (const m of OPT_MATERIALS) {
    const [row] = await env.db
      .insert(schema.materials)
      .values({
        tenantId: env.tenantId,
        plantId,
        category: m.category,
        marketNameEn: `${m.id} ${plantId.slice(0, 4)}`,
        marketNameAr: `${m.id} ${plantId.slice(0, 4)}`,
      })
      .returning();
    ids[m.id] = row!.id;
    await env.db.insert(schema.materialTests).values({
      tenantId: env.tenantId,
      materialId: row!.id,
      version: 1,
      isCurrent: true,
      source: 'supplier_datasheet',
      properties: m.test!.properties,
      testedAt: '2026-08-01',
    });
    const p = m.price as { status: 'ok'; price: string; unit: 'JOD/ton' | 'JOD/kg' };
    await env.db.insert(schema.materialPrices).values({
      tenantId: env.tenantId,
      materialId: row!.id,
      plantId,
      supplierId,
      price: p.price,
      unit: p.unit,
      effectiveFrom: '2026-01-01',
    });
  }
  return ids;
}

beforeAll(async () => {
  env = await createTestEnv();
  const seeds = loadSeeds();
  await env.withAudit(env.db, { tenantId: env.tenantId, actor: null, requestId: 'seed' }, (tx, a) =>
    syncRules(tx, a, env.tenantId, { ...seeds, rules: syntheticRules(seeds.rules) }),
  );
  const supplierId = await makeSupplier(env);
  plantA = (await env.seedPlant('OPT-A')).id;
  plantB = (await env.seedPlant('OPT-B')).id;
  mat = await seedMaterials(plantA, supplierId);
}, 120_000);
afterAll(() => env.close());

const as = async (role: Parameters<TestEnv['seedUser']>[0], plantIds: string[] = []) =>
  env.login((await env.seedUser(role, { plantIds })).email);

describe('POST /api/design-requests', () => {
  it('returns validated candidates, cheapest first, with the evidence labels and a stored record', async () => {
    const m = await as('qc_manager');
    const res = await m
      .post('/api/design-requests')
      .send({ plantId: plantA, mode: 'ACI', requirements: REQUIREMENTS });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('candidates');
    expect(res.body.candidates).toHaveLength(5);
    const costs = res.body.candidates.map((c: { costJodPerM3: string }) => Number(c.costJodPerM3));
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
    for (const c of res.body.candidates) {
      expect(c.validator.status).toBe('pass');
      expect(c.report.verdict).toBe('pass');
      expect(c.evidence).toEqual(expect.arrayContaining(['MODEL_BASELINE', 'TRIAL_REQUIRED']));
      expect(c.guardrails.coarsenessFactor).toBeGreaterThan(45);
    }
    const [req] = await env.db
      .select()
      .from(schema.designRequests)
      .where(eq(schema.designRequests.id, res.body.id));
    expect(req).toMatchObject({ status: 'candidates', solver: 'highs-wasm', plantId: plantA });
    const audit = (await env.auditRows()).filter((r) => r.action === 'design_request.create');
    expect(audit.length).toBeGreaterThan(0);
  });

  it('is blocked, with every missing parameter named, when the shipped seeds are used as they are', async () => {
    const e2 = await createTestEnv({}, { seedRules: true });
    try {
      const sup = await e2.db
        .insert(schema.suppliers)
        .values({ tenantId: e2.tenantId, nameAr: 'مورد', nameEn: 'S' })
        .returning();
      const plant = (await e2.seedPlant('SEED-ONLY')).id;
      // reuse the helper against the other environment
      const saved = env;
      env = e2;
      await seedMaterials(plant, sup[0]!.id);
      env = saved;
      const m = await e2.login((await e2.seedUser('qc_manager')).email);
      const res = await m
        .post('/api/design-requests')
        .send({ plantId: plant, mode: 'ACI', requirements: REQUIREMENTS });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('blocked');
      expect(res.body.candidates).toHaveLength(0);
      const subjects = res.body.outcome.blockers.map((b: { subject: string }) => b.subject);
      expect(subjects).toEqual(
        expect.arrayContaining([
          'eng.grading.target.band_pct',
          'eng.fines.max_pct_75um',
          'ACI:grading.fine.limits',
        ]),
      );
    } finally {
      await e2.close();
    }
  });

  it('needs design.write and the plant', async () => {
    const proc = await as('procurement');
    expect(
      (
        await proc
          .post('/api/design-requests')
          .send({ plantId: plantA, requirements: REQUIREMENTS })
      ).status,
    ).toBe(403);
    const other = await as('qc_engineer', [plantB]);
    expect(
      (
        await other
          .post('/api/design-requests')
          .send({ plantId: plantA, requirements: REQUIREMENTS })
      ).status,
    ).toBe(404);
  });

  it('rejects characteristics that loosen a limit, or are not characteristics at all', async () => {
    const m = await as('qc_manager');
    const bad = await m.post('/api/design-requests').send({
      plantId: plantA,
      requirements: REQUIREMENTS,
      characteristics: { not_a_characteristic: { mode: 'fixed', value: 1 } },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('characteristics_rejected');
  });

  it('honours characteristics, include/exclude and the objective', async () => {
    const m = await as('qc_manager');
    const res = await m.post('/api/design-requests').send({
      plantId: plantA,
      mode: 'ACI',
      objective: 'closest_to_targets',
      requirements: REQUIREMENTS,
      characteristics: {
        binder_kg: { mode: 'target', value: 380 },
        agg_kg: { [mat['c20']!]: { mode: 'fixed', value: 700 } },
      },
      materials: { exclude: [mat['fly']!] },
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('candidates');
    for (const c of res.body.candidates) {
      const ids = c.lines.map((l: { materialId: string }) => l.materialId);
      expect(ids).not.toContain(mat['fly']);
      const row = c.characteristics.find((r: { key: string }) => r.key === `agg_kg.${mat['c20']}`);
      expect(row.status).toBe('met');
    }
    expect(
      res.body.outcome.excluded.some((x: { materialId: string }) => x.materialId === mat['fly']),
    ).toBe(true);
  });

  it('names the conflict between user-specified values instead of returning a design', async () => {
    const m = await as('qc_manager');
    const res = await m.post('/api/design-requests').send({
      plantId: plantA,
      mode: 'ACI',
      requirements: REQUIREMENTS,
      characteristics: { binder_kg: { mode: 'range', max: 200 } },
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('infeasible');
    expect(res.body.outcome.conflicts.kind).toBe('user_specified');
    expect(res.body.outcome.conflicts.items[0]).toMatchObject({ id: 'binder_kg', unit: 'kg/m3' });
    expect(res.body.outcome.conflicts.items[0].relaxBy).toBeGreaterThan(0);
    expect(res.body.candidates).toHaveLength(0);
  });
});

describe('reading requests', () => {
  it('hides money from roles without cost.view and respects plants', async () => {
    const m = await as('qc_manager');
    const made = await m
      .post('/api/design-requests')
      .send({ plantId: plantA, mode: 'ACI', requirements: REQUIREMENTS });
    const sales = await as('sales', [plantA]);
    const seen = await sales.get(`/api/design-requests/${made.body.id}`);
    expect(seen.status).toBe(200);
    const c = seen.body.candidates[0];
    expect(c.costJodPerM3).toBeNull();
    expect(c.binding).toEqual([]);
    expect(JSON.stringify(seen.body)).not.toContain('cost.total');
    const elsewhere = await as('plant_manager', [plantB]);
    expect((await elsewhere.get(`/api/design-requests/${made.body.id}`)).status).toBe(404);
    const list = await m.get(`/api/design-requests?plantId=${plantA}`);
    expect(list.body.length).toBeGreaterThan(0);
  });

  it('keeps requests and candidates append-only', async () => {
    const [cand] = await env.db.select().from(schema.designCandidates).limit(1);
    await expect(
      env.db
        .update(schema.designCandidates)
        .set({ rank: 9 })
        .where(eq(schema.designCandidates.id, cand!.id)),
    ).rejects.toThrow();
    await expect(
      env.db.delete(schema.designRequests).where(eq(schema.designRequests.id, cand!.requestId)),
    ).rejects.toThrow();
  });
});

describe('trial candidates', () => {
  it('turns one validated candidate into a trial-candidate design, never an approved one', async () => {
    const m = await as('qc_manager');
    const made = await m
      .post('/api/design-requests')
      .send({ plantId: plantA, mode: 'ACI', requirements: REQUIREMENTS });
    const c = made.body.candidates[0];
    const eng = await as('qc_engineer', [plantA]);
    const res = await eng
      .post(`/api/design-requests/${made.body.id}/candidates/${c.id}/trial-candidate`)
      .send({ code: 'OPT-C30-1', name: 'Optimizer C30' });
    expect(res.status).toBe(201);
    expect(res.body.design.status).toBe('trial_candidate');
    const [d] = await env.db
      .select()
      .from(schema.mixDesigns)
      .where(eq(schema.mixDesigns.id, res.body.design.id));
    expect(d).toMatchObject({
      status: 'trial_candidate',
      approvalSource: null,
      sourceCandidateId: c.id,
      lastVerdict: 'pass',
    });
    const trs = await env.db
      .select()
      .from(schema.designTransitions)
      .where(eq(schema.designTransitions.designId, d!.id));
    expect(trs.map((t) => `${t.fromStatus}>${t.toStatus}`)).toEqual([
      'none>draft',
      'draft>evaluated',
      'evaluated>trial_candidate',
    ]);
    expect(trs[2]!.evidence).toMatchObject({
      kind: 'validated_candidate',
      candidateValidator: 'pass',
    });
    // the second time is refused, and the source candidate cannot be re-pointed
    const again = await eng
      .post(`/api/design-requests/${made.body.id}/candidates/${c.id}/trial-candidate`)
      .send({ code: 'OPT-C30-2', name: 'Again' });
    expect(again.status).toBe(409);
    await expect(
      env.db
        .update(schema.mixDesigns)
        .set({ sourceCandidateId: null })
        .where(eq(schema.mixDesigns.id, d!.id)),
    ).rejects.toThrow();
    const shown = await m.get(`/api/design-requests/${made.body.id}`);
    expect(shown.body.candidates[0].design).toMatchObject({ code: 'OPT-C30-1' });
  });

  it('refuses roles without trial.request and unknown candidates', async () => {
    const m = await as('qc_manager');
    const made = await m
      .post('/api/design-requests')
      .send({ plantId: plantA, mode: 'ACI', requirements: REQUIREMENTS });
    const pm = await as('plant_manager', [plantA]);
    const c = made.body.candidates[1];
    expect(
      (
        await pm
          .post(`/api/design-requests/${made.body.id}/candidates/${c.id}/trial-candidate`)
          .send({ code: 'OPT-X', name: 'XX' })
      ).status,
    ).toBe(403);
    expect(
      (
        await m
          .post(`/api/design-requests/${made.body.id}/candidates/${made.body.id}/trial-candidate`)
          .send({ code: 'OPT-Y', name: 'YY' })
      ).status,
    ).toBe(404);
  });

  it('needs a QC manager and a reason when the candidate is predicted to fall short of the baseline', async () => {
    const m = await as('qc_manager');
    const made = await m.post('/api/design-requests').send({
      plantId: plantA,
      mode: 'ACI',
      requirements: REQUIREMENTS,
      characteristics: { wcm: { mode: 'fixed', value: 0.5 } },
    });
    expect(made.body.status).toBe('candidates');
    const c = made.body.candidates[0];
    expect(c.requiresAuthorization).toBe(true);
    expect(c.evidence).toContain('MODEL_PREDICTS_SHORTFALL');
    const url = `/api/design-requests/${made.body.id}/candidates/${c.id}/trial-candidate`;
    const eng = await as('qc_engineer', [plantA]);
    const denied = await eng.post(url).send({ code: 'OPT-S1', name: 'Shortfall' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('authorization_required');
    const noReason = await m.post(url).send({ code: 'OPT-S1', name: 'Shortfall' });
    expect(noReason.status).toBe(400);
    const ok = await m.post(url).send({
      code: 'OPT-S1',
      name: 'Shortfall',
      authorizationReason: 'Trial to confirm w/cm 0.50',
    });
    expect(ok.status).toBe(201);
    const trs = await env.db
      .select()
      .from(schema.designTransitions)
      .where(eq(schema.designTransitions.designId, ok.body.design.id));
    expect(trs.at(-1)!.evidence).toMatchObject({
      authorization: { reason: 'Trial to confirm w/cm 0.50' },
    });
  });
});

describe('Studio endpoints', () => {
  it('preflight: pool with reasons, live limits, characteristics check, named blockers; writes nothing', async () => {
    const m = await as('qc_manager');
    const before = await env.db.select().from(schema.designRequests);
    const ok = await m.post('/api/design-requests/preflight').send({
      plantId: plantA,
      mode: 'ACI',
      requirements: { ...REQUIREMENTS, exposure: ['F0', 'S1', 'W0', 'C1'] },
    });
    expect(ok.status).toBe(200);
    const cemI = ok.body.pool.find((p: { id: string }) => p.id === mat['cem-i']);
    expect(cemI.usable).toBe(false);
    expect(cemI.reason).toContain('sulfate');
    expect(ok.body.pool.find((p: { id: string }) => p.id === mat['cem-sr']).usable).toBe(true);
    const wcm = ok.body.bounds.find((b: { requirement: string }) => b.requirement === 'max_wcm');
    expect(wcm).toMatchObject({ value: 0.5, source: 'ACI', verified: false });
    expect(ok.body.baseline.wc).toBeGreaterThan(0.4);
    expect(ok.body.characteristics.ok).toBe(true);
    const bad = await m.post('/api/design-requests/preflight').send({
      plantId: plantA,
      mode: 'ACI',
      requirements: { ...REQUIREMENTS, exposure: ['F0', 'S1', 'W0', 'C1'] },
      characteristics: { wcm: { mode: 'fixed', value: 0.7 } },
    });
    expect(bad.body.characteristics.ok).toBe(false);
    expect(JSON.stringify(bad.body.characteristics.rejected)).toContain('0.5');
    const blocked = await m.post('/api/design-requests/preflight').send({
      plantId: plantA,
      mode: 'ACI',
      requirements: { ...REQUIREMENTS, exposure: ['F2', 'S0', 'W0', 'C1'] },
    });
    expect(blocked.body.blockers[0].code).toBe('not_supported');
    expect(await env.db.select().from(schema.designRequests)).toHaveLength(before.length);
    expect(
      (
        await (
          await as('procurement')
        )
          .post('/api/design-requests/preflight')
          .send({ plantId: plantA, requirements: REQUIREMENTS })
      ).status,
    ).toBe(403);
  });

  it('evaluate-mix evaluates a typed mix with the validator and stores nothing; cost only with cost.view', async () => {
    const m = await as('qc_manager');
    const lines = [
      ['cem-i', '350.000'],
      ['water', '175.000'],
      ['sand', '780.000'],
      ['c20', '1035.000'],
    ].map(([k, kg]) => ({ materialId: mat[k!]!, kgPerM3: kg! }));
    const res = await m
      .post('/api/design-requests/evaluate-mix')
      .send({ plantId: plantA, mode: 'ACI', requirements: REQUIREMENTS, lines });
    expect(res.status).toBe(200);
    expect(res.body.validator.status).toBe('pass');
    expect(res.body.report.cost.totalJodPerM3).not.toBeNull();
    const dupes = await m
      .post('/api/design-requests/evaluate-mix')
      .send({ plantId: plantA, requirements: REQUIREMENTS, lines: [lines[0], lines[0]] });
    expect(dupes.status).toBe(400);
  });

  it('POST /api/designs saves a typed mix as a draft, once per code, never approved', async () => {
    const eng = await as('qc_engineer', [plantA]);
    const lines = [
      ['cem-i', '350.000'],
      ['water', '175.000'],
      ['sand', '780.000'],
      ['c20', '1035.000'],
    ].map(([k, kg]) => ({ materialId: mat[k!]!, kgPerM3: kg! }));
    const body = {
      plantId: plantA,
      mode: 'ACI',
      requirements: REQUIREMENTS,
      lines,
      code: 'STUDIO-1',
      name: 'Typed mix',
    };
    const res = await eng.post('/api/designs').send(body);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect((await eng.post('/api/designs').send(body)).status).toBe(409);
    const [d] = await env.db
      .select()
      .from(schema.mixDesigns)
      .where(eq(schema.mixDesigns.id, res.body.id));
    expect(d).toMatchObject({
      status: 'draft',
      approvalSource: null,
      createdBy: expect.any(String),
    });
    expect(
      (
        await (
          await as('plant_manager', [plantA])
        )
          .post('/api/designs')
          .send({ ...body, code: 'STUDIO-2' })
      ).status,
    ).toBe(403);
  });

  it('compare-plants runs the request per plant with a confirmed mapping and skips what cannot be mapped', async () => {
    const supplier = await makeSupplier(env);
    const mapB = await seedMaterials(plantB, supplier);
    const m = await as('qc_manager');
    const res = await m.post('/api/design-requests/compare-plants').send({
      mode: 'ACI',
      requirements: REQUIREMENTS,
      materials: { exclude: [mat['fly']!] },
      plants: [{ plantId: plantA }, { plantId: plantB, mapping: { [mat['fly']!]: mapB['fly']! } }],
    });
    expect(res.status).toBe(201);
    expect(res.body.results).toHaveLength(2);
    for (const r of res.body.results) {
      expect(r.status).toBe('candidates');
      expect(r.best.costJodPerM3).not.toBeNull();
    }
    const skipped = await m.post('/api/design-requests/compare-plants').send({
      mode: 'ACI',
      requirements: REQUIREMENTS,
      materials: { exclude: [mat['fly']!] },
      plants: [{ plantId: plantB, mapping: { [mat['fly']!]: null } }],
    });
    expect(skipped.body.results[0]).toMatchObject({ status: 'skipped' });
    expect(skipped.body.results[0].reason).toContain('no_counterpart');
    const other = await as('qc_engineer', [plantA]);
    const denied = await other
      .post('/api/design-requests/compare-plants')
      .send({ mode: 'ACI', requirements: REQUIREMENTS, plants: [{ plantId: plantB }] });
    expect(denied.body.results[0].reason).toBe('plant_not_accessible');
  });
});

describe('what-if (ad-hoc) materials', () => {
  it('can win a request, are labelled user-declared, and cannot become a design until promoted', async () => {
    const m = await as('qc_manager');
    const res = await m.post('/api/design-requests').send({
      plantId: plantA,
      mode: 'ACI',
      requirements: REQUIREMENTS,
      adHoc: [
        {
          category: 'cement',
          market_name_en: 'Offer cement',
          properties: { sg: 3.15, c3a_pct: 9 },
          price_jod_per_kg: '0.050',
        },
      ],
    });
    expect(res.status).toBe(201);
    const c = res.body.candidates[0];
    expect(c.lines.some((l: { materialId: string }) => l.materialId === 'adhoc-1')).toBe(true);
    expect(c.evidence).toContain('INPUT_USER_DECLARED');
    const t = await m
      .post(`/api/design-requests/${res.body.id}/candidates/${c.id}/trial-candidate`)
      .send({ code: 'OPT-ADHOC', name: 'Adhoc' });
    expect(t.status).toBe(409);
    expect(t.body.error.code).toBe('adhoc_material');
    const bad = await m.post('/api/design-requests').send({
      plantId: plantA,
      requirements: REQUIREMENTS,
      adHoc: [
        {
          category: 'cement',
          market_name_en: 'x',
          properties: { sg: 3.15 },
          price_jod_per_kg: '0.0501',
        },
      ],
    });
    expect(bad.status).toBe(400);
  });
});
