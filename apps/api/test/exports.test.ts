import { createHash } from 'node:crypto';
import { schema } from '@khalta/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { supersede } from '../src/rules/service';
import { versionHash, designLines } from '../src/lifecycle/service';
import { createTestEnv, type TestEnv } from './helpers';
import { optimizerWorld, REQUIREMENTS as BASE } from './opt-world';

// SYNTHETIC world, SYNTHETIC trial criteria and moisture limits: labelled test data, not a plant's values.
const REQUIREMENTS = { ...BASE, testAgeDays: 28 };
const LIMITS = {
  'eng.moisture.max_total_pct': 15,
  'eng.moisture.stale_hours': 24,
  'eng.trial.slump_tolerance_mm': 25,
  'eng.trial.air_tolerance_pct': 1.5,
  'eng.trial.density_band_kg_m3': 40,
  'eng.trial.yield_band_m3': 0.01,
  'eng.trial.temperature_max_c': 32,
};
const SIGN = { reason: 'Reviewed and signed in the lab test' };
let env: TestEnv;
let plantA: string;
let plantB: string;

beforeAll(async () => {
  env = await createTestEnv();
  [plantA, plantB] = (await optimizerWorld(env, ['EXP-A', 'EXP-B'])).plants as [string, string];
  // the engine's SYNTHETIC aggregates carry no absorption; production conversion needs it, so a newer test adds it
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
  await setLimits(true);
  await verifyRules();
}, 120_000);
afterAll(() => env.close());

const as = async (role: Parameters<TestEnv['seedUser']>[0], plantIds: string[] = []) =>
  env.login((await env.seedUser(role, { plantIds })).email);

async function setLimits(on: boolean, only?: string[]) {
  const admin = (await env.seedUser('admin')).id;
  await env.db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(LIMITS)) {
      if (only && !only.includes(key)) continue;
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
      const want = on ? value : null;
      if (r!.row.value !== want)
        await supersede(tx, env.tenantId, admin, r!.row, { value: want }, 'ui', 'SYNTHETIC limit');
    }
  });
}
async function verifyRules() {
  await env.db.execute(sql`UPDATE rules SET verified = true, verified_at = now()
    WHERE tenant_id = ${env.tenantId} AND is_current AND (value IS NOT NULL OR definition IS NOT NULL OR inherits IS NOT NULL)`);
}
const designRow = async (id: string) =>
  (await env.db.select().from(schema.mixDesigns).where(eq(schema.mixDesigns.id, id)))[0]!;

async function trialCandidate(code: string) {
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
  return res.body.design.id as string;
}
async function aggregates(id: string) {
  const rows = await env.db
    .select({
      materialId: schema.mixDesignLines.materialId,
      category: schema.materials.category,
      kg: schema.mixDesignLines.quantityKgM3,
    })
    .from(schema.mixDesignLines)
    .innerJoin(schema.materials, eq(schema.materials.id, schema.mixDesignLines.materialId))
    .where(eq(schema.mixDesignLines.designId, id));
  return rows.filter((r) => r.category.endsWith('_agg'));
}
const moisture = async (id: string, totals: number[], measuredAt?: string) =>
  (await aggregates(id)).map((a, i) => ({
    materialId: a.materialId,
    totalMoisturePct: totals[i] ?? totals[0]!,
    ...(measuredAt ? { measuredAt } : {}),
  }));

