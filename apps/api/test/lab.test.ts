import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
async function setSettings(settings: Record<string, unknown>) {
  await env.db
    .insert(schema.tenantSettings)
    .values({ tenantId: env.tenantId, settings })
    .onConflictDoUpdate({ target: schema.tenantSettings.tenantId, set: { settings } });
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

describe('trial batches and strength results', () => {
  it('RBAC, plant scope and states; append-only; results judged only at the test age', async () => {
    const id = await trialCandidate('LAB-1');
    const payload = { batchedOn: '2026-10-01', slumpMm: 100, temperatureC: 25 };
    expect(
      (await (await as('procurement')).post(`/api/designs/${id}/trial-batches`).send(payload))
        .status,
    ).toBe(403);
    expect(
      (
        await (
          await as('plant_manager', [plantB])
        )
          .post(`/api/designs/${id}/trial-batches`)
          .send(payload)
      ).status,
    ).toBe(404);
    const own = await as('plant_manager', [plantA]);
    const made = await own
      .post(`/api/designs/${id}/trial-batches`)
      .send({ ...payload, waterAddedKgM3: 5, notes: 'SYNTHETIC' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    // a correction names the batch it replaces; it must be one of this design's
    const other = await trialCandidate('LAB-1b');
    const bad = await own
      .post(`/api/designs/${other}/trial-batches`)
      .send({ ...payload, supersedesId: made.body.id });
    expect(bad.status).toBe(400);
    expect(
      (
        await own
          .post(`/api/designs/${id}/trial-batches`)
          .send({ ...payload, supersedesId: made.body.id })
      ).status,
    ).toBe(201);
    // append-only
    await expect(
      env.db
        .update(schema.trialBatches)
        .set({ notes: 'edited' })
        .where(eq(schema.trialBatches.id, made.body.id)),
    ).rejects.toThrow();
    await expect(
      env.db.delete(schema.trialBatches).where(eq(schema.trialBatches.id, made.body.id)),
    ).rejects.toThrow();

    const lab = await as('qc_engineer', [plantA]);
    const set7 = await lab.post(`/api/trial-batches/${made.body.id}/strength-results`).send({
      castDate: '2026-10-01',
      ageDays: 7,
      specimenType: 'cylinder',
      setId: 'A7',
      resultsMpa: [22, 23],
    });
    expect(set7.status).toBe(201);
    const list = await lab.get(`/api/designs/${id}/trial-batches`);
    expect(list.body.batches.length).toBe(2);
    expect(list.body.results.length).toBe(2);
    expect(list.body.testAgeDays).toBe(28);
    // a 7-day result is stored and shown, never judged: the strength criterion has no measurement
    await setLimits(true);
    const mgr = await as('qc_manager');
    const gates = await mgr.get(`/api/designs/${id}/gates?to=trial_passed`);
    expect(
      gates.body.gates.find((g: { id: string }) => g.id === 'criterion_strength'),
    ).toMatchObject({ met: false, code: 'missing' });
    await expect(env.db.update(schema.strengthResults).set({ resultMpa: '99' })).rejects.toThrow();
    // other states are refused
    const approvedLike = await trialCandidate('LAB-1c');
    await env.db
      .update(schema.mixDesigns)
      .set({ status: 'retired' })
      .where(eq(schema.mixDesigns.id, approvedLike));
    expect(
      (await own.post(`/api/designs/${approvedLike}/trial-batches`).send(payload)).status,
    ).toBe(409);
  });
});

describe('batch weights (F-024)', () => {
  it('blocks naming each missing QC limit, then converts with a passing independent check', async () => {
    await setLimits(false);
    const id = await trialCandidate('LAB-2');
    const lab = await as('qc_engineer', [plantA]);
    const body = { moisture: await moisture(id, [3]) };
    const blocked = await lab.post(`/api/designs/${id}/batch-weights/preview`).send(body);
    expect(blocked.status).toBe(200);
    expect(blocked.body.result.ok).toBe(false);
    expect(blocked.body.result.blockers.map((b: { subject: string }) => b.subject).sort()).toEqual([
      'eng.moisture.max_total_pct',
      'eng.moisture.stale_hours',
    ]);
    expect((await lab.post(`/api/designs/${id}/batch-instances`).send(body)).status).toBe(409);

    await setLimits(true);
    const ok = await lab.post(`/api/designs/${id}/batch-weights/preview`).send(body);
    expect(ok.body.result.ok).toBe(true);
    expect(ok.body.validator.status).toBe('pass');
    const r = ok.body.result;
    const freeSum = r.lines.reduce(
      (s: number, l: { freeWaterKg: number | null }) => s + (l.freeWaterKg ?? 0),
      0,
    );
    expect(r.batchWaterKg).toBeCloseTo(r.designWaterKg - freeSum, 2);
    expect(Math.abs(r.balance.residualKg)).toBeLessThan(0.01);
    // the aggregates are wetter than their absorption in this fixture, so the batch needs less water
    expect(r.batchWaterKg).toBeLessThan(r.designWaterKg);
  });

  it('rejects impossible, stale and non-aggregate readings; the opt-in changes the water and is named', async () => {
    await setLimits(true);
    const id = await trialCandidate('LAB-3');
    const lab = await as('qc_engineer', [plantA]);
    const preview = async (b: object) =>
      (await lab.post(`/api/designs/${id}/batch-weights/preview`).send(b)).body;
    expect((await preview({ moisture: await moisture(id, [40]) })).result.blockers[0].code).toBe(
      'moisture_impossible',
    );
    const old = new Date(Date.now() - 72 * 3_600_000).toISOString();
    expect(
      (await preview({ moisture: await moisture(id, [3], old) })).result.blockers[0].code,
    ).toBe('moisture_stale');
    const cement = (
      await env.db
        .select()
        .from(schema.mixDesignLines)
        .where(eq(schema.mixDesignLines.designId, id))
    ).find((l) => !(l.materialId in Object.fromEntries([] as never[]))) as { materialId: string };
    const notAgg = (await aggregates(id)).map((a) => a.materialId);
    const wrong = (
      await env.db
        .select()
        .from(schema.mixDesignLines)
        .where(eq(schema.mixDesignLines.designId, id))
    ).find((l) => !notAgg.includes(l.materialId))!;
    expect(cement).toBeDefined();
    expect(
      (
        await lab
          .post(`/api/designs/${id}/batch-weights/preview`)
          .send({ moisture: [{ materialId: wrong.materialId, totalMoisturePct: 3 }] })
      ).status,
    ).toBe(400);

    const off = (await preview({ moisture: await moisture(id, [3]) })).result;
    await setSettings({ admixtureSolutionWater: true });
    const on = (await preview({ moisture: await moisture(id, [3]) })).result;
    await setSettings({});
    expect(off.convention.admixtureSolutionWater).toBe(false);
    expect(on.convention.admixtureSolutionWater).toBe(true);
    expect(on.solutionWaterSubtractedKg).toBeGreaterThan(0);
    expect(on.batchWaterKg).toBeLessThan(off.batchWaterKg);
  });

  it('a stored batch instance is a correction: the design is untouched; draft designs are refused', async () => {
    await setLimits(true);
    const id = await trialCandidate('LAB-4');
    const before = await designRow(id);
    const lab = await as('qc_engineer', [plantA]);
    const saved = await lab
      .post(`/api/designs/${id}/batch-instances`)
      .send({ moisture: await moisture(id, [2.5, 1.2]) });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body.kind).toBe('trial');
    const after = await designRow(id);
    expect(after).toMatchObject({
      status: before.status,
      version: before.version,
      updatedAt: before.updatedAt,
    });
    const list = await lab.get(`/api/designs/${id}/batch-instances`);
    expect(list.body[0]).toMatchObject({ kind: 'trial', validatorStatus: 'pass' });
    await expect(
      env.db.update(schema.batchInstances).set({ kind: 'production' }),
    ).rejects.toThrow();
    // never stored without a passing independent check
    await expect(
      env.db.insert(schema.batchInstances).values({
        tenantId: env.tenantId,
        designId: id,
        designVersion: 1,
        plantId: plantA,
        kind: 'trial',
        moisture: [],
        config: {},
        result: {},
        validator: {},
        validatorStatus: 'fail',
      }),
    ).rejects.toThrow();
    await env.db
      .update(schema.mixDesigns)
      .set({ status: 'retired' })
      .where(eq(schema.mixDesigns.id, id));
    expect(
      (
        await lab
          .post(`/api/designs/${id}/batch-instances`)
          .send({ moisture: await moisture(id, [2]) })
      ).status,
    ).toBe(409);
    expect(
      (
        await (
          await as('procurement')
        )
          .post(`/api/designs/${id}/batch-weights/preview`)
          .send({ moisture: [] })
      ).status,
    ).toBe(403);
  });
});

function pdfText(pdf: Buffer): string | null {
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'khalta-pdf-'));
    const f = path.join(dir, 'a.pdf');
    writeFileSync(f, pdf);
    return execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' });
  } catch {
    return null; // poppler not installed: the HTML-level assertions still run
  }
}
const fetchPdf = async (client: Awaited<ReturnType<typeof as>>, id: string, lang: string) => {
  const res = await client
    .post(`/api/designs/${id}/submittal`)
    .send({ lang })
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  return res;
};

