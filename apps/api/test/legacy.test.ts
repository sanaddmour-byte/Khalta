import { schema } from '@khalta/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';

type Agent = Awaited<ReturnType<TestEnv['login']>>;
let env: TestEnv;
let p1: { id: string }, p2: { id: string };
let mgr: Agent, mgr2: Agent, eng: Agent, admin: Agent, pm: Agent, viewer: Agent;
let mgrUser: { id: string };
let cement: { id: string },
  water: { id: string },
  foulieh: { id: string },
  hummus: { id: string },
  adm: { id: string };

const HEAD =
  'design_code,plant_code,design_name,fc_mpa,strength_basis,test_age_days,exposure_classes,slump_mm,nmas_mm,pumpable,material_name,material_category,quantity,unit,approval_reference,currently_in_production,avg_monthly_volume_m3';
const line = (
  code: string,
  name: string,
  cat: string,
  q: string,
  unit = 'kg/m3',
  plant = 'AMM-01',
) =>
  `${code},${plant},Design ${code},30,cylinder,28,F0;S0;W0;C1,125,19,true,${name},${cat},${q},${unit},Sub-${code},true,2400`;
const FILE = [
  HEAD,
  line('D-1', 'إسمنت', 'cement', '360'),
  line('D-1', 'ماء', 'water', '175'),
  line('D-1', 'فُولِيّة', 'coarse_agg', '610'), // spelling variant of an exact name
  line('D-1', 'ملدن', 'admixture', '3.5', 'L/m3'),
  line('D-2', 'اسمنت', 'cement', '340'),
  line('D-2', 'ماء', 'water', '170'),
  line('D-2', 'عدسية 20', 'coarse_agg', '600'), // near, not exact: must be confirmed
].join('\n');

const upload = (agent: Agent, text: string, name = 'legacy.csv') =>
  agent
    .post(`/api/imports/legacy/upload?filename=${name}`)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from(text));

beforeAll(async () => {
  env = await createTestEnv({}, { seedRules: true });
  p1 = await env.seedPlant('AMM-01');
  p2 = await env.seedPlant('AQB-01');
  const u = await env.seedUser('qc_manager');
  mgrUser = u;
  mgr = await env.login(u.email);
  mgr2 = await env.login((await env.seedUser('qc_manager')).email);
  eng = await env.login((await env.seedUser('qc_engineer', { plantIds: [p1.id] })).email);
  admin = await env.login((await env.seedUser('admin')).email);
  pm = await env.login((await env.seedUser('plant_manager', { plantIds: [p2.id] })).email);
  viewer = await env.login((await env.seedUser('viewer', { plantIds: [p1.id] })).email);
  const mk = async (category: string, ar: string, en: string) =>
    (await mgr.post('/api/materials').send({ category, marketNameAr: ar, marketNameEn: en }))
      .body as { id: string };
  cement = await mk('cement', 'إسمنت', 'Cement');
  water = await mk('water', 'ماء', 'Water');
  foulieh = await mk('coarse_agg', 'فولية', 'Fouliyeh');
  hummus = await mk('coarse_agg', 'حمصية', 'Hummusiyeh');
  adm = await mk('admixture', 'ملدن', 'Plasticizer');
  await mk('coarse_agg', 'عدسية', 'Adasiyeh');
  await mgr.post(`/api/materials/${adm.id}/tests`).send({
    properties: { sg: 1.1 },
    source: 'user_declared',
    declaredReason: 'datasheet',
    testedAt: '2026-09-01',
  });
});
afterAll(() => env.close());

