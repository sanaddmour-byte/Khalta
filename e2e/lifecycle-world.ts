// SYNTHETIC lifecycle fixtures for the e2e database only. Trial batches have no entry screen until M4.2, so the
// spec writes one straight into the e2e database (a labelled fixture), and marks the rules with values verified
// (what a QC manager's sign-off on the licensed documents would do).
import { expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import pg from 'pg';
import { E2E_DATABASE_URL } from './env';
import { seedStudioWorld } from './studio-world';
import { emailFor, PASSWORD } from './support';

const BASE = 'http://localhost:5173';
export const SECOND_MANAGER = 'qc.manager2@khalta.test';
const CRITERIA: Record<string, number> = {
  'eng.trial.slump_tolerance_mm': 25,
  'eng.trial.air_tolerance_pct': 1.5,
  'eng.trial.density_band_kg_m3': 40,
  'eng.trial.yield_band_m3': 0.01,
  'eng.trial.temperature_max_c': 32,
};

export async function as(email: string): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const res = await ctx.post('/api/auth/sign-in/email', { data: { email, password: PASSWORD } });
  expect(res.ok(), `sign in as ${email}`).toBe(true);
  return ctx;
}

let ready: Promise<string> | null = null;
/** SYNTHETIC trial criteria in the rules, and a second QC manager so four-eyes can be exercised. Returns plant A's id. */
export function seedLifecycleWorld() {
  return (ready ??= (async () => {
    const { plantA } = await seedStudioWorld();
    const admin = await as(emailFor('admin'));
    // engineering values are written by the QC manager, never by the admin
    const qcm = await as(emailFor('qc_manager'));
    const rules = (await (await qcm.get('/api/rules?ruleset=ENGINEERING')).json()).rules as {
      id: string;
      key: string;
      value: unknown;
    }[];
    for (const [key, value] of Object.entries(CRITERIA)) {
      const r = rules.find((x) => x.key === key);
      expect(r, key).toBeDefined();
      if (r!.value !== value) {
        const res = await qcm.patch(`/api/rules/${r!.id}/value`, {
          data: { value, reason: 'SYNTHETIC trial criterion' },
        });
        expect(res.ok(), await res.text()).toBe(true);
      }
    }
    const made = await admin.post('/api/users', {
      data: {
        email: SECOND_MANAGER,
        name: 'QC Manager Two',
        role: 'qc_manager',
        password: PASSWORD,
      },
    });
    expect([201, 409]).toContain(made.status());
    return plantA;
  })());
}

/** A trial-candidate design authored by the first QC manager (the optimizer path, then Request trial). */
export async function trialCandidate(code: string): Promise<string> {
  const plantId = await seedLifecycleWorld();
  const mgr = await as(emailFor('qc_manager'));
  const run = await mgr.post('/api/design-requests', {
    data: {
      plantId,
      mode: 'ACI',
      requirements: {
        fcMpa: 30,
        basis: 'cylinder',
        testAgeDays: 28,
        exposure: ['F0', 'S0', 'W0', 'C1'],
        slumpMm: 100,
        nmasMm: 19,
        pumpable: false,
        s3Option: null,
        airPct: null,
      },
    },
  });
  expect(run.ok(), await run.text()).toBe(true);
  const body = (await run.json()) as { id: string; candidates: { id: string }[] };
  const res = await mgr.post(
    `/api/design-requests/${body.id}/candidates/${body.candidates[0]!.id}/trial-candidate`,
    { data: { code, name: `Lifecycle ${code}` } },
  );
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { design: { id: string } }).design.id;
}