// the engine's reference parser (RFC 4180), written independently of the writer
function parse(csv: string): string[][] {
  expect(csv.startsWith('\uFEFF')).toBe(true);
  const s = csv.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && s[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  return rows;
}
const col = (rows: string[][], name: string) => {
  const i = rows[0]!.indexOf(name);
  expect(i, name).toBeGreaterThanOrEqual(0);
  return rows.slice(1).map((r) => r[i]!);
};
const csvOf = async (client: Awaited<ReturnType<typeof as>>, path: string, body: object = {}) => {
  const res = await client
    .post(path)
    .send(body)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  return {
    status: res.status,
    headers: res.headers,
    text: res.body instanceof Buffer ? res.body.toString('utf8') : '',
    json: res.body instanceof Buffer ? null : res.body,
  };
};

async function approvedDesign(code: string) {
  const id = await trialCandidate(code);
  const lab = await as('qc_manager');
  const [ev] = await env.db
    .select()
    .from(schema.designEvaluations)
    .where(eq(schema.designEvaluations.id, (await designRow(id)).lastEvaluationId!));
  const rep = ev!.report as {
    trace: { key: string; value: number }[];
    strengthAdequacy: { fcrMpa: number };
  };
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
    resultsMpa: [rep.strengthAdequacy.fcrMpa + 3],
  });
  await lab.post(`/api/designs/${id}/start-trial`);
  expect((await lab.post(`/api/designs/${id}/pass-trial`).send(SIGN)).status).toBe(200);
  const ok = await (await as('qc_manager')).post(`/api/designs/${id}/approve`).send(SIGN);
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  return id;
}

let live: string;
let trial: string;
let suspended: string;
let instance: string;

