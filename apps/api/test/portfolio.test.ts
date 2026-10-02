import { schema } from '@khalta/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';
import { attestedValues, LINES, makeSupplier, makeWorld, REQ } from './world';

let env: TestEnv;
let supplierId: string;
beforeAll(async () => {
  env = await createTestEnv({}, { seedRules: true });
  supplierId = await makeSupplier(env);
});
afterAll(() => env.close());

const manager = async () => env.login((await env.seedUser('qc_manager')).email);
const as = async (role: Parameters<TestEnv['seedUser']>[0], plantIds: string[]) =>
  env.login((await env.seedUser(role, { plantIds })).email);
const lineBody = (w: { mat: Record<string, string> }, over: Record<string, string> = {}) =>
  Object.entries({ ...LINES, ...over }).map(([k, kgPerM3]) => ({ materialId: w.mat[k]!, kgPerM3 }));

describe('manual versions', () => {
  it('create the next version as a draft and never touch the source (even an attested one)', async () => {
    const w = await makeWorld(env, supplierId, 'VR-A');
    const src = await w.design(await attestedValues(env));
    const m = await manager();
    const res = await m.post(`/api/designs/${src}/versions`).send({
      note: 'Less cement',
      lines: lineBody(w, { cem: '340.000' }),
      requirements: { slumpMm: 120 },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ version: 2, status: 'draft' });
    const [orig] = await env.db
      .select()
      .from(schema.mixDesigns)
      .where(eq(schema.mixDesigns.id, src));
    expect(orig).toMatchObject({
      status: 'in_production',
      version: 1,
      approvalSource: 'legacy_attested',
    });
    const [v] = await env.db
      .select()
      .from(schema.mixDesigns)
      .where(eq(schema.mixDesigns.id, res.body.id));
    expect(v).toMatchObject({
      parentDesignId: src,
      approvalSource: null,
      evaluationPending: true,
      avgMonthlyVolumeM3: '1200.00',
    });
    expect((v!.requirements as { slumpMm: number; fcMpa: number }).slumpMm).toBe(120);
    expect((v!.requirements as { fcMpa: number }).fcMpa).toBe(30);
    const trs = await env.db
      .select()
      .from(schema.designTransitions)
      .where(eq(schema.designTransitions.designId, v!.id));
    expect(trs[0]).toMatchObject({
      fromStatus: 'none',
      toStatus: 'draft',
      evidence: { kind: 'new_version', parentDesignId: src },
    });
    expect(
      (await env.auditRows()).some((a) => a.action === 'design.version' && a.entityId === v!.id),
    ).toBe(true);

    const list = await m.get(`/api/designs/${src}/versions`);
    expect(list.body.map((x: { version: number }) => x.version)).toEqual([2, 1]);
    const diff = await m.get(`/api/designs/${src}/diff/${res.body.id}`);
    expect(
      diff.body.lines.find((l: { nameEn: string }) => l.nameEn.endsWith(' cem')),
    ).toMatchObject({ from: '350.000', to: '340.000', change: 'changed' });
    expect(diff.body.lines.filter((l: { change: string }) => l.change === 'same')).toHaveLength(4);
    expect(diff.body.requirements).toEqual([{ key: 'slumpMm', from: 100, to: 120 }]);
    const again = await m
      .post(`/api/designs/${src}/versions`)
      .send({ note: 'Another', lines: lineBody(w) });
    expect(again.body.version).toBe(3);
  });

  it('rejects bad edits and roles that cannot write', async () => {
    const w = await makeWorld(env, supplierId, 'VR-B');
    const id = await w.design();
    const m = await manager();
    const base = { note: 'edit', lines: lineBody(w) };
    expect((await m.post(`/api/designs/${id}/versions`).send({ ...base, lines: [] })).status).toBe(
      400,
    );
    expect(
      (
        await m
          .post(`/api/designs/${id}/versions`)
          .send({ ...base, lines: [...lineBody(w), ...lineBody(w)] })
      ).status,
    ).toBe(400);
    expect(
      (
        await m
          .post(`/api/designs/${id}/versions`)
          .send({ ...base, lines: [{ materialId: crypto.randomUUID(), kgPerM3: '1.000' }] })
      ).status,
    ).toBe(400);
    expect(
      (
        await m
          .post(`/api/designs/${id}/versions`)
          .send({ ...base, lines: [{ materialId: w.mat['cem'], kgPerM3: '0.000' }] })
      ).status,
    ).toBe(400);
    expect(
      (
        await m
          .post(`/api/designs/${id}/versions`)
          .send({ ...base, lines: [{ materialId: w.mat['cem'], kgPerM3: '1.2345' }] })
      ).status,
    ).toBe(400);
    expect((await m.post(`/api/designs/${id}/versions`).send({ ...base, note: 'x' })).status).toBe(
      400,
    );
    expect(
      (await m.post(`/api/designs/${id}/versions`).send({ ...base, requirements: { sneaky: 1 } }))
        .status,
    ).toBe(400);
    expect((await m.post(`/api/designs/${crypto.randomUUID()}/versions`).send(base)).status).toBe(
      404,
    );
    const viewer = await as('viewer', [w.plantId]);
    expect((await viewer.post(`/api/designs/${id}/versions`).send(base)).status).toBe(403);
    expect((await viewer.get(`/api/designs/${id}/versions`)).status).toBe(200);
    const other = await makeWorld(env, supplierId, 'VR-C');
    const otherId = await other.design();
    expect((await m.get(`/api/designs/${id}/diff/${otherId}`)).status).toBe(400);
    const pm = await as('plant_manager', [other.plantId]);
    expect((await pm.get(`/api/designs/${id}/versions`)).status).toBe(404);
  });
});