export async function withDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: E2E_DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** SYNTHETIC: one passing trial batch and its cylinders, built from the design's own stored evaluation and entered through the real endpoints. */
export async function addPassingBatch(designId: string) {
  const rep = await withDb(async (c) => {
    const { rows } = await c.query(
      `SELECT e.report FROM mix_designs d JOIN design_evaluations e ON e.id = d.last_evaluation_id WHERE d.id = $1`,
      [designId],
    );
    return rows[0].report as {
      trace: { key: string; value: number }[];
      strengthAdequacy: { fcrMpa: number };
    };
  });
  const density = rep.trace.find((t) => t.key === 'mass.fresh_density')!.value;
  const fcr = rep.strengthAdequacy.fcrMpa;
  const mgr = await as(emailFor('qc_manager'));
  const made = await mgr.post(`/api/designs/${designId}/trial-batches`, {
    data: {
      batchedOn: '2026-10-01',
      slumpMm: 105,
      airPct: 2,
      temperatureC: 28,
      freshDensityKgM3: density,
      yieldM3: 1.002,
      notes: 'SYNTHETIC trial batch',
    },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const id = ((await made.json()) as { id: string }).id;
  const res = await mgr.post(`/api/trial-batches/${id}/strength-results`, {
    data: {
      castDate: '2026-10-01',
      ageDays: 28,
      specimenType: 'cylinder',
      setId: 'SYN-1',
      resultsMpa: [fcr + 3, fcr + 4],
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
}

/** SYNTHETIC moisture limits and aggregate absorption (the engine's synthetic aggregates carry none). */
let moistureReady: Promise<void> | null = null;
export function seedMoistureWorld() {
  return (moistureReady ??= (async () => {
    await seedLifecycleWorld();
    const admin = await as(emailFor('qc_manager')); // engineering values: the QC manager's, not the admin's
    const rules = (await (await admin.get('/api/rules?ruleset=ENGINEERING')).json()).rules as {
      id: string;
      key: string;
      value: unknown;
    }[];
    for (const [key, value] of [
      ['eng.moisture.max_total_pct', 15],
      ['eng.moisture.stale_hours', 24],
    ] as const) {
      const r = rules.find((x) => x.key === key)!;
      if (r.value !== value) {
        const res = await admin.patch(`/api/rules/${r.id}/value`, {
          data: { value, reason: 'SYNTHETIC moisture limit' },
        });
        expect(res.ok(), await res.text()).toBe(true);
      }
    }
    await withDb(async (c) => {
      const { rows } = await c.query(
        `SELECT m.id, t.id AS tid, t.version, t.properties, t.tenant_id FROM materials m
         JOIN material_tests t ON t.material_id = m.id AND t.is_current
         WHERE m.category LIKE '%!_agg' ESCAPE '!' AND NOT (t.properties ? 'absorption_pct')`,
      );
      for (const r of rows) {
        await c.query(`UPDATE material_tests SET is_current = false WHERE id = $1`, [r.tid]);
        await c.query(
          `INSERT INTO material_tests (tenant_id, material_id, version, is_current, source, properties, tested_at)
           VALUES ($1, $2, $3, true, 'supplier_datasheet', $4::jsonb, '2026-08-01')`,
          [
            r.tenant_id,
            r.id,
            r.version + 1,
            JSON.stringify({ ...r.properties, absorption_pct: 1.2 }),
          ],
        );
      }
    });
  })());
}

let flipped: string[] = [];
/** SYNTHETIC: mark every current unverified rule that has a value as verified (undone by `restoreRules`). */
export async function verifyRules() {
  await withDb(async (c) => {
    const { rows } = await c.query(
      `UPDATE rules SET verified = true, verified_at = now()
       WHERE is_current AND NOT verified AND (value IS NOT NULL OR definition IS NOT NULL OR inherits IS NOT NULL)
       RETURNING id`,
    );
    flipped = [...flipped, ...rows.map((r) => r.id as string)];
  });
}

/** Other specs (the Rules screen) expect unverified rules: put back exactly what `verifyRules` flipped. */
export async function restoreRules() {
  if (flipped.length === 0) return;
  await withDb((c) =>
    c.query(`UPDATE rules SET verified = false, verified_at = NULL WHERE id = ANY($1::uuid[])`, [
      flipped,
    ]),
  );
  flipped = [];
}

/** SYNTHETIC: walk a trial-candidate through the real endpoints to `trial_passed` (batch fixture, start, pass). */
export async function advanceToTrialPassed(designId: string) {
  await addPassingBatch(designId);
  const mgr = await as(emailFor('qc_manager'));
  const a = await mgr.post(`/api/designs/${designId}/start-trial`);
  expect(a.ok(), await a.text()).toBe(true);
  const b = await mgr.post(`/api/designs/${designId}/pass-trial`, {
    data: { reason: 'SYNTHETIC trial reviewed' },
  });
  expect(b.ok(), await b.text()).toBe(true);
}

/** SYNTHETIC: a design walked all the way to `approved` (second QC manager signs) and released to `in_production`. */
export async function liveDesign(code: string): Promise<string> {
  const id = await trialCandidate(code);
  await advanceToTrialPassed(id);
  await verifyRules();
  const second = await as(SECOND_MANAGER);
  const a = await second.post(`/api/designs/${id}/approve`, {
    data: { reason: 'SYNTHETIC approval for the pilot fixtures' },
  });
  expect(a.ok(), await a.text()).toBe(true);
  const r = await second.post(`/api/designs/${id}/release`, {
    data: { reason: 'SYNTHETIC release' },
  });
  expect(r.ok(), await r.text()).toBe(true);
  return id;
}

/** SYNTHETIC: an insight row straight into the e2e database (the jobs that create them are covered by the API tests). */
export async function seedInsight(
  plantId: string,
  row: {
    type: string;
    severity: string;
    designId?: string;
    payload: unknown;
    savingJodPerM3?: string;
    annualJod?: string;
    key: string;
  },
) {
  await withDb(async (c) => {
    const { rows } = await c.query(`SELECT tenant_id FROM plants WHERE id = $1`, [plantId]);
    await c.query(
      `INSERT INTO insights (tenant_id, type, severity, plant_id, design_id, dedupe_key, payload, saving_jod_per_m3, annual_jod)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
       ON CONFLICT DO NOTHING`,
      [
        rows[0].tenant_id,
        row.type,
        row.severity,
        plantId,
        row.designId ?? null,
        row.key,
        JSON.stringify(row.payload),
        row.savingJodPerM3 ?? null,
        row.annualJod ?? null,
      ],
    );
  });
}
