import { schema } from '@khalta/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
let p1: { id: string }, p2: { id: string };
let mgr: Awaited<ReturnType<TestEnv['login']>>;
let eng: Awaited<ReturnType<TestEnv['login']>>;
let pm1: Awaited<ReturnType<TestEnv['login']>>;
let proc: Awaited<ReturnType<TestEnv['login']>>;
let viewer: Awaited<ReturnType<TestEnv['login']>>;

beforeAll(async () => {
  env = await createTestEnv({}, { seedRules: true });
  p1 = await env.seedPlant('AMM-01');
  p2 = await env.seedPlant('AQB-01');
  mgr = await env.login((await env.seedUser('qc_manager')).email);
  eng = await env.login((await env.seedUser('qc_engineer', { plantIds: [p1.id] })).email);
  pm1 = await env.login((await env.seedUser('plant_manager', { plantIds: [p1.id] })).email);
  proc = await env.login((await env.seedUser('procurement', { plantIds: [p1.id] })).email);
  viewer = await env.login((await env.seedUser('viewer')).email);
});
afterAll(() => env.close());

const PDF = Buffer.from('%PDF-1.4\n%fake report\n');
const SAND_ROWS = [[9.5, 100], [4.75, 95], [2.36, 80], [1.18, 60], [0.6, 40], [0.3, 15], [0.15, 5]];
const gradation = (rows = SAND_ROWS) => [150, 75, 37.5, 19].map((s) => ({ sieve_mm: s, passing_pct: 100 })).concat(rows.map(([s, p]) => ({ sieve_mm: s!, passing_pct: p! })));
let n = 0;
const newMaterial = async (agent = mgr, over: Record<string, unknown> = {}) =>
  (await agent.post('/api/materials').send({ category: 'fine_agg', marketNameEn: `Sand ${++n}`, ...over })).body as { id: string };
const upload = (agent = mgr, body: Buffer = PDF, name = 'report.pdf') =>
  agent.post(`/api/attachments?filename=${encodeURIComponent(name)}`).set('Content-Type', 'application/octet-stream').send(body);