describe('legacy import: upload, matching and validation', () => {
  it('detects the mapping and refuses a file without the required columns', async () => {
    const up = await upload(mgr, FILE);
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ lines: 7, missing: [] });
    expect(up.body.mapping.design_code).toBe(0);
    const bad = await upload(mgr, 'a,b\n1,2');
    expect(bad.body.missing).toContain('plant_code');
    expect((await upload(mgr, 'x', 'a.pdf')).status).toBe(415);
    expect((await upload(mgr, HEAD)).status).toBe(400); // no data rows
    expect((await upload(eng, FILE)).status).toBe(403);
  });

  it('pre-selects only exact normalized matches; near names need a confirmation', async () => {
    const up = await upload(mgr, FILE);
    const p = (await mgr.post(`/api/imports/legacy/${up.body.batchId}/preview`).send({})).body;
    const by = (name: string) => p.materials.find((m: { name: string }) => m.name === name);
    expect(by('فُولِيّة')).toMatchObject({ decision: 'exact', materialId: foulieh.id });
    expect(by('اسمنت')).toMatchObject({ decision: 'exact', materialId: cement.id });
    const near = by('عدسية 20');
    expect(near).toMatchObject({ decision: 'unresolved', materialId: null });
    expect(p.summary).toMatchObject({ designs: 2, ok: 1, errors: 1, unresolved: 1 });
    expect(p.designs[1].errors.map((e: { code: string }) => e.code)).toContain(
      'unresolved_material',
    );
    // the litre line converts through the admixture SG; the exact kg line is carried as typed
    const l = p.designs[0].lines;
    expect(l[3]).toMatchObject({ unit: 'L/m3', kg: '3.850' });
    expect(l[0]).toMatchObject({ kg: '360.000' });
    // a similar name is only ever a suggestion
    expect(near.suggestions.length).toBeGreaterThan(0);
  });

  it('a decision picks a material; the category must agree; commit refuses while anything is unresolved', async () => {
    const up = await upload(mgr, FILE);
    const id = up.body.batchId;
    expect((await mgr.post(`/api/imports/legacy/${id}/commit`).send({})).status).toBe(400);
    const wrong = await mgr
      .post(`/api/imports/legacy/${id}/preview`)
      .send({ decisions: { 'coarse_agg|عدسية 20': { materialId: cement.id } } });
    expect(wrong.body.designs[1].errors.map((e: { code: string }) => e.code)).toContain(
      'category_mismatch',
    );
    const ok = await mgr
      .post(`/api/imports/legacy/${id}/preview`)
      .send({ decisions: { 'coarse_agg|عدسية 20': { materialId: hummus.id } } });
    expect(ok.body.summary).toMatchObject({ ok: 2, errors: 0 });
    expect(ok.body.materials.find((m: { name: string }) => m.name === 'عدسية 20').decision).toBe(
      'confirmed',
    );
  });

  it('reports unknown plants, existing codes, litres without SG and file-level errors', async () => {
    const odd = [
      HEAD,
      line('Z-1', 'إسمنت', 'cement', '300', 'kg/m3', 'NOPE'),
      line('Z-1', 'ماء', 'water', '170', 'kg/m3', 'NOPE'),
      line('Z-2', 'إسمنت', 'cement', '300'),
      line('Z-2', 'ماء', 'water', '3', 'L/m3'),
    ].join('\n');
    const up = await upload(mgr, odd);
    const p = (await mgr.post(`/api/imports/legacy/${up.body.batchId}/preview`).send({})).body;
    expect(p.designs[0].errors.map((e: { code: string }) => e.code)).toContain('unknown_plant');
    expect(p.designs[1].errors.map((e: { code: string }) => e.code)).toContain('litres_need_sg');
    const partial = (
      await mgr
        .post(`/api/imports/legacy/${up.body.batchId}/preview`)
        .send({ mapping: { design_code: 0 } })
    ).body;
    expect(partial.fileErrors).toContain('missing_column:plant_code');
  });

  it('warns about materials without tests or prices, never blocks on them', async () => {
    const up = await upload(mgr, FILE);
    const p = (await mgr.post(`/api/imports/legacy/${up.body.batchId}/preview`).send({})).body;
    const w = p.designs[0].warnings.map((x: { code: string }) => x.code);
    expect(w).toContain('material_without_tests');
    expect(w).toContain('material_not_priced');
  });
});