describe('portfolio, batch evaluation and data quality', () => {
  it('evaluates a batch (one audit entry per design), lists the portfolio and filters it', async () => {
    const w = await makeWorld(env, supplierId, 'PF-A');
    const ok = await w.design();
    const fail = await w.design({ requirements: { ...REQ, exposure: ['S2'] } });
    const never = await w.design();
    const retired = await w.design({ status: 'retired' });
    const m = await manager();
    const batch = await m
      .post('/api/designs/evaluate-batch')
      .send({ designIds: [ok, fail, retired], mode: 'ACI' });
    expect(batch.status).toBe(200);
    expect(batch.body.evaluated).toBe(2);
    expect(batch.body.results.map((r: { verdict: string }) => r.verdict).sort()).toEqual([
      'fail',
      'pass',
    ]);
    expect(
      (await env.auditRows()).filter(
        (a) => a.action === 'design.evaluate' && [ok, fail].includes(a.entityId!),
      ),
    ).toHaveLength(2);

    const all = await m.get(`/api/portfolio?plantId=${w.plantId}`);
    expect(all.body.counts).toMatchObject({ total: 3, failing: 1, notEvaluated: 1 });
    const row = (id: string) => all.body.rows.find((r: { id: string }) => r.id === id);
    expect(row(ok)).toMatchObject({
      verdict: 'pass',
      validatorStatus: 'pass',
      evaluated: true,
      status: 'evaluated',
      costJodPerM3: '44.023',
      provisional: true,
    });
    expect(row(fail)).toMatchObject({ verdict: 'fail', failing: expect.any(Number) });
    expect(row(fail).failing).toBeGreaterThan(1);
    expect(row(never)).toMatchObject({ evaluated: false, verdict: null });
    expect(all.body.rows.some((r: { id: string }) => r.id === retired)).toBe(false);

    const failing = await m.get(`/api/portfolio?plantId=${w.plantId}&filter=failing`);
    expect(failing.body.rows.map((r: { id: string }) => r.id)).toEqual([fail]);
    const ne = await m.get(`/api/portfolio?plantId=${w.plantId}&filter=not_evaluated`);
    expect(ne.body.rows.map((r: { id: string }) => r.id)).toEqual([never]);
    expect((await m.get('/api/portfolio?filter=nonsense')).status).toBe(400);
  });

  it('flags inputs that changed since an evaluation', async () => {
    const w = await makeWorld(env, supplierId, 'PF-B');
    const id = await w.design();
    const m = await manager();
    await m.post('/api/designs/evaluate-batch').send({ designIds: [id], mode: 'ACI' });
    expect(
      (await m.get(`/api/portfolio?plantId=${w.plantId}&filter=inputs_changed`)).body.rows,
    ).toHaveLength(0);
    await env.db
      .update(schema.materialTests)
      .set({ isCurrent: false, supersededAt: new Date() })
      .where(eq(schema.materialTests.materialId, w.mat['sand']!));
    await env.db.insert(schema.materialTests).values({
      tenantId: env.tenantId,
      materialId: w.mat['sand']!,
      version: 2,
      isCurrent: true,
      source: 'supplier_datasheet',
      properties: { sg_ssd: 2.6, absorption_pct: 1.5 },
      testedAt: '2026-09-20',
    });
    const changed = await m.get(`/api/portfolio?plantId=${w.plantId}&filter=inputs_changed`);
    expect(changed.body.rows.map((r: { id: string }) => r.id)).toEqual([id]);
  });

  it('limits a batch, respects plant scope and role', async () => {
    const a = await makeWorld(env, supplierId, 'PF-C');
    const b = await makeWorld(env, supplierId, 'PF-D');
    const ida = await a.design();
    await b.design();
    const many = await (
      await manager()
    )
      .post('/api/designs/evaluate-batch')
      .send({ designIds: Array.from({ length: 201 }, () => crypto.randomUUID()) });
    expect(many.status).toBe(400);
    const eng = await as('qc_engineer', [a.plantId]);
    const res = await eng.post('/api/designs/evaluate-batch').send({ mode: 'ACI' });
    expect(res.body.results.map((r: { id: string }) => r.id)).toEqual([ida]);
    expect(
      (await (await as('viewer', [a.plantId])).post('/api/designs/evaluate-batch').send({})).status,
    ).toBe(403);
    const pm = await as('plant_manager', [b.plantId]);
    const mine = await pm.get('/api/portfolio');
    expect(mine.body.rows.every((r: { plantId: string }) => r.plantId === b.plantId)).toBe(true);
  });

  it('groups data-quality causes with the designs they affect, worst first', async () => {
    const w = await makeWorld(env, supplierId, 'DQ-A');
    await env.db
      .update(schema.materialTests)
      .set({ isCurrent: false, supersededAt: new Date() })
      .where(eq(schema.materialTests.materialId, w.mat['sand']!));
    const d1 = await w.design();
    const d2 = await w.design();
    const m = await manager();
    await m.post('/api/designs/evaluate-batch').send({ designIds: [d1, d2], mode: 'ACI' });
    const dq = await m.get(`/api/data-quality?plantId=${w.plantId}`);
    const g = dq.body.groups.find(
      (x: { code: string; materialId: string }) =>
        x.code === 'test_missing' && x.materialId === w.mat['sand'],
    );
    expect(g).toMatchObject({ severity: 'blocker', materialNameEn: 'DQ-A sand' });
    expect(g.designs.map((d: { id: string }) => d.id).sort()).toEqual([d1, d2].sort());
    expect(dq.body.groups[0].severity).toBe('blocker');
    expect(dq.body.notEvaluated).toBe(0);
    // cost-blind roles never see price-related causes
    const viewer = await as('viewer', [w.plantId]);
    expect(
      (await viewer.get('/api/data-quality')).body.groups.some((x: { code: string }) =>
        x.code.startsWith('price_'),
      ),
    ).toBe(false);
  });

  it('exports a CSV for the roles allowed to (logged), formula characters made inert', async () => {
    const w = await makeWorld(env, supplierId, 'EX-A');
    const id = await w.design({ code: '=EX-1' });
    const m = await manager();
    await m.post('/api/designs/evaluate-batch').send({ designIds: [id], mode: 'ACI' });
    const res = await m.post('/api/portfolio/export').send({ plantId: w.plantId, filter: 'all' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const text = res.text;
    expect(text).toContain("'=EX-1");
    expect(text).toContain('44.023');
    expect((await env.auditRows()).some((a) => a.action === 'portfolio.export')).toBe(true);
    expect(
      (
        await (
          await as('viewer', [w.plantId])
        )
          .post('/api/portfolio/export')
          .send({ filter: 'all' })
      ).status,
    ).toBe(403);
  });
});

describe('baselines and theoretical savings', () => {
  const baselineFor = async (
    code: string,
    extra: Partial<Parameters<Awaited<ReturnType<typeof makeWorld>>['design']>[0]> = {},
  ) => {
    const w = await makeWorld(env, supplierId, code);
    const id = await w.design({ ...(await attestedValues(env)), ...extra });
    const snap = await w.snapshot();
    return { w, id, snap };
  };

  it('a baseline fixes the cost of an attested design at a named snapshot, immutably; live prices cannot change it', async () => {
    const { w, id, snap } = await baselineFor('BL-A');
    const m = await manager();
    const res = await m
      .post('/api/baselines')
      .send({ designId: id, priceSnapshotId: snap, mode: 'ACI' });
    expect(res.status).toBe(201);
    expect(res.body.costJodPerM3).toBe('44.023');
    expect(res.body.annualJod).toBe('633931.200'); // 44.023 × 1200 × 12
    const [b] = await env.db
      .select()
      .from(schema.costBaselines)
      .where(eq(schema.costBaselines.id, res.body.id));
    expect(b).toMatchObject({
      priceSnapshotId: snap,
      volumeSource: 'import_file',
      monthlyVolumeM3: '1200.00',
      evaluationId: res.body.evaluationId,
    });
    await expect(
      env.pool.query(`UPDATE cost_baselines SET cost_jod_per_m3 = 1 WHERE id = $1`, [b!.id]),
    ).rejects.toThrow();
    await expect(
      env.pool.query(`DELETE FROM cost_baselines WHERE id = $1`, [b!.id]),
    ).rejects.toThrow();
    // a live price change does not move the baseline
    await env.db
      .update(schema.materialPrices)
      .set({ supersededAt: new Date() })
      .where(eq(schema.materialPrices.materialId, w.mat['cem']!));
    await env.db.insert(schema.materialPrices).values({
      tenantId: env.tenantId,
      materialId: w.mat['cem']!,
      plantId: w.plantId,
      supplierId,
      price: '200',
      unit: 'JOD/ton',
      effectiveFrom: '2026-10-01',
    });
    const list = await m.get('/api/baselines');
    expect(list.body.find((x: { id: string }) => x.id === b!.id)).toMatchObject({
      costJodPerM3: '44.023',
      snapshotName: 'Q4',
      code: expect.any(String),
    });
    // duplicates, wrong design, wrong snapshot
    expect(
      (await m.post('/api/baselines').send({ designId: id, priceSnapshotId: snap })).status,
    ).toBe(409);
    const draft = await w.design();
    expect(
      (await m.post('/api/baselines').send({ designId: draft, priceSnapshotId: snap })).status,
    ).toBe(409);
    const other = await baselineFor('BL-B');
    expect(
      (await m.post('/api/baselines').send({ designId: id, priceSnapshotId: other.snap })).status,
    ).toBe(409);
    expect(
      (await m.post('/api/baselines').send({ designId: id, priceSnapshotId: crypto.randomUUID() }))
        .status,
    ).toBe(404);
  });

  it('is QC Manager only, and refuses an incomplete cost', async () => {
    const { w, id } = await baselineFor('BL-C');
    const snap = await w.snapshot('Partial', ['coarse']);
    for (const role of ['qc_engineer', 'procurement', 'plant_manager', 'admin'] as const)
      expect(
        (
          await (
            await as(role, [w.plantId])
          )
            .post('/api/baselines')
            .send({ designId: id, priceSnapshotId: snap })
        ).status,
        role,
      ).toBe(403);
    const res = await (
      await manager()
    )
      .post('/api/baselines')
      .send({ designId: id, priceSnapshotId: snap });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('baseline_not_possible');
    expect(res.body.error.details.reasons[0].code).toBe('cost_incomplete');
    expect(
      await env.db.select().from(schema.costBaselines).where(eq(schema.costBaselines.designId, id)),
    ).toHaveLength(0);
  });

  it('a compliant, validated, cheaper variant becomes a THEORETICAL entry priced at the baseline snapshot', async () => {
    const { w, id, snap } = await baselineFor('SV-A');
    const m = await manager();
    const b = (
      await m.post('/api/baselines').send({ designId: id, priceSnapshotId: snap, mode: 'ACI' })
    ).body;
    // 10 kg less cement, 5 kg more coarse aggregate keeps the yield: cement 340
    const v = await m
      .post(`/api/designs/${id}/versions`)
      .send({ note: 'Less cement', lines: lineBody(w, { cem: '340.000', coarse: '1055.000' }) });
    // live prices go UP after the baseline: must not matter
    await env.db
      .insert(schema.materialPrices)
      .values({
        tenantId: env.tenantId,
        materialId: w.mat['cem']!,
        plantId: w.plantId,
        supplierId,
        price: '500',
        unit: 'JOD/ton',
        effectiveFrom: '2026-10-01',
      })
      .catch(() => undefined);
    const res = await m
      .post('/api/savings/theoretical')
      .send({ baselineId: b.id, variantDesignId: v.body.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      eligible: true,
      reasons: [],
      entry: { state: 'theoretical', provisional: true },
    });
    // 10 kg × 0.075 JOD/kg − 20 kg × 0.007 JOD/kg = 0.750 − 0.140 = 0.610
    expect(res.body.entry.savingJodPerM3).toBe('0.610');
    expect(res.body.entry.annualJod).toBe('8784.000'); // 0.610 × 1200 × 12
    const [e] = await env.db.select().from(schema.savingsEntries);
    expect(e).toMatchObject({
      priceSnapshotId: snap,
      state: 'theoretical',
      reasonCode: 'manual_variant',
      baselineId: b.id,
    });
    await expect(
      env.pool.query(`UPDATE savings_entries SET saving_jod_per_m3 = 99 WHERE id = $1`, [e!.id]),
    ).rejects.toThrow();
    await expect(
      env.pool.query(`UPDATE savings_entries SET state = 'realized' WHERE id = $1`, [e!.id]),
    ).rejects.toThrow();
    // nothing was approved
    expect((await designRow(v.body.id)).status).toBe('evaluated');
    expect((await designRow(v.body.id)).approvalSource).toBeNull();
    const ledger = await m.get('/api/savings');
    expect(ledger.body[0]).toMatchObject({
      state: 'theoretical',
      savingJodPerM3: '0.610',
      snapshotName: 'Q4',
      provisional: true,
    });
    expect(ledger.body.every((x: { state: string }) => x.state === 'theoretical')).toBe(true);
  });

  it('ineligible variants create no entry and say why: not cheaper, non-compliant, incomplete, wrong design', async () => {
    const { w, id, snap } = await baselineFor('SV-B');
    const m = await manager();
    const b = (
      await m.post('/api/baselines').send({ designId: id, priceSnapshotId: snap, mode: 'ACI' })
    ).body;
    const post = (variant: string) =>
      m.post('/api/savings/theoretical').send({ baselineId: b.id, variantDesignId: variant });
    const dearer = (
      await m
        .post(`/api/designs/${id}/versions`)
        .send({ note: 'More cement', lines: lineBody(w, { cem: '360.000', coarse: '1015.000' }) })
    ).body.id;
    expect((await post(dearer)).body).toMatchObject({
      eligible: false,
      reasons: [{ code: 'not_cheaper' }],
    });
    const failing = (
      await m.post(`/api/designs/${id}/versions`).send({
        note: 'Leaner',
        lines: lineBody(w, { cem: '300.000', coarse: '1100.000' }),
        requirements: { exposure: ['S2'] },
      })
    ).body.id;
    const r2 = (await post(failing)).body;
    expect(r2.eligible).toBe(false);
    expect(r2.reasons.map((r: { code: string }) => r.code)).toContain('verdict_fail');
    const lean = (
      await m
        .post(`/api/designs/${id}/versions`)
        .send({ note: 'Bad yield', lines: lineBody(w, { cem: '300.000' }) })
    ).body.id;
    expect((await post(lean)).body.reasons.map((r: { code: string }) => r.code)).toContain(
      'verdict_fail',
    ); // yield out of tolerance
    expect(
      await env.db
        .select()
        .from(schema.savingsEntries)
        .where(eq(schema.savingsEntries.baselineId, b.id)),
    ).toHaveLength(0);
    // other design / same design / unknown baseline / not allowed state
    const stranger = await w.design();
    expect((await post(stranger)).status).toBe(409);
    expect((await post(id)).status).toBe(409);
    expect(
      (
        await m
          .post('/api/savings/theoretical')
          .send({ baselineId: crypto.randomUUID(), variantDesignId: dearer })
      ).status,
    ).toBe(404);
    await env.db
      .update(schema.mixDesigns)
      .set({ status: 'retired' })
      .where(eq(schema.mixDesigns.id, dearer));
    expect((await post(dearer)).status).toBe(409);
  });

  it('cost-blind roles have no ledger or baselines; roles without design.write cannot price variants', async () => {
    const { w } = await baselineFor('SV-C');
    for (const role of ['viewer', 'sales'] as const) {
      const agent = await as(role, [w.plantId]);
      expect((await agent.get('/api/savings')).status, role).toBe(403);
      expect((await agent.get('/api/baselines')).status, role).toBe(403);
      expect(
        (
          await agent
            .post('/api/savings/theoretical')
            .send({ baselineId: crypto.randomUUID(), variantDesignId: crypto.randomUUID() })
        ).status,
        role,
      ).toBe(403);
    }
    const pm = await as('plant_manager', [w.plantId]);
    expect((await pm.get('/api/savings')).status).toBe(200);
    expect(
      (
        await pm
          .post('/api/savings/theoretical')
          .send({ baselineId: crypto.randomUUID(), variantDesignId: crypto.randomUUID() })
      ).status,
    ).toBe(403);
  });
});

const designRow = async (id: string) =>
  (await env.db.select().from(schema.mixDesigns).where(eq(schema.mixDesigns.id, id)))[0]!;

describe('preview of an unsaved edit', () => {
  it('evaluates and validates the edit without storing anything', async () => {
    const w = await makeWorld(env, supplierId, 'PV-A');
    const id = await w.design();
    const m = await manager();
    const before = await env.db
      .select()
      .from(schema.designEvaluations)
      .where(eq(schema.designEvaluations.designId, id));
    const res = await m.post(`/api/designs/${id}/preview`).send({
      mode: 'ACI',
      lines: lineBody(w, { cem: '340.000', coarse: '1055.000' }),
      requirements: { exposure: ['S2'] },
    });
    expect(res.status).toBe(200);
    expect(res.body.validator.status).toBe('pass');
    expect(res.body.report.figures['mass.cement']).toBe(340);
    expect(res.body.report.cost.totalJodPerM3).toBe('43.413'); // 44.023 − 0.610
    expect(res.body.report.checks.find((c: { id: string }) => c.id === 'max_wcm').status).toBe(
      'fail',
    ); // S2 limit 0.45
    expect(
      await env.db
        .select()
        .from(schema.designEvaluations)
        .where(eq(schema.designEvaluations.designId, id)),
    ).toHaveLength(before.length);
    expect((await designRow(id)).status).toBe('draft');
    const blind = await as('plant_manager', [w.plantId]);
    expect(
      (await blind.post(`/api/designs/${id}/preview`).send({ lines: lineBody(w) })).status,
    ).toBe(403);
    expect((await m.post(`/api/designs/${id}/preview`).send({ lines: [] })).status).toBe(400);
    expect(
      (await m.post('/api/designs/not-a-uuid/preview').send({ lines: lineBody(w) })).status,
    ).toBe(400);
  });
});
