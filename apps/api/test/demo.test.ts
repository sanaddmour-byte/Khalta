import { schema } from '@khalta/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDemoPlan, DEMO_SEED, planHash, SYNTHETIC } from '../src/demo/plan';
import { seedDemo, seedDemoRules, upgradeDemoData } from '../src/demo/seed';
import { createTestEnv, type TestEnv } from './helpers';

describe('demo plan', () => {
  it('is deterministic: same seed, same content; another seed differs', () => {
    expect(planHash(buildDemoPlan(DEMO_SEED))).toBe(planHash(buildDemoPlan(DEMO_SEED)));
    expect(planHash(buildDemoPlan(1))).not.toBe(planHash(buildDemoPlan(DEMO_SEED)));
  });
  it('labels every generated record as synthetic', () => {
    const p = buildDemoPlan();
    const labelled = (s: string) => s.includes(SYNTHETIC) || s.includes('تجريبي');
    for (const x of [
      ...p.plants.flatMap((q) => [q.nameEn, q.nameAr]),
      ...p.suppliers.flatMap((q) => [q.nameEn, q.nameAr]),
      ...p.materials.map((m) => m.nameEn), // Arabic market names stay plain on purpose so matching is realistic; notes also carry the label
    ])
      expect(labelled(x), x).toBe(true);
    for (const d of p.designs) expect(d.code.startsWith('DEMO-')).toBe(true);
    expect(
      p.legacyCsv
        .split('\n')
        .slice(1)
        .every((l) => l.includes(SYNTHETIC)),
    ).toBe(true);
  });
  it('has the Appendix C shape', () => {
    const p = buildDemoPlan();
    expect(p.plants.map((x) => x.code)).toEqual(['AMM-01', 'AQB-01']);
    expect(p.materials.filter((m) => m.category === 'cement')).toHaveLength(7);
    expect(
      p.materials.filter((m) => m.plant === 'AMM-01' && m.category.endsWith('agg')),
    ).toHaveLength(6);
    expect(
      p.materials.filter((m) => m.plant === 'AQB-01' && m.category.endsWith('agg')),
    ).toHaveLength(6);
    expect(
      p.materials
        .filter((m) => m.category === 'admixture')
        .every((m) => (m.properties['water_reduction_table'] as unknown[]).length === 4),
    ).toBe(true);
    expect(p.designs.filter((d) => d.plant === 'AMM-01')).toHaveLength(3);
    expect(p.designs.filter((d) => d.attest)).toHaveLength(4);
  });
});