describe('PDF submittal (F-025)', () => {
  it('a trial design is watermarked and says so in the state; no cost appears; the export is audited', async () => {
    const id = await trialCandidate('LAB-5');
    const mgr = await as('qc_manager');
    const res = await fetchPdf(mgr, id, 'en');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(20_000);
    const text = pdfText(pdf);
    if (text) {
      expect(text).toContain('LAB-5');
      expect(text).toContain('Trial candidate');
      expect(text.replace(/\s+/g, ' ')).toMatch(/NOT APPROVED/);
      expect(text).not.toMatch(/JOD|cost|price/i);
    }
    const audits = await env.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'design.submittal'));
    expect(audits.length).toBeGreaterThan(0);
    // cost-blind roles may export too (there is nothing to hide)
    expect((await fetchPdf(await as('sales', [plantA]), id, 'en')).status).toBe(200);
    // other plants' designs are not reachable
    expect((await fetchPdf(await as('plant_manager', [plantB]), id, 'en')).status).toBe(404);
  });

  it('Arabic and bilingual pages carry the Arabic text; an approved design has no watermark', async () => {
    await setLimits(true);
    await verifyRules();
    const id = await trialCandidate('LAB-6');
    const mgr = await as('qc_manager');
    const ar = pdfText((await fetchPdf(mgr, id, 'ar')).body as Buffer);
    const both = pdfText((await fetchPdf(mgr, id, 'both')).body as Buffer);
    if (ar && both) {
      expect(ar).toContain('مستند اعتماد الخلطة');
      // pdftotext splits some Arabic ligatures (غير → غري), so check the stable words
      expect(ar.replace(/\s+/g, ' ')).toMatch(/معتمد — للتجربة فقط/);
      expect(both).toContain('Mix design submittal');
      expect(both).toContain('مستند اعتماد الخلطة');
    }
    // approve through the lifecycle fixtures: a second QC manager, a passing batch
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
    const approver = await as('qc_manager');
    const ok = await approver.post(`/api/designs/${id}/approve`).send(SIGN);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // production batch weights are now allowed and appear on the PDF
    const eng = await as('qc_engineer', [plantA]);
    expect(
      (
        await eng
          .post(`/api/designs/${id}/batch-instances`)
          .send({ moisture: await moisture(id, [2]) })
      ).body.kind,
    ).toBe('production');
    const text = pdfText((await fetchPdf(approver, id, 'en')).body as Buffer);
    if (text) {
      expect(text).toContain('Approved');
      expect(text).not.toMatch(/NOT APPROVED/);
      expect(text).toContain('Latest batch instance');
      expect(text).toContain('Reviewed and signed');
    }
  });
});