describe('materials CRUD and RBAC', () => {
  it('QC can create; procurement and viewers cannot; everyone with materials.read can list', async () => {
    const m = await newMaterial();
    expect(m.id).toBeTruthy();
    expect((await proc.post('/api/materials').send({ category: 'fine_agg', marketNameEn: 'x' })).status).toBe(403);
    expect((await viewer.get('/api/materials')).status).toBe(403);
    expect((await proc.get('/api/materials')).status).toBe(200);
  });

  it('rejects duplicate names within a category, unknown refs and unknown fields', async () => {
    const m = await newMaterial(mgr, { marketNameEn: 'Dup' });
    expect(m.id).toBeTruthy();
    expect((await mgr.post('/api/materials').send({ category: 'fine_agg', marketNameEn: 'Dup' })).status).toBe(409);
    expect((await mgr.post('/api/materials').send({ category: 'fine_agg', marketNameEn: 'Z', supplierId: '00000000-0000-4000-8000-000000000001' })).status).toBe(400);
    expect((await mgr.post('/api/materials').send({ category: 'fine_agg', marketNameEn: 'Q', bogus: 1 })).status).toBe(400);
  });

  it('plant-scoped users see tenant-level and own-plant materials only; others look non-existent', async () => {
    const own = await newMaterial(mgr, { plantId: p1.id, marketNameEn: 'Own plant sand' });
    const other = await newMaterial(mgr, { plantId: p2.id, marketNameEn: 'Other plant sand' });
    const shared = await newMaterial(mgr, { marketNameEn: 'Shared sand' });
    const names = ((await eng.get('/api/materials')).body as { marketNameEn: string }[]).map((x) => x.marketNameEn);
    expect(names).toContain('Own plant sand');
    expect(names).toContain('Shared sand');
    expect(names).not.toContain('Other plant sand');
    expect((await eng.get(`/api/materials/${own.id}`)).status).toBe(200);
    expect((await eng.get(`/api/materials/${shared.id}`)).status).toBe(200);
    const hidden = await eng.get(`/api/materials/${other.id}`);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual((await eng.get('/api/materials/00000000-0000-4000-8000-0000000000ff')).body);
    expect((await eng.patch(`/api/materials/${other.id}`).send({ notes: 'x' })).status).toBe(404);
    expect((await eng.post('/api/materials').send({ category: 'fine_agg', marketNameEn: 'Mine elsewhere', plantId: p2.id })).status).toBe(403);
  });

  it('filters by category and search text, hides inactive and soft-deleted', async () => {
    await newMaterial(mgr, { category: 'coarse_agg', marketNameEn: 'Adasiyeh 20mm', marketNameAr: 'عدسية' });
    const gone = await newMaterial(mgr, { marketNameEn: 'Doomed' });
    expect((await mgr.delete(`/api/materials/${gone.id}`)).status).toBe(200);
    const all = (await mgr.get('/api/materials')).body as { marketNameEn: string; category: string }[];
    expect(all.map((x) => x.marketNameEn)).not.toContain('Doomed');
    expect((await mgr.get('/api/materials?category=coarse_agg')).body.every((x: { category: string }) => x.category === 'coarse_agg')).toBe(true);
    expect((await mgr.get('/api/materials?q=عدسية')).body).toHaveLength(1);
    expect((await mgr.get('/api/materials?q=100%25')).body).toHaveLength(0);
    const rows = await env.db.select().from(schema.materials).where(eq(schema.materials.id, gone.id));
    expect(rows[0]?.deletedAt).not.toBeNull(); // soft delete: the row remains
  });

  it('a tested material cannot change supplier or source', async () => {
    const sup = (await mgr.post('/api/suppliers').send({ nameAr: 'مورد', nameEn: 'Supplier A' })).body;
    const sup2 = (await mgr.post('/api/suppliers').send({ nameAr: 'مورد٢', nameEn: 'Supplier B' })).body;
    const m = await newMaterial(mgr, { supplierId: sup.id });
    expect((await mgr.patch(`/api/materials/${m.id}`).send({ supplierId: sup2.id })).status).toBe(200); // untested: fine
    await mgr.post(`/api/materials/${m.id}/tests`).send({ properties: { sg_ssd: 2.6 }, source: 'user_declared', declaredReason: 'estimate', testedAt: '2026-09-01' });
    expect((await mgr.patch(`/api/materials/${m.id}`).send({ supplierId: sup.id })).status).toBe(409);
    expect((await mgr.patch(`/api/materials/${m.id}`).send({ sourceName: 'Other quarry' })).status).toBe(409);
    expect((await mgr.patch(`/api/materials/${m.id}`).send({ notes: 'fine' })).status).toBe(200);
  });
});

describe('suppliers', () => {
  it('procurement can write, viewers cannot; soft delete keeps the row', async () => {
    const s = await proc.post('/api/suppliers').send({ nameAr: 'مورد الأردن', nameEn: 'Jordan Aggregates', phone: '+962 6 000' });
    expect(s.status).toBe(201);
    expect((await proc.patch(`/api/suppliers/${s.body.id}`).send({ city: 'Amman' })).body.city).toBe('Amman');
    expect((await viewer.post('/api/suppliers').send({ nameAr: 'x', nameEn: 'x' })).status).toBe(403);
    expect((await proc.delete(`/api/suppliers/${s.body.id}`)).status).toBe(200);
    expect(((await proc.get('/api/suppliers')).body as { id: string }[]).map((x) => x.id)).not.toContain(s.body.id);
    expect((await proc.patch(`/api/suppliers/${s.body.id}`).send({ city: 'x' })).status).toBe(404);
  });
});