describe('legacy import: commit', () => {
  let designIds: string[];
  let batchId: string;

  it('creates draft designs, evaluation pending, with kg and original units, all or nothing and single use', async () => {
    const up = await upload(mgr, FILE);
    batchId = up.body.batchId;
    const r = await mgr
      .post(`/api/imports/legacy/${batchId}/commit`)
      .send({ decisions: { 'coarse_agg|عدسية 20': { materialId: hummus.id } } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ designs: 2, createdMaterials: 0 });
    designIds = r.body.designIds;
    const d = (await mgr.get(`/api/designs/${designIds[0]}`)).body;
    expect(d.design).toMatchObject({
      code: 'D-1',
      status: 'draft',
      evaluationPending: true,
      approvalSource: null,
      importedApprovalRef: 'Sub-D-1',
      importedInProduction: true,
    });
    expect(d.design.requirements).toMatchObject({
      fcMpa: 30,
      basis: 'cylinder',
      testAgeDays: 28,
      exposure: ['F0', 'S0', 'W0', 'C1'],
      slumpMm: 125,
      nmasMm: 19,
      pumpable: true,
    });
    expect(d.design.avgMonthlyVolumeM3).toBe('2400.00');
    expect(d.lines.find((l: { originalUnit: string }) => l.originalUnit === 'L/m3')).toMatchObject({
      quantityKgM3: '3.850',
      originalQuantity: '3.500',
    });
    expect(d.transitions[0]).toMatchObject({ fromStatus: 'none', toStatus: 'draft' });
    expect(d.source).toBe('legacy.csv');
    expect((await mgr.post(`/api/imports/legacy/${batchId}/commit`).send({})).status).toBe(409);
  });

  it('round trip: the lines read back from the library equal the source file', async () => {
    const back: string[] = [];
    for (const id of designIds) {
      const d = (await mgr.get(`/api/designs/${id}`)).body;
      for (const l of d.lines)
        back.push(
          `${d.design.code}|${l.originalName}|${Number(l.originalQuantity)}|${l.originalUnit}`,
        );
    }
    const src = FILE.split('\n')
      .slice(1)
      .map((r) => r.split(','))
      .map((c) => `${c[0]}|${c[10]}|${Number(c[12])}|${c[13]}`);
    expect(back.sort()).toEqual(src.sort());
  });

  it('a second import of the same codes is blocked; created materials are flagged and empty', async () => {
    const again = await upload(mgr, FILE);
    const p = (
      await mgr
        .post(`/api/imports/legacy/${again.body.batchId}/preview`)
        .send({ decisions: { 'coarse_agg|عدسية 20': { materialId: hummus.id } } })
    ).body;
    expect(p.designs[0].errors.map((e: { code: string }) => e.code)).toContain(
      'code_exists_in_library',
    );
    expect(
      (
        await mgr
          .post(`/api/imports/legacy/${again.body.batchId}/commit`)
          .send({ decisions: { 'coarse_agg|عدسية 20': { materialId: hummus.id } } })
      ).status,
    ).toBe(400);
    const fresh = [
      HEAD,
      line('N-1', 'إسمنت', 'cement', '350'),
      line('N-1', 'ماء', 'water', '172'),
      line('N-1', 'حصمة جديدة', 'coarse_agg', '900'),
    ].join('\n');
    const up = await upload(mgr, fresh, 'fresh.csv');
    const r = await mgr
      .post(`/api/imports/legacy/${up.body.batchId}/commit`)
      .send({ decisions: { 'coarse_agg|حصمة جديدة': { create: true } } });
    expect(r.body).toMatchObject({ designs: 1, createdMaterials: 1 });
    const list = (await mgr.get('/api/materials?q=حصمة')).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ hasTest: false, canEvaluate: false });
    const detail = (await mgr.get(`/api/materials/${list[0].id}`)).body;
    expect(detail.material.notes).toMatch(/legacy import/);
    const d = (await mgr.get(`/api/designs/${r.body.designIds[0]}`)).body;
    expect(
      d.lines.find((l: { originalName: string }) => l.originalName === 'حصمة جديدة').matchMethod,
    ).toBe('created');
  });

  it('only the importer can use an upload; plant scoping hides other plants’ designs', async () => {
    const up = await upload(mgr, FILE);
    expect(
      (await mgr2.post(`/api/imports/legacy/${up.body.batchId}/preview`).send({})).status,
    ).toBe(404);
    expect((await eng.get(`/api/designs/${designIds[0]}`)).status).toBe(200); // AMM-01
    expect((await pm.get(`/api/designs/${designIds[0]}`)).status).toBe(404); // a plant-2 manager
    expect(((await pm.get('/api/designs')).body as unknown[]).length).toBe(0);
    expect(((await viewer.get('/api/designs')).body as unknown[]).length).toBeGreaterThan(0);
    expect((await admin.get('/api/designs?q=D-1')).body).toHaveLength(1);
  });
});