describe('approved-design CSV (khalta.designs.v1)', () => {
  beforeAll(async () => {
    live = await approvedDesign('EXP-LIVE');
    trial = await trialCandidate('EXP-TRIAL');
    suspended = await approvedDesign('EXP-SUSP');
    const s = await (await as('qc_manager')).post(`/api/designs/${suspended}/suspend`).send(SIGN);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
  }, 120_000);

  it('RBAC: QC roles and plant managers of the plant may export; everyone else is refused', async () => {
    for (const role of ['admin', 'procurement', 'sales', 'viewer'] as const)
      expect((await csvOf(await as(role, [plantA]), '/api/exports/designs.csv')).status).toBe(403);
    for (const c of [
      await as('qc_manager'),
      await as('qc_engineer', [plantA]),
      await as('plant_manager', [plantA]),
    ])
      expect((await csvOf(c, '/api/exports/designs.csv')).status).toBe(200);
  });

  it('exports only approved and in-production designs, exactly as stored, with the version hash', async () => {
    const res = await csvOf(await as('qc_manager'), '/api/exports/designs.csv');
    const rows = parse(res.text);
    expect(new Set(col(rows, 'design_code'))).toEqual(new Set(['EXP-LIVE']));
    expect(new Set(col(rows, 'status'))).toEqual(new Set(['approved']));
    expect(new Set(col(rows, 'schema'))).toEqual(new Set(['khalta.designs.v1']));
    const d = await designRow(live);
    const lines = await env.db
      .select({ l: schema.mixDesignLines, name: schema.materials.marketNameEn })
      .from(schema.mixDesignLines)
      .innerJoin(schema.materials, eq(schema.materials.id, schema.mixDesignLines.materialId))
      .where(eq(schema.mixDesignLines.designId, live));
    expect(rows).toHaveLength(lines.length + 1);
    const q = Object.fromEntries(
      rows
        .slice(1)
        .map((r) => [r[rows[0]!.indexOf('material_id')]!, r[rows[0]!.indexOf('quantity')]!]),
    );
    for (const { l } of lines) expect(q[l.materialId]).toBe(l.quantityKgM3);
    expect(new Set(col(rows, 'design_hash'))).toEqual(
      new Set([versionHash(d, await designLines(env.db, live))]),
    );
    expect(new Set(col(rows, 'approved_by')).size).toBe(1);
    expect(col(rows, 'approved_by')[0]).not.toBe('');
    // the trial and suspended designs never appear, and no cost-like text does
    expect(res.text).not.toContain('EXP-TRIAL');
    expect(res.text).not.toContain('EXP-SUSP');
    expect(res.text).not.toMatch(/jod|price|cost|margin|saving/i);
  });

  it('the file hash is returned, in the file name, and audited; two runs are byte-identical', async () => {
    const mgr = await as('qc_manager');
    const a = await csvOf(mgr, '/api/exports/designs.csv');
    const b = await csvOf(mgr, '/api/exports/designs.csv');
    expect(a.text).toBe(b.text);
    const sha = createHash('sha256').update(a.text, 'utf8').digest('hex');
    expect(a.headers['x-khalta-sha256']).toBe(sha);
    expect(a.headers['content-disposition']).toContain(sha.slice(0, 8));
    expect(a.headers['content-disposition']).toMatch(/khalta-designs-all-\d{4}-\d{2}-\d{2}-/);
    expect(a.headers['content-type']).toContain('text/csv');
    const audits = await env.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'export.designs'), eq(schema.auditLog.entityId, sha)));
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(audits[0]!.after).toMatchObject({
      schema: 'khalta.designs.v1',
      sha256: sha,
      designs: 1,
    });
  });

  it('plant scope and filters: another plant sees nothing; a design that is not live is refused', async () => {
    const other = await csvOf(await as('plant_manager', [plantB]), '/api/exports/designs.csv');
    expect(parse(other.text)).toHaveLength(1); // header only
    expect(
      (
        await csvOf(await as('plant_manager', [plantB]), '/api/exports/designs.csv', {
          plantId: plantA,
        })
      ).status,
    ).toBe(404);
    const mgr = await as('qc_manager');
    expect((await csvOf(mgr, '/api/exports/designs.csv', { designId: trial })).status).toBe(409);
    expect((await csvOf(mgr, '/api/exports/designs.csv', { designId: suspended })).status).toBe(
      409,
    );
    const one = await csvOf(mgr, '/api/exports/designs.csv', { designId: live, plantId: plantA });
    expect(one.status).toBe(200);
    expect(one.headers['content-disposition']).toContain('khalta-designs-EXP-A-');
  });

  it('neutralises hostile names (spreadsheet formulas) without touching numbers', async () => {
    const [m] = await env.db
      .select({ id: schema.mixDesignLines.materialId })
      .from(schema.mixDesignLines)
      .where(eq(schema.mixDesignLines.designId, live))
      .limit(1);
    const [orig] = await env.db
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, m!.id));
    await env.db
      .update(schema.materials)
      .set({ marketNameEn: '=HYPERLINK("http://x","y")' })
      .where(eq(schema.materials.id, m!.id));
    await env.db
      .update(schema.mixDesigns)
      .set({ name: '@SUM(A1)' })
      .where(eq(schema.mixDesigns.id, live));
    const rows = parse((await csvOf(await as('qc_manager'), '/api/exports/designs.csv')).text);
    expect(col(rows, 'material_name')).toContain('\'=HYPERLINK("http://x","y")');
    expect(col(rows, 'design_name')[0]).toBe("'@SUM(A1)");
    for (const q of col(rows, 'quantity')) expect(q).toMatch(/^\d+\.\d+$/);
    await env.db
      .update(schema.materials)
      .set({ marketNameEn: orig!.marketNameEn })
      .where(eq(schema.materials.id, m!.id));
    await env.db
      .update(schema.mixDesigns)
      .set({ name: 'EXP-LIVE' })
      .where(eq(schema.mixDesigns.id, live));
  });

  it('a design is exported only while approved: retiring it removes it from the next file', async () => {
    const extra = await approvedDesign('EXP-GONE');
    const mgr = await as('qc_manager');
    expect(
      new Set(col(parse((await csvOf(mgr, '/api/exports/designs.csv')).text), 'design_code')),
    ).toContain('EXP-GONE');
    await env.db
      .update(schema.mixDesigns)
      .set({ status: 'retired' })
      .where(eq(schema.mixDesigns.id, extra));
    expect(
      new Set(col(parse((await csvOf(mgr, '/api/exports/designs.csv')).text), 'design_code')),
    ).not.toContain('EXP-GONE');
  });
});