describe('test versions, provenance and readiness', () => {
  it('SG + absorption alone evaluates; design lists gradation as a named blocker (F-007)', async () => {
    const m = await newMaterial();
    const r = await mgr.post(`/api/materials/${m.id}/tests`).send({ properties: { sg_ssd: 2.62, absorption_pct: 1.4 }, source: 'user_declared', declaredReason: 'verbal from supplier', testedAt: '2026-09-01' });
    expect(r.status).toBe(201);
    expect(r.body.summary).toMatchObject({ canEvaluate: true, canDesign: false });
    const detail = (await mgr.get(`/api/materials/${m.id}/readiness`)).body;
    expect(detail.designBlockers.map((b: { field: string }) => b.field)).toEqual(['sieve_analysis', 'finer_75um_pct']);
    expect(detail.declaredKeyFields).toEqual(expect.arrayContaining(['sg_ssd', 'absorption_pct']));
  });

  it('computes FM from a complete gradation; non-monotonic and malformed gradations are rejected', async () => {
    const m = await newMaterial();
    const bad = await mgr.post(`/api/materials/${m.id}/tests`).send({ properties: { sieve_analysis: gradation([[9.5, 100], [4.75, 90], [2.36, 95]]) }, source: 'lab_report', testedAt: '2026-09-01' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('not_monotonic');
    const ok = await mgr.post(`/api/materials/${m.id}/tests`).send({
      properties: { sg_ssd: 2.6, absorption_pct: 1.2, finer_75um_pct: 3, sieve_analysis: gradation() },
      source: 'user_declared',
      declaredReason: 'typed from a paper sheet',
      testedAt: '2026-09-01',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.summary.fm).toBeCloseTo(3.05, 9);
    expect(ok.body.summary.canDesign).toBe(true);
  });

  it('a lab_report value needs an attachment; a declared value needs a reason', async () => {
    const m = await newMaterial();
    const base = { properties: { sg_ssd: 2.6 }, testedAt: '2026-09-01' };
    expect((await mgr.post(`/api/materials/${m.id}/tests`).send({ ...base, source: 'lab_report' })).status).toBe(400);
    expect((await mgr.post(`/api/materials/${m.id}/tests`).send({ ...base, source: 'user_declared' })).status).toBe(400);
    expect((await mgr.post(`/api/materials/${m.id}/tests`).send({ ...base, source: 'lab_report', attachmentId: '00000000-0000-4000-8000-000000000001' })).status).toBe(400);
    const att = (await upload()).body;
    const r = await mgr.post(`/api/materials/${m.id}/tests`).send({ ...base, source: 'lab_report', attachmentId: att.id, labRef: 'LR-100' });
    expect(r.status).toBe(201);
    expect(r.body.test.source).toBe('lab_report');
    expect(r.body.test.attachment.filename).toBe('report.pdf');
  });

  it('versions: new version supersedes, history is kept, unchanged fields keep their provenance, nothing-changed is 409', async () => {
    const m = await newMaterial();
    const att = (await upload()).body;
    const v1 = await mgr.post(`/api/materials/${m.id}/tests`).send({ properties: { sg_ssd: 2.6, absorption_pct: 1.2 }, source: 'lab_report', attachmentId: att.id, testedAt: '2026-08-01' });
    expect(v1.body.test.version).toBe(1);
    const same = await mgr.post(`/api/materials/${m.id}/tests`).send({ properties: { sg_ssd: 2.6, absorption_pct: 1.2 }, source: 'user_declared', declaredReason: 'retype', testedAt: '2026-09-01' });
    expect(same.status).toBe(409);
    const v2 = await mgr.post(`/api/materials/${m.id}/tests`).send({ properties: { sg_ssd: 2.6, absorption_pct: 1.5, finer_75um_pct: 4 }, source: 'user_declared', declaredReason: 'my own check', testedAt: '2026-09-01' });
    expect(v2.status).toBe(201);
    expect(v2.body.test.version).toBe(2);
    expect(v2.body.test.fieldSources).toEqual({ sg_ssd: 'lab_report', absorption_pct: 'user_declared', finer_75um_pct: 'user_declared' });
    expect(v2.body.test.source).toBe('user_declared'); // weakest field wins
    const hist = (await mgr.get(`/api/materials/${m.id}/tests`)).body;
    expect(hist.map((t: { version: number; isCurrent: boolean }) => [t.version, t.isCurrent])).toEqual([[2, true], [1, false]]);
    expect(v2.body.summary.drift.find((d: { field: string }) => d.field === 'absorption_pct')).toMatchObject({ delta: 0.3, status: 'no_tolerance' });
    // upgrade the source later: attach a report to the declared value → new version, history keeps both
    const att2 = (await upload()).body;
    const v3 = await mgr.post(`/api/materials/${m.id}/tests`).send({ properties: { sg_ssd: 2.6, absorption_pct: 1.5, finer_75um_pct: 4 }, fieldSources: { absorption_pct: 'lab_report', finer_75um_pct: 'lab_report' }, source: 'lab_report', attachmentId: att2.id, testedAt: '2026-09-02' });
    expect(v3.status, JSON.stringify(v3.body)).toBe(201);
    expect(v3.body.test.version).toBe(3);
    expect(v3.body.test.source).toBe('lab_report'); // every field is now lab-sourced
    expect(((await mgr.get(`/api/materials/${m.id}/tests`)).body as unknown[]).length).toBe(3); // history keeps all versions
  });

  it('sanity ranges warn but never block; limits are not configured so freshness is never "fresh"', async () => {
    const m = await newMaterial();
    const r = await mgr.post(`/api/materials/${m.id}/tests`).send({ properties: { sg_ssd: 3.6, absorption_pct: 9 }, source: 'user_declared', declaredReason: 'odd material', testedAt: '2026-09-01' });
    expect(r.status).toBe(201);
    expect(r.body.warnings.map((w: { field: string }) => w.field)).toEqual(['sg_ssd', 'absorption_pct']);
    expect(r.body.summary.freshness.status).toBe('not_configured');
  });

  it('unknown properties, bad values and an empty test are rejected', async () => {
    const m = await newMaterial();
    const send = (properties: object) => mgr.post(`/api/materials/${m.id}/tests`).send({ properties, source: 'user_declared', declaredReason: 'x y z', testedAt: '2026-09-01' });
    expect((await send({ bogus: 1 })).status).toBe(400);
    expect((await send({ sg_ssd: -2 })).status).toBe(400);
    expect((await send({})).status).toBe(400);
  });

  it('records who declared a value and when', async () => {
    const m = await newMaterial();
    const r = await mgr.post(`/api/materials/${m.id}/tests`).send({ properties: { sg_ssd: 2.6 }, source: 'user_declared', declaredReason: 'datasheet lost', testedAt: '2026-09-01' });
    expect(r.body.test.declaredBy).toBeTruthy();
    expect(r.body.test.declaredAt).toBeTruthy();
    const detail = (await mgr.get(`/api/materials/${m.id}`)).body;
    expect(detail.current.declaredReason).toBe('datasheet lost');
    expect(detail.summary.source).toBe('user_declared');
  });

  it('drift reports raw deltas with no tolerance configured; the list reports readiness', async () => {
    const m = await newMaterial();
    await mgr.post(`/api/materials/${m.id}/tests`).send({ properties: { sg_ssd: 2.6, absorption_pct: 1.0 }, source: 'user_declared', declaredReason: 'first', testedAt: '2026-08-01' });
    const r = await mgr.post(`/api/materials/${m.id}/tests`).send({ properties: { sg_ssd: 2.6, absorption_pct: 1.6 }, source: 'user_declared', declaredReason: 'second', testedAt: '2026-09-01' });
    expect(r.body.summary.drift.find((d: { field: string }) => d.field === 'absorption_pct').delta).toBeCloseTo(0.6, 9);
    const list = (await mgr.get(`/api/materials?q=${encodeURIComponent((await mgr.get(`/api/materials/${m.id}`)).body.material.marketNameEn)}`)).body;
    expect(list[0]).toMatchObject({ canEvaluate: true, canDesign: false, source: 'user_declared', version: 2 });
  });
});

describe('plant manager test entry', () => {
  it('only for materials homed at an own plant', async () => {
    const own = await newMaterial(mgr, { plantId: p1.id });
    const shared = await newMaterial(mgr);
    const body = { properties: { sg_ssd: 2.6 }, source: 'user_declared', declaredReason: 'bench check', testedAt: '2026-09-01' };
    expect((await pm1.post(`/api/materials/${own.id}/tests`).send(body)).status).toBe(201);
    expect((await pm1.post(`/api/materials/${shared.id}/tests`).send(body)).status).toBe(403);
    expect((await pm1.post('/api/materials').send({ category: 'fine_agg', marketNameEn: 'x' })).status).toBe(403);
    expect((await pm1.get(`/api/materials/${own.id}`)).status).toBe(200);
  });
});

describe('promote an ad-hoc material', () => {
  it('creates a library material with a user_declared test and hands the price back (F-007)', async () => {
    const r = await mgr.post('/api/materials/promote').send({
      material: { category: 'fine_agg', market_name_en: 'What-if sand', properties: { sg_ssd: 2.65, absorption_pct: 0.9 }, price_jod_per_kg: '0.011' },
      reason: 'will be stocked from next month',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.material.promotedFrom).toBe('ad_hoc');
    expect(r.body.test.source).toBe('user_declared');
    expect(r.body.pendingPriceJodPerKg).toBe('0.011');
    expect((await eng.post('/api/materials/promote').send({ material: { category: 'fine_agg', market_name_en: 'x', properties: {} }, reason: 'abc' })).status).toBe(400);
    expect((await viewer.post('/api/materials/promote').send({})).status).toBe(403);
  });
});

describe('attachments', () => {
  it('accepts PDF/PNG/JPEG by signature and rejects everything else', async () => {
    expect((await upload()).body).toMatchObject({ contentType: 'application/pdf', sizeBytes: PDF.length });
    expect((await upload(mgr, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'a.png')).body.contentType).toBe('image/png');
    expect((await upload(mgr, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]), 'a.jpg')).body.contentType).toBe('image/jpeg');
    expect((await upload(mgr, Buffer.from('<html><script>alert(1)</script>'), 'evil.pdf')).status).toBe(415);
    expect((await upload(mgr, Buffer.alloc(0))).status).toBe(400);
    expect((await mgr.post('/api/attachments').send({})).status).toBe(400);
    expect((await upload(mgr, Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]))).status).toBe(413);
    expect((await upload(viewer)).status).toBe(403);
  });

  it('downloads only as an attachment with nosniff, and respects plant scope', async () => {
    const other = await newMaterial(mgr, { plantId: p2.id });
    const att = (await upload(mgr, Buffer.concat([PDF, Buffer.from('other plant')]), '../../etc/pass wd.pdf')).body;
    expect(att.filename).not.toContain('/');
    await mgr.post(`/api/materials/${other.id}/tests`).send({ properties: { sg_ssd: 2.6 }, source: 'lab_report', attachmentId: att.id, testedAt: '2026-09-01' });
    const res = await mgr.get(`/api/attachments/${att.id}`).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await eng.get(`/api/attachments/${att.id}`)).status).toBe(404); // p1 engineer cannot see p2's evidence
    expect((await mgr.get('/api/attachments/00000000-0000-4000-8000-0000000000ff')).status).toBe(404);
  });

  it('is immutable in the database', async () => {
    const att = (await upload()).body;
    await expect(env.pool.query('update attachments set filename = $1 where id = $2', ['x', att.id])).rejects.toThrow();
    await expect(env.pool.query('delete from attachments where id = $1', [att.id])).rejects.toThrow();
  });
});