describe('attestation', () => {
  let target: string;
  const body = {
    approvalReference: 'Submittal 2025-14',
    inProduction: true,
    note: 'Checked against the signed submittal',
  };

  beforeAll(async () => {
    const q = (await mgr2.get('/api/designs?queue=true')).body as { id: string; code: string }[];
    expect(q.length).toBeGreaterThan(0);
    target = q.find((d) => d.code === 'D-1')!.id;
  });

  it('the importer cannot attest their own import (four-eyes); other roles cannot attest at all', async () => {
    const own = await mgr.post(`/api/designs/${target}/attest`).send(body);
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('four_eyes');
    expect((await eng.post(`/api/designs/${target}/attest`).send(body)).status).toBe(403);
    expect((await admin.post(`/api/designs/${target}/attest`).send(body)).status).toBe(403);
  });

  it('a second QC manager attests with a reference and a signed note; history and audit keep it', async () => {
    expect(
      (await mgr2.post(`/api/designs/${target}/attest`).send({ ...body, approvalReference: '' }))
        .status,
    ).toBe(400);
    expect(
      (await mgr2.post(`/api/designs/${target}/attest`).send({ ...body, note: 'ok' })).status,
    ).toBe(400);
    const r = await mgr2.post(`/api/designs/${target}/attest`).send(body);
    expect(r.body).toEqual({ id: target, status: 'in_production' });
    const d = (await mgr2.get(`/api/designs/${target}`)).body;
    expect(d.design).toMatchObject({
      status: 'in_production',
      approvalSource: 'legacy_attested',
      externalApprovalRef: 'Submittal 2025-14',
      evaluationPending: true,
    });
    expect(d.transitions.map((t: { toStatus: string }) => t.toStatus)).toEqual([
      'in_production',
      'approved',
      'draft',
    ]);
    expect(d.transitions[0].evidence.note_scope).toMatch(/not evaluated by Khalta/);
    expect(
      (await env.auditRows()).some((a) => a.action === 'design.attest' && a.entityId === target),
    ).toBe(true);
    expect((await mgr2.post(`/api/designs/${target}/attest`).send(body)).status).toBe(409);
    expect(
      ((await mgr2.get('/api/designs?queue=true')).body as { id: string }[]).some(
        (x) => x.id === target,
      ),
    ).toBe(false);
  });

  it('a design can be attested as approved only (not in production)', async () => {
    const q = (await mgr2.get('/api/designs?queue=true')).body as { id: string }[];
    const r = await mgr2
      .post(`/api/designs/${q[0]!.id}/attest`)
      .send({ ...body, inProduction: false, approvedOn: '2025-06-01' });
    expect(r.body.status).toBe('approved');
  });

  it('is enforced in the database too', async () => {
    const [row] = await env.db
      .select()
      .from(schema.mixDesigns)
      .where(eq(schema.mixDesigns.id, target));
    await expect(
      env.pool.query("update mix_designs set code = 'HACK' where id = $1", [row!.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      env.pool.query("update mix_designs set requirements = '{}' where id = $1", [row!.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      env.pool.query('delete from mix_designs where id = $1', [row!.id]),
    ).rejects.toThrow();
    await expect(
      env.pool.query('update design_transitions set to_status = $1 where design_id = $2', [
        'x',
        row!.id,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.pool.query('delete from mix_design_lines where design_id = $1', [row!.id]),
    ).rejects.toThrow(/append-only/);
    const [draft] = await env.db
      .select()
      .from(schema.mixDesigns)
      .where(eq(schema.mixDesigns.status, 'draft'));
    await expect(
      env.pool.query("update mix_designs set status = 'approved' where id = $1", [draft!.id]),
    ).rejects.toThrow(/approved_needs_source/);
    await expect(
      env.pool.query(
        "update mix_designs set status = 'draft', approval_source = 'legacy_attested' where id = $1",
        [draft!.id],
      ),
    ).rejects.toThrow(/attested_needs_evidence/);
  });

  it('records the import and attest actions in the audit log', async () => {
    const actions = new Set((await env.auditRows()).map((a) => a.action));
    for (const a of [
      'legacy.import.upload',
      'legacy.import.commit',
      'design.import',
      'design.attest',
    ])
      expect(actions, a).toContain(a);
    expect(mgrUser.id).toBeTruthy();
  });
});
