import { schema } from '@khalta/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { supersede } from '../src/rules/service';
import { closePdfBrowser } from '../src/submittal/render';
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
  [plantA, plantB] = (await optimizerWorld(env, ['LAB-A', 'LAB-B'])).plants as [string, string];
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
}, 120_000);
afterAll(async () => {
  await closePdfBrowser();
  await env.close();
});

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

const BATCH = {
  'eng.batch.max_size_m3': 6,
  'eng.batch.max_rounding_deviation_pct': 1,
  'eng.batch.resolution_kg.cement': 1,
  'eng.batch.resolution_kg.scm': 1,
  'eng.batch.resolution_kg.fine_agg': 5,
  'eng.batch.resolution_kg.coarse_agg': 5,
  'eng.batch.resolution_kg.admixture': 0.1,
  'eng.batch.resolution_kg.water': 1,
  'eng.batch.resolution_kg.fiber': 0.1,
  'eng.batch.resolution_kg.pigment': 0.1,
};
async function setBatch(on: boolean, only?: string[]) {
  const qm = (await env.seedUser('qc_manager')).id;
  await env.db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(BATCH)) {
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
      if (!r) continue;
      const want = on ? value : null;
      if (r.row.value !== want)
        await supersede(
          tx,
          env.tenantId,
          qm,
          r.row,
          { value: want },
          'ui',
          'SYNTHETIC batch parameter',
        );
    }
  });
}

// A stored plan is immutable; to simulate the world changing under it the test lifts the trigger for one statement.
async function tamper(statement: ReturnType<typeof sql>) {
  await env.db.execute(
    sql`ALTER TABLE batch_instances DISABLE TRIGGER batch_instances_append_only`,
  );
  try {
    await env.db.execute(statement);
  } finally {
    await env.db.execute(
      sql`ALTER TABLE batch_instances ENABLE TRIGGER batch_instances_append_only`,
    );
  }
}

async function approvedDesign(code: string) {
  await setLimits(true);
  await verifyRules();
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

describe('batch preparation and the v2 production export', () => {
  it('names every missing equipment parameter, then prepares a reconciled, independently checked plan', async () => {
    await setBatch(false);
    const id = await approvedDesign('BP-1');
    const lab = await as('qc_engineer', [plantA]);
    const body = { moisture: await moisture(id, [3]), batchSizeM3: 2 };
    const blocked = await lab.post(`/api/designs/${id}/batch-plans/preview`).send(body);
    expect(blocked.status).toBe(200);
    expect(blocked.body.plan.ok).toBe(false);
    const subjects = blocked.body.plan.blockers.map((b: { subject: string }) => b.subject);
    expect(subjects).toContain('eng.batch.max_size_m3');
    expect(subjects).toContain('eng.batch.resolution_kg.cement');
    expect((await lab.post(`/api/designs/${id}/batch-plans`).send(body)).status).toBe(409);

    await setBatch(true);
    const ok = await lab.post(`/api/designs/${id}/batch-plans/preview`).send(body);
    expect(ok.body.plan.ok, JSON.stringify(ok.body.plan)).toBe(true);
    expect(ok.body.planValidator.status).toBe('pass');
    const rec = ok.body.plan.reconciliation;
    expect(Math.abs(rec.roundedTotalKg - rec.exactTotalKg) / rec.exactTotalKg).toBeLessThan(0.01);
    expect(ok.body.binding.designVersionHash).toMatch(/^[0-9a-f]{64}$/);
    // too large a batch is blocked by the configured maximum, not guessed around
    const big = await lab
      .post(`/api/designs/${id}/batch-plans/preview`)
      .send({ ...body, batchSizeM3: 50 });
    expect(big.body.plan.ok).toBe(false);
    const saved = await lab.post(`/api/designs/${id}/batch-plans`).send(body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body.kind).toBe('production');
    expect(
      await env.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'batch_plan.create')),
    ).not.toHaveLength(0);
  });

  it('tenant and plant isolation: another plant cannot preview or save', async () => {
    await setBatch(true);
    const id = await approvedDesign('BP-2');
    const other = await as('qc_engineer', [plantB]);
    const body = { moisture: await moisture(id, [3]), batchSizeM3: 2 };
    expect((await other.post(`/api/designs/${id}/batch-plans/preview`).send(body)).status).toBe(
      404,
    );
    expect((await other.post(`/api/designs/${id}/batch-plans`).send(body)).status).toBe(404);
  });

  it('exports v2 only while the plan is still safe; every refusal is named', async () => {
    await setBatch(true);
    const id = await approvedDesign('BP-3');
    const lab = await as('qc_engineer', [plantA]);
    const body = { moisture: await moisture(id, [3]), batchSizeM3: 2 };
    const saved = await lab.post(`/api/designs/${id}/batch-plans`).send(body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const exp = async () =>
      (await as('qc_engineer', [plantA])).post('/api/exports/batch-plans.csv').send({
        instanceId: saved.body.id,
      });
    const good = await exp();
    expect(good.status, good.text).toBe(200);
    expect(good.headers['x-khalta-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(good.text).toContain('khalta.batch-weights.v2');
    expect(good.text).not.toMatch(/cost|price|JOD/i);
    expect(
      await env.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'export.batch_plans')),
    ).not.toHaveLength(0);

    const codes = async () =>
      ((await exp()).body.error?.details?.problems ?? []).map((p: { code: string }) => p.code);

    // an equipment parameter removed after preparation
    await setBatch(false, ['eng.batch.max_size_m3']);
    expect(await codes()).toContain('parameter_missing');
    await setBatch(true);
    expect((await exp()).status).toBe(200);

    // a moisture reading that has aged past the stale limit
    await tamper(
      sql`UPDATE batch_instances SET moisture = (SELECT jsonb_agg(jsonb_set(m, '{measuredAt}', to_jsonb((now() - interval '72 hours')::text))) FROM jsonb_array_elements(moisture) m) WHERE id = ${saved.body.id}`,
    );
    expect(await codes()).toContain('moisture_stale_at_export');

    // the design version changed under the plan
    await tamper(
      sql`UPDATE batch_instances SET design_version_hash = repeat('0', 64) WHERE id = ${saved.body.id}`,
    );
    expect(await codes()).toContain('design_version_mismatch');
  });

  it('a material test change after preparation refuses the export', async () => {
    await setBatch(true);
    const id = await approvedDesign('BP-4');
    const lab = await as('qc_engineer', [plantA]);
    const saved = await lab
      .post(`/api/designs/${id}/batch-plans`)
      .send({ moisture: await moisture(id, [3]), batchSizeM3: 2 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    await tamper(
      sql`UPDATE batch_instances SET material_test_versions = '{}'::jsonb WHERE id = ${saved.body.id}`,
    );
    const r = await lab.post('/api/exports/batch-plans.csv').send({ instanceId: saved.body.id });
    expect(r.status).toBe(409);
    expect(r.body.error.details.problems.map((p: { code: string }) => p.code)).toContain(
      'material_changed',
    );
  });
});
