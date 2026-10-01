import { schema } from '@khalta/db';
import { todayAmman } from '@khalta/engine';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';

type Agent = Awaited<ReturnType<TestEnv['login']>>;
let env: TestEnv;
let p1: { id: string; code: string }, p2: { id: string; code: string };
let admin: Agent, proc: Agent, mgr: Agent, pm: Agent, sales: Agent;
let sup1: { id: string }, sup2: { id: string };
let cement: { id: string }, sand: { id: string }, admix: { id: string }, water: { id: string };

const today = todayAmman();
const day = (n: number) =>
  new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  env = await createTestEnv({}, { seedRules: true });
  p1 = await env.seedPlant('AMM-01');
  p2 = await env.seedPlant('AQB-01');
  admin = await env.login((await env.seedUser('admin')).email);
  mgr = await env.login((await env.seedUser('qc_manager')).email);
  proc = await env.login((await env.seedUser('procurement', { plantIds: [p1.id] })).email);
  pm = await env.login((await env.seedUser('plant_manager', { plantIds: [p1.id] })).email);
  sales = await env.login((await env.seedUser('sales')).email);
  sup1 = (await mgr.post('/api/suppliers').send({ nameAr: 'مورد ١', nameEn: 'Supplier One' })).body;
  sup2 = (await mgr.post('/api/suppliers').send({ nameAr: 'مورد ٢', nameEn: 'Supplier Two' })).body;
  const mk = async (category: string, name: string, supplierId?: string) =>
    (await mgr.post('/api/materials').send({ category, marketNameEn: name, supplierId })).body as {
      id: string;
    };
  cement = await mk('cement', 'Cement P', sup1.id);
  sand = await mk('fine_agg', 'Sand P', sup1.id);
  admix = await mk('admixture', 'Admix P', sup1.id);
  water = await mk('water', 'Water P');
  await mgr.post(`/api/materials/${admix.id}/tests`).send({
    properties: { sg: 1.1 },
    source: 'user_declared',
    declaredReason: 'datasheet value',
    testedAt: day(0),
  });
});
afterAll(() => env.close());

const set = (agent: Agent, entries: object[], extra: object = {}) =>
  agent.post('/api/prices').send({ entries, ...extra });
const cellOf = async (agent: Agent, m: { id: string }, p: { id: string }) =>
  ((await agent.get('/api/prices')).body.cells as { materialId: string; plantId: string }[]).find(
    (c) => c.materialId === m.id && c.plantId === p.id,
  ) as Record<string, unknown> | undefined;
const e = (
  m: { id: string },
  p: { id: string },
  price: string,
  unit = 'JOD/ton',
  more: object = {},
) => ({ materialId: m.id, plantId: p.id, price, unit, ...more });