describe('batch-weights CSV (khalta.batch-weights.v1)', () => {
  beforeAll(async () => {
    const eng = await as('qc_engineer', [plantA]);
    const saved = await eng
      .post(`/api/designs/${live}/batch-instances`)
      .send({ moisture: await moisture(live, [2.5, 1.2]) });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    instance = saved.body.id;
  });

  it('matches the stored instance exactly and carries the independent check verdict', async () => {
    const res = await csvOf(await as('plant_manager', [plantA]), '/api/exports/batch-weights.csv', {
      instanceId: instance,
    });
    expect(res.status, res.text).toBe(200);
    const rows = parse(res.text);
    const [b] = await env.db
      .select()
      .from(schema.batchInstances)
      .where(eq(schema.batchInstances.id, instance));
    const stored = (
      b!.result as {
        lines: { materialId: string; kgBatch: number; kgSsd: number }[];
        batchWaterKg: number;
      }
    ).lines;
    expect(rows).toHaveLength(stored.length + 1);
    expect(new Set(col(rows, 'check_verdict'))).toEqual(new Set(['pass']));
    expect(new Set(col(rows, 'batch_instance_id'))).toEqual(new Set([instance]));
    const byMat = Object.fromEntries(
      rows.slice(1).map((r) => [r[rows[0]!.indexOf('material_id')]!, r]),
    );
    for (const l of stored) {
      expect(Number(byMat[l.materialId]![rows[0]!.indexOf('kg_batch')])).toBe(l.kgBatch);
      expect(Number(byMat[l.materialId]![rows[0]!.indexOf('kg_ssd')])).toBe(l.kgSsd);
    }
    expect(Number(col(rows, 'batch_water_kg')[0])).toBe(
      (b!.result as { batchWaterKg: number }).batchWaterKg,
    );
    expect(res.text).not.toMatch(/jod|price|cost|margin|saving/i);
    const sha = createHash('sha256').update(res.text, 'utf8').digest('hex');
    expect(res.headers['x-khalta-sha256']).toBe(sha);
  });

  it('refuses trial instances, other plants and designs that are no longer live; ranges need something to export', async () => {
    const eng = await as('qc_engineer', [plantA]);
    const t = await eng
      .post(`/api/designs/${trial}/batch-instances`)
      .send({ moisture: await moisture(trial, [2]) });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect(t.body.kind).toBe('trial');
    const mgr = await as('qc_manager');
    expect(
      (await csvOf(mgr, '/api/exports/batch-weights.csv', { instanceId: t.body.id })).status,
    ).toBe(409);
    expect(
      (
        await csvOf(await as('plant_manager', [plantB]), '/api/exports/batch-weights.csv', {
          instanceId: instance,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await csvOf(await as('plant_manager', [plantB]), '/api/exports/batch-weights.csv', {
          plantId: plantA,
        })
      ).status,
    ).toBe(404);
    expect((await csvOf(mgr, '/api/exports/batch-weights.csv', {})).status).toBe(400);
    expect(
      (
        await csvOf(await as('sales', [plantA]), '/api/exports/batch-weights.csv', {
          instanceId: instance,
        })
      ).status,
    ).toBe(403);
    const range = await csvOf(mgr, '/api/exports/batch-weights.csv', {
      plantId: plantA,
      from: '2020-01-01',
      to: '2099-12-31',
    });
    expect(range.status).toBe(200);
    expect(new Set(col(parse(range.text), 'kind'))).toEqual(new Set(['production']));
    expect(
      (
        await csvOf(mgr, '/api/exports/batch-weights.csv', {
          plantId: plantA,
          from: '2020-01-01',
          to: '2020-01-02',
        })
      ).status,
    ).toBe(409);
    // the design leaves production: its batch weights are no longer exportable
    const sus = await mgr.post(`/api/designs/${live}/suspend`).send(SIGN);
    expect(sus.status, JSON.stringify(sus.body)).toBe(200);
    expect(
      (await csvOf(mgr, '/api/exports/batch-weights.csv', { instanceId: instance })).status,
    ).toBe(409);
    expect(
      (await mgr.post(`/api/designs/${live}/reinstate`).send({ ...SIGN, to: 'approved' })).status,
    ).toBe(200);
  });

  it('every export is audited and nothing is changed by exporting', async () => {
    const before = await designRow(live);
    await csvOf(await as('qc_manager'), '/api/exports/batch-weights.csv', { instanceId: instance });
    const after = await designRow(live);
    expect(after.updatedAt).toEqual(before.updatedAt);
    const a = await env.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'export.batch_weights'));
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(a[0]!.after).toMatchObject({ schema: 'khalta.batch-weights.v1' });
  });
});