describe('database integrity', () => {
  it('test content is immutable, tests are never deleted, one current per material, lab needs attachment', async () => {
    const m = await newMaterial();
    const r = await mgr.post(`/api/materials/${m.id}/tests`).send({ properties: { sg_ssd: 2.6 }, source: 'user_declared', declaredReason: 'abc', testedAt: '2026-09-01' });
    const id = r.body.test.id;
    await expect(env.pool.query("update material_tests set properties = '{\"sg_ssd\": 9}' where id = $1", [id])).rejects.toThrow(/immutable/);
    await expect(env.pool.query('delete from material_tests where id = $1', [id])).rejects.toThrow();
    await expect(env.pool.query('delete from materials where id = $1', [m.id])).rejects.toThrow();
    await expect(
      env.pool.query(
        `insert into material_tests (tenant_id, material_id, version, source, properties, tested_at, declared_by, declared_at)
         select tenant_id, material_id, 2, 'user_declared', '{"sg_ssd": 2.7}', '2026-09-02', declared_by, now() from material_tests where id = $1`,
        [id],
      ),
    ).rejects.toThrow(); // a second CURRENT version violates the one-current index
    await expect(
      env.pool.query(
        `insert into material_tests (tenant_id, material_id, version, is_current, source, properties, tested_at)
         select tenant_id, material_id, 9, false, 'lab_report', '{}', '2026-09-02' from material_tests where id = $1`,
        [id],
      ),
    ).rejects.toThrow(/lab_needs_attachment/);
  });
});

describe('audit', () => {
  it('records material, test, supplier and attachment writes', async () => {
    const actions = new Set((await env.auditRows()).map((a) => a.action));
    for (const a of ['material.create', 'material.update', 'material.delete', 'material.test.create', 'material.promote', 'supplier.create', 'attachment.upload'])
      expect(actions, a).toContain(a);
  });
});