describe('setting prices and keeping history', () => {
  it('first price, then a new price closes the previous period; history is complete', async () => {
    expect(
      (
        await set(admin, [e(cement, p1, '80.000')], {
          effectiveFrom: day(-10),
          reason: 'initial list',
        })
      ).status,
    ).toBe(201);
    const r = await set(admin, [e(cement, p1, '85.500')], {
      effectiveFrom: day(-2),
      reason: 'new tariff',
    });
    expect(r.body).toMatchObject({ applied: 1, unchanged: 0 });
    const hist = (await admin.get(`/api/prices/history?materialId=${cement.id}&plantId=${p1.id}`))
      .body;
    expect(hist.map((h: { price: string }) => h.price)).toEqual(['85.500', '80.000']);
    expect(hist[1].effectiveTo).toBe(day(-3));
    expect(hist[0].effectiveTo).toBeNull();
    expect(await cellOf(admin, cement, p1)).toMatchObject({
      status: 'ok',
      price: '85.500',
      jodPerKg: '0.085500000',
    });
  });

  it('unchanged values are skipped; a same-day correction supersedes but keeps the old row', async () => {
    expect((await set(admin, [e(cement, p1, '85.500')])).body).toMatchObject({
      applied: 0,
      unchanged: 1,
    });
    const fix = await set(admin, [e(cement, p1, '86.000')], {
      effectiveFrom: day(-2),
      reason: 'typo',
    });
    expect(fix.body.applied).toBe(1);
    const hist = (await admin.get(`/api/prices/history?materialId=${cement.id}&plantId=${p1.id}`))
      .body;
    expect(hist).toHaveLength(3);
    expect(hist.filter((h: { supersededAt: string | null }) => h.supersededAt)).toHaveLength(1);
    expect(await cellOf(admin, cement, p1)).toMatchObject({ price: '86.000' });
  });

  it('rejects a start earlier than the latest price, a missing back-date reason and bad values', async () => {
    expect(
      (await set(admin, [e(cement, p1, '70.000')], { effectiveFrom: day(-5), reason: 'too early' }))
        .status,
    ).toBe(409);
    expect((await set(admin, [e(cement, p1, '90.000')], { effectiveFrom: day(-1) })).status).toBe(
      400,
    );
    for (const price of ['1.2345', '-1', 'abc', ''])
      expect((await set(admin, [e(cement, p1, price)])).status, price).toBe(400);
    expect((await set(admin, [e(cement, p1, '5', 'JOD/bag')])).status).toBe(400);
    expect(
      (await admin.get(`/api/prices/history?materialId=${cement.id}&plantId=${p1.id}`)).body,
    ).toHaveLength(3); // nothing was half-applied
  });

  it('a future-dated price waits; lookup by date uses the period in force', async () => {
    await set(admin, [e(sand, p1, '10.000')], { effectiveFrom: day(-30), reason: 'start' });
    await set(admin, [e(sand, p1, '12.000')], { effectiveFrom: day(5) });
    expect(await cellOf(admin, sand, p1)).toMatchObject({ price: '10.000' });
    const later = (await admin.get(`/api/prices?asOf=${day(6)}`)).body.cells.find(
      (c: { materialId: string }) => c.materialId === sand.id,
    );
    expect(later.price).toBe('12.000');
  });

  it('is append-only and non-overlapping in the database itself', async () => {
    const [row] = await env.db
      .select()
      .from(schema.materialPrices)
      .where(eq(schema.materialPrices.materialId, cement.id));
    await expect(
      env.pool.query('update material_prices set price = 1 where id = $1', [row!.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      env.pool.query('delete from material_prices where id = $1', [row!.id]),
    ).rejects.toThrow();
    await expect(
      env.pool.query(
        `insert into material_prices (tenant_id, material_id, plant_id, supplier_id, price, unit, effective_from)
         select tenant_id, material_id, plant_id, supplier_id, 1, 'JOD/kg', effective_from from material_prices
          where id = (select id from material_prices where material_id = $1 and superseded_at is null and effective_to is null limit 1)`,
        [cement.id],
      ),
    ).rejects.toThrow(/overlap|conflicting|exclusion/i);
  });
});

describe('units, availability, staleness', () => {
  it('converts per ton / kg / litre; names why a price cannot be converted; no price is not zero', async () => {
    await set(admin, [
      e(admix, p1, '1.100', 'JOD/L'),
      e(water, p1, '0.500', 'JOD/m3', { supplierId: sup1.id }),
      e(sand, p2, '0.012', 'JOD/kg'),
    ]);
    expect(await cellOf(admin, admix, p1)).toMatchObject({
      jodPerKg: '1.000000000',
      unit: 'JOD/L',
    });
    expect(await cellOf(admin, water, p1)).toMatchObject({
      jodPerKg: null,
      notConvertible: 'needs_density',
    });
    expect(await cellOf(admin, sand, p2)).toMatchObject({ jodPerKg: '0.012000000' });
    expect(await cellOf(admin, cement, p2)).toBeUndefined();
    const lit = await set(admin, [e(cement, p2, '3.000', 'JOD/L')]);
    expect(lit.status).toBe(201);
    expect(await cellOf(admin, cement, p2)).toMatchObject({
      jodPerKg: null,
      notConvertible: 'needs_sg',
    });
  });

  it('staleness is "not configured" until the limit is set, then flags old prices', async () => {
    const before = (await admin.get('/api/prices')).body;
    expect(before.summary.staleLimitDays).toBeNull();
    expect(
      before.cells.every(
        (c: { staleness?: { status: string } }) => c.staleness?.status === 'not_configured',
      ),
    ).toBe(true);
    expect((await admin.patch('/api/settings').send({ stalePriceDays: 7 })).status).toBe(200);
    const after = (await admin.get('/api/prices')).body;
    expect(after.summary.stale).toBeGreaterThan(0);
    const c = after.cells.find(
      (x: { materialId: string; plantId: string }) =>
        x.materialId === sand.id && x.plantId === p1.id,
    );
    expect(c.staleness.status).toBe('stale');
    await admin.patch('/api/settings').send({ stalePriceDays: null });
  });

  it('coverage counts priced plants per material', async () => {
    const cov = (await admin.get('/api/prices/coverage')).body;
    expect(cov.plants).toBe(2);
    expect(cov.priced[sand.id]).toBe(2);
  });
});

describe('several suppliers, preference, copy, bulk change', () => {
  it('two suppliers at one cell are ambiguous until one is preferred', async () => {
    const m = (
      await mgr.post('/api/materials').send({ category: 'cement', marketNameEn: 'Cement Q' })
    ).body;
    expect((await set(admin, [e(m, p1, '90.000')])).body.error.code).toBe('supplier_required');
    expect(
      (await set(admin, [e(m, p1, '90.000', 'JOD/ton', { supplierId: sup1.id })])).status,
    ).toBe(201);
    await set(admin, [e(m, p1, '88.000', 'JOD/ton', { supplierId: sup2.id })]);
    const c = await cellOf(admin, m, p1);
    expect(c).toMatchObject({ status: 'ok', supplierId: sup1.id, alternatives: 1 }); // the first priced supplier became the preference
    expect(
      (
        await admin
          .post('/api/prices/preferred')
          .send({ materialId: m.id, plantId: p1.id, supplierId: sup2.id })
      ).status,
    ).toBe(200);
    expect(await cellOf(admin, m, p1)).toMatchObject({ supplierId: sup2.id, price: '88.000' });
    const none = await admin
      .post('/api/prices/preferred')
      .send({ materialId: sand.id, plantId: p1.id, supplierId: sup2.id });
    expect(none.status).toBe(409);
  });

  it('bulk change previews exactly what it applies; 0 % reconfirms with a new period', async () => {
    const body = {
      percent: '10',
      plantIds: [p1.id],
      materialIds: [cement.id],
      reason: 'inflation',
    };
    const prev = (await admin.post('/api/prices/bulk-change/preview').send(body)).body;
    expect(prev.rows.map((r: { to: string }) => r.to).sort()).toEqual(['94.600']);
    // sand already has a price scheduled for the future: a change effective today would predate it
    const clash = await admin
      .post('/api/prices/bulk-change')
      .send({ ...body, materialIds: [sand.id] });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('earlier_than_latest');
    const done = (await admin.post('/api/prices/bulk-change').send(body)).body;
    expect(done.applied).toBe(prev.count);
    expect(await cellOf(admin, cement, p1)).toMatchObject({ price: '94.600' });
    const re = (
      await admin.post('/api/prices/bulk-change').send({
        percent: '0',
        plantIds: [p1.id],
        materialIds: [cement.id],
        effectiveFrom: day(1),
        reason: 'reconfirmed',
      })
    ).body;
    expect(re.applied).toBe(1);
    expect(
      (await admin.post('/api/prices/bulk-change').send({ percent: '-100.5', plantIds: [p1.id] }))
        .status,
    ).toBe(400);
  });

  it('copy skips cells that already have a price unless overwrite is set', async () => {
    const r = (
      await admin
        .post('/api/prices/copy')
        .send({ fromPlantId: p1.id, toPlantId: p2.id, effectiveFrom: day(1), reason: 'copy' })
    ).body;
    expect(r.applied).toBeGreaterThan(0);
    expect(await cellOf(admin, sand, p2)).toMatchObject({ price: '0.012' });
    expect(
      (await admin.post('/api/prices/copy').send({ fromPlantId: p1.id, toPlantId: p1.id })).status,
    ).toBe(400);
  });
});

describe('access control', () => {
  it('only Admin and Procurement edit; scoped users cannot touch other plants; Sales sees nothing', async () => {
    expect((await set(mgr, [e(cement, p1, '1')])).status).toBe(403);
    expect((await set(pm, [e(cement, p1, '1')])).status).toBe(403);
    expect((await set(proc, [e(cement, p2, '1.000')])).status).toBe(404);
    expect((await set(proc, [e(sand, p1, '11.500')], { effectiveFrom: day(6) })).status).toBe(201);
    expect((await sales.get('/api/prices')).status).toBe(403);
    const m = (await pm.get('/api/prices')).body;
    expect(m.plants.map((p: { id: string }) => p.id)).toEqual([p1.id]);
    expect(m.cells.every((c: { plantId: string }) => c.plantId === p1.id)).toBe(true);
    expect(
      (await pm.get(`/api/prices/history?materialId=${cement.id}&plantId=${p2.id}`)).status,
    ).toBe(404);
    expect((await pm.post('/api/prices/export').send({ format: 'csv' })).status).toBe(403);
  });
});

describe('import and export', () => {
  const csv = (rows: string[]) =>
    Buffer.from(
      ['material,plant,supplier,price,unit,includes delivery,effective from,reason', ...rows].join(
        '\n',
      ),
    );
  const upload = (agent: Agent, buf: Buffer, name = 'prices.csv') =>
    agent
      .post(`/api/prices/import/preview?filename=${name}`)
      .set('Content-Type', 'application/octet-stream')
      .send(buf);

  it('previews every row, refuses to commit errors, and applies a clean file all or nothing', async () => {
    const bad = await upload(
      admin,
      csv([
        'Cement P,AMM-01,,abc,JOD/ton,,,',
        'Nope,AMM-01,,5,JOD/ton,,,',
        'Sand P,ZZZ,,5,JOD/ton,,,',
        'Sand P,AMM-01,,5,JOD/ton,,,',
      ]),
    );
    expect(bad.status).toBe(200);
    expect(bad.body.summary).toMatchObject({ total: 4, errors: 4 });
    expect(bad.body.rows.map((r: { errors: string[] }) => r.errors[0])).toEqual([
      'not_a_number',
      'unknown_material',
      'unknown_plant',
      'earlier_than_latest', // a scheduled price already starts later
    ]);
    expect(
      (await admin.post('/api/prices/import/commit').send({ batchId: bad.body.batchId })).status,
    ).toBe(400);

    const ok = await upload(
      admin,
      csv([
        `Cement P,AMM-01,Supplier One,"٩٨٫٥",JOD/ton,yes,${day(2)},`,
        `Sand P,AMM-01,,11.500,ton,,${day(6)},`,
        'Water P,AMM-01,Supplier One,0.6,m3,,,',
      ]),
    );
    expect(ok.body.summary).toMatchObject({ total: 3, ok: 2, unchanged: 1, errors: 0 });
    const done = await admin.post('/api/prices/import/commit').send({ batchId: ok.body.batchId });
    expect(done.body).toMatchObject({ applied: 2, unchanged: 0 });
    const future = (await admin.get(`/api/prices?asOf=${day(2)}`)).body.cells.find(
      (c: { materialId: string; plantId: string }) =>
        c.materialId === cement.id && c.plantId === p1.id,
    );
    expect(future.price).toBe('98.500'); // Arabic digits and the decimal separator were read correctly
    expect(
      (await admin.post('/api/prices/import/commit').send({ batchId: ok.body.batchId })).status,
    ).toBe(409);
  });

  it('refuses a commit when prices changed after the preview', async () => {
    const prev = await upload(
      admin,
      csv([`Sand P,AMM-01,Supplier One,13.000,JOD/ton,,${day(8)},`]),
    );
    await set(admin, [e(sand, p1, '12.750')], { effectiveFrom: day(9) });
    expect(
      (await admin.post('/api/prices/import/commit').send({ batchId: prev.body.batchId })).status,
    ).toBe(409);
  });

  it('rejects missing columns and unsupported files', async () => {
    const r = await upload(admin, Buffer.from('material,price\nSand P,5'));
    expect(r.status).toBe(400);
    expect(r.body.error.details.missing).toEqual(expect.arrayContaining(['plant', 'unit']));
    expect((await upload(admin, Buffer.from('x'), 'a.pdf')).status).toBe(415);
    expect((await admin.post('/api/prices/import/preview').send({})).status).toBe(400);
  });

  it('exports xlsx and csv, and the export is audited', async () => {
    const res = await admin.post('/api/prices/export').send({ format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.text).toContain('Cement P');
    const x = await admin
      .post('/api/prices/export')
      .send({ format: 'xlsx' })
      .buffer(true)
      .parse((r, cb) => {
        const c: Buffer[] = [];
        r.on('data', (d: Buffer) => c.push(d));
        r.on('end', () => cb(null, Buffer.concat(c)));
      });
    expect((x.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    expect((await env.auditRows()).filter((a) => a.action === 'price.export')).toHaveLength(2);
  });
});

describe('snapshots', () => {
  it('freezes the prices in force, is immutable and verifies its own hash', async () => {
    const s = await admin.post('/api/price-snapshots').send({ name: 'Baseline test' });
    expect(s.status).toBe(201);
    await set(admin, [e(sand, p1, '99.000')], { effectiveFrom: day(30) });
    const detail = (await admin.get(`/api/price-snapshots/${s.body.id}`)).body;
    expect(detail.hashOk).toBe(true);
    expect(detail.lines.length).toBe(s.body.lineCount);
    expect(
      detail.lines.find(
        (l: { materialId: string; plantId: string }) =>
          l.materialId === sand.id && l.plantId === p1.id,
      ).price,
    ).not.toBe('99.000');
    const missing = detail.lines.find((l: { status: string }) => l.status === 'unavailable');
    expect(missing).toBeTruthy();
    await expect(
      env.pool.query('update price_snapshot_lines set price = 1 where snapshot_id = $1', [
        s.body.id,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.pool.query('delete from price_snapshots where id = $1', [s.body.id]),
    ).rejects.toThrow();
    expect(((await admin.get('/api/price-snapshots')).body as unknown[]).length).toBe(1);
    expect((await pm.get(`/api/price-snapshots/${s.body.id}`)).status).toBe(404); // spans a plant outside pm's scope
  });
});

describe('performance: 20 plants × 200 materials pasted at once', () => {
  it('commits 4,000 prices in under 2 seconds', async () => {
    const plants: { id: string }[] = [];
    for (let i = 0; i < 18; i++) plants.push(await env.seedPlant(`P${100 + i}`));
    const [t] = await env.db.select({ id: schema.tenants.id }).from(schema.tenants);
    const rows = await env.db
      .insert(schema.materials)
      .values(
        Array.from({ length: 200 }, (_, i) => ({
          tenantId: t!.id,
          category: 'coarse_agg',
          marketNameEn: `Bulk ${i}`,
          supplierId: sup1.id,
        })),
      )
      .returning({ id: schema.materials.id });
    const all = [p1, p2, ...plants];
    const entries = rows.flatMap((m, i) =>
      all.map((p, j) => ({
        materialId: m.id,
        plantId: p.id,
        price: (5 + ((i + j) % 40) / 10).toFixed(3),
        unit: 'JOD/ton',
      })),
    );
    expect(entries).toHaveLength(4000);
    const t0 = performance.now();
    const res = await admin.post('/api/prices').send({ entries });
    const ms = performance.now() - t0;
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(201);
    expect(res.body.applied).toBe(4000);
    process.stderr.write(`\n4000-cell paste: ${Math.round(ms)} ms\n`);
    expect(ms).toBeLessThan(2000);
    const m0 = Date.now();
    expect((await admin.get('/api/prices')).status).toBe(200);
    process.stderr.write(`matrix load: ${Date.now() - m0} ms\n`);
  });
});

describe('audit', () => {
  it('records price writes, preferences, imports and snapshots', async () => {
    const actions = new Set((await env.auditRows()).map((a) => a.action));
    for (const a of [
      'price.set',
      'price.preferred',
      'price.import.preview',
      'price.import.commit',
      'price.snapshot',
    ])
      expect(actions, a).toContain(a);
  });
});