describe('demo seed against a real database', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv({}, { seedRules: true });
  });
  afterAll(() => env.close());

  it('creates the dataset through the app’s own API, once', async () => {
    const deps = {
      db: env.db,
      auth: env.auth,
      config: env.config,
      tenantId: env.tenantId,
      password: 'demo-password-change-me',
    };
    const t0 = Date.now();
    const r = await seedDemo(deps);
    expect(r).toEqual({ skipped: false, designs: 6 });
    expect(Date.now() - t0).toBeLessThan(25_000);
    expect(await seedDemo(deps)).toEqual({ skipped: true, designs: 0 }); // idempotent

    const admin = await env.login('admin@khalta.test', 'demo-password-change-me');
    const designs = (await admin.get('/api/designs')).body as {
      code: string;
      status: string;
      approvalSource: string | null;
      synthetic: boolean;
      evaluationPending: boolean;
    }[];
    expect(designs).toHaveLength(6);
    expect(
      designs.filter((d) => d.status === 'in_production' && d.approvalSource === 'legacy_attested'),
    ).toHaveLength(4);
    expect(designs.filter((d) => d.status === 'draft')).toHaveLength(2);
    expect(designs.every((d) => d.synthetic && d.evaluationPending)).toBe(true);

    const m = (await admin.get('/api/prices')).body;
    expect(m.summary.staleLimitDays).toBe(30);
    expect(m.summary.stale).toBe(1); // exactly one stale cell
    const hum = m.materials.find(
      (x: { marketNameEn: string }) =>
        x.marketNameEn.startsWith('Hummusiyeh') && x.marketNameEn.includes('Aqaba'),
    );
    const aqb = m.plants.find((p: { code: string }) => p.code === 'AQB-01');
    expect(
      m.cells.some(
        (c: { materialId: string; plantId: string }) =>
          c.materialId === hum.id && c.plantId === aqb.id,
      ),
    ).toBe(false); // unpriced
    expect(
      m.cells.filter((c: { notConvertible?: string }) => c.notConvertible === 'needs_density')
        .length,
    ).toBe(0); // every cell converts to JOD/kg, so the optimizer can use all priced materials
    expect(((await admin.get('/api/price-snapshots')).body as unknown[]).length).toBe(2);

    const mats = (await admin.get('/api/materials')).body as {
      marketNameEn: string;
      freshness: { status: string } | null;
      canDesign: boolean;
      notes?: string;
    }[];
    expect(mats.filter((x) => x.freshness?.status === 'expired')).toHaveLength(1);
    expect(mats.length).toBe(23);
    const fine = mats.filter((x) => x.marketNameEn.startsWith('Raml'));
    expect(fine.every((x) => x.canDesign)).toBe(true);

    const vols = await env.db.select().from(schema.productionVolumes);
    expect(vols).toHaveLength(36);
    expect(vols.every((v) => v.source === 'demo')).toBe(true);
    const mgr = await env.login('qc.manager@khalta.test', 'demo-password-change-me');
    expect(((await mgr.get('/api/designs?queue=true')).body as unknown[]).length).toBe(2); // two still await attestation
  });

  it('the synthetic rule values let the optimizer run at both plants, in both modes; a second run changes nothing', async () => {
    const deps = {
      db: env.db,
      auth: env.auth,
      config: env.config,
      tenantId: env.tenantId,
      password: 'demo-password-change-me',
    };
    expect(await seedDemoRules(deps)).toBeGreaterThan(20);
    expect(await seedDemoRules(deps)).toBe(0);
    const mgr = await env.login('qc.manager@khalta.test', 'demo-password-change-me');
    const plants = (await mgr.get('/api/plants')).body as { id: string; code: string }[];
    for (const mode of ['ACI', 'BOTH'] as const)
      for (const p of plants) {
        const res = await mgr.post('/api/design-requests').send({
          plantId: p.id,
          mode,
          requirements: {
            fcMpa: 30,
            basis: 'cylinder',
            exposure: ['F0', 'S0', 'W0', 'C1'],
            slumpMm: 100,
            nmasMm: 19,
          },
        });
        const blockers = res.body.outcome?.blockers ?? [];
        expect(res.status, `${mode} ${p.code}`).toBe(201);
        expect(
          blockers.map((b: { subject: string }) => b.subject),
          `${mode} ${p.code}`,
        ).toEqual([]);
        expect(res.body.status, `${mode} ${p.code}`).toBe('candidates');
        expect(res.body.candidates.length).toBeGreaterThan(0);
      }
  });

  it('upgrades an older demo database in place: a material missing new fields and a water price in JOD/m3', async () => {
    const deps = {
      db: env.db,
      auth: env.auth,
      config: env.config,
      tenantId: env.tenantId,
      password: 'demo-password-change-me',
    };
    expect(await upgradeDemoData(deps)).toBe(0); // already current
    const admin = await env.login('admin@khalta.test', 'demo-password-change-me');
    const mgr = await env.login('qc.manager@khalta.test', 'demo-password-change-me');
    const mats = (await admin.get('/api/materials')).body as {
      id: string;
      marketNameEn: string;
      category: string;
    }[];
    const sand = mats.find((x) => x.marketNameEn.startsWith('Raml (washed sand)'))!;
    const cur = (await admin.get(`/api/materials/${sand.id}`)).body.current.properties;
    const { chlorides_pct: _c, sulfates_pct: _s, ...old } = cur;
    const r = await mgr.post(`/api/materials/${sand.id}/tests`).send({
      properties: old,
      source: 'user_declared',
      declaredReason: 'older demo data',
      testedAt: '2026-09-20',
    });
    expect(r.status).toBe(201);
    const water = mats.find((x) => x.category === 'water')!;
    const grid = (await admin.get('/api/prices')).body as {
      cells: { materialId: string; plantId: string; supplierId: string; unit: string }[];
    };
    const wc = grid.cells.find((c) => c.materialId === water.id)!;
    const pr = await admin.post('/api/prices').send({
      entries: [
        {
          materialId: water.id,
          plantId: wc.plantId,
          supplierId: wc.supplierId,
          price: '0.9',
          unit: 'JOD/m3',
        },
      ],
      effectiveFrom: '2026-10-04',
      reason: 'older demo data',
    });
    expect(pr.status).toBe(201);
    expect(await upgradeDemoData(deps)).toBeGreaterThan(1);
    const after = (await admin.get('/api/prices')).body as typeof grid;
    expect(
      after.cells.find((c) => c.materialId === water.id && c.plantId === wc.plantId)!.unit,
    ).toBe('JOD/ton');
    const back = (await admin.get(`/api/materials/${sand.id}`)).body.current.properties;
    expect(back.chlorides_pct).toBe(0.01);
    expect(await upgradeDemoData(deps)).toBe(0); // idempotent
  });
});
