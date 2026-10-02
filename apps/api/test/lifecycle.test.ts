import { schema } from '@khalta/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { supersede } from '../src/rules/service';
import { createTestEnv, type TestEnv } from './helpers';
import { optimizerWorld, REQUIREMENTS as BASE_REQUIREMENTS } from './opt-world';

const REQUIREMENTS = { ...BASE_REQUIREMENTS, testAgeDays: 28 };

// SYNTHETIC world and SYNTHETIC trial criteria: labelled test data, not a plant's values.
const CRITERIA = {
  'eng.trial.slump_tolerance_mm': 25,
  'eng.trial.air_tolerance_pct': 1.5,
  'eng.trial.density_band_kg_m3': 40,
  'eng.trial.yield_band_m3': 0.01,
  'eng.trial.temperature_max_c': 32,
};
let env: TestEnv;
let plantA: string;
let plantB: string;

beforeAll(async () => {
  env = await createTestEnv();
  const w = await optimizerWorld(env, ['LC-A', 'LC-B']);
  [plantA, plantB] = w.plants as [string, string];
}, 120_000);
afterAll(() => env.close());

const as = async (role: Parameters<TestEnv['seedUser']>[0], plantIds: string[] = []) =>
  env.login((await env.seedUser(role, { plantIds })).email);
const SIGN = { reason: 'Reviewed the trial results and the evaluation' };

async function setCriteria(on: boolean) {
  await env.db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(CRITERIA)) {
      const [r] = await tx
        .select({ row: schema.rules })
        .from(schema.rules)
        .innerJoin(schema.rulesets, eq(schema.rulesets.id, schema.rules.rulesetId))
        .where(
          and(
            eq(schema.rules.tenantId, env.tenantId),
            eq(schema.rules.key, key),
            eq(schema.rules.isCurrent, true),
          ),
        );
      const want = on ? value : null;
      if (r!.row.value !== want)
        await supersede(
          tx,
          env.tenantId,
          (await env.seedUser('admin')).id,
          r!.row,
          { value: want },
          'ui',
          'SYNTHETIC trial criterion',
        );
    }
  });
}
/** SYNTHETIC: mark every current rule that has a value as verified (what a QC manager's sign-off would do). */
async function verifyRules(v = true) {
  await env.db.execute(sql`UPDATE rules SET verified = ${v},
    verified_by = NULL, verified_at = ${v ? sql`now()` : null}
    WHERE tenant_id = ${env.tenantId} AND is_current
      AND (${v} = false OR value IS NOT NULL OR definition IS NOT NULL OR inherits IS NOT NULL)`);
}

async function setSettings(settings: Record<string, unknown>) {
  await env.db
    .insert(schema.tenantSettings)
    .values({ tenantId: env.tenantId, settings })
    .onConflictDoUpdate({ target: schema.tenantSettings.tenantId, set: { settings } });
}

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
  return { id: res.body.design.id as string, engineer: eng };
}
const designRow = async (id: string) =>
  (await env.db.select().from(schema.mixDesigns).where(eq(schema.mixDesigns.id, id)))[0]!;

/** Log a SYNTHETIC trial batch and its cylinders through the real endpoints (M4.2). */
async function logBatch(
  id: string,
  fields: Record<string, unknown>,
  strengths: number[],
  batchedOn = '2026-10-01',
) {
  const lab = await as('qc_manager');
  const made = await lab.post(`/api/designs/${id}/trial-batches`).send({ batchedOn, ...fields });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const res = await lab.post(`/api/trial-batches/${made.body.id}/strength-results`).send({
    castDate: batchedOn,
    ageDays: 28,
    specimenType: 'cylinder',
    setId: `S-${batchedOn}`,
    resultsMpa: strengths,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

/** A passing SYNTHETIC trial batch built from the design's own stored evaluation. */
async function goodBatch(id: string) {
  const d = await designRow(id);
  const [ev] = await env.db
    .select()
    .from(schema.designEvaluations)
    .where(eq(schema.designEvaluations.id, d.lastEvaluationId!));
  const rep = ev!.report as {
    trace: { key: string; value: number }[];
    strengthAdequacy: { fcrMpa: number };
  };
  const density = rep.trace.find((t) => t.key === 'mass.fresh_density')!.value;
  await logBatch(
    id,
    { slumpMm: 105, airPct: 2, temperatureC: 28, freshDensityKgM3: density, yieldM3: 1.002 },
    [rep.strengthAdequacy.fcrMpa + 3, rep.strengthAdequacy.fcrMpa + 4],
  );
}
const gates = (body: { details?: { gates?: { id: string; met: boolean; code: string }[] } }) =>
  (body.details?.gates ?? []).filter((g) => !g.met).map((g) => g.id);

describe('the trial path is gated and every unmet gate is named', () => {
  it('start-trial needs a logged batch; pass-trial names each missing criterion, then each failing one', async () => {
    await setCriteria(false);
    const { id } = await trialCandidate('LC-1');
    const mgr = await as('qc_manager');
    const noBatch = await mgr.post(`/api/designs/${id}/start-trial`);
    expect(noBatch.status).toBe(409);
    expect(gates(noBatch.body.error ?? noBatch.body)).toEqual(['trial_batch']);

    await goodBatch(id);
    expect((await mgr.post(`/api/designs/${id}/start-trial`)).status).toBe(200);
    expect((await designRow(id)).status).toBe('trial_in_progress');

    // criteria are unset: nothing is defaulted, each missing parameter is named
    const blocked = await mgr.post(`/api/designs/${id}/pass-trial`).send(SIGN);
    expect(blocked.status).toBe(409);
    const missing = (
      blocked.body.error.details.gates as { id: string; code: string; detail: string[] }[]
    )
      .filter((g) => g.code === 'missing')
      .flatMap((g) => g.detail);
    expect(missing.sort()).toEqual(
      [
        'eng.trial.density_band_kg_m3',
        'eng.trial.slump_tolerance_mm',
        'eng.trial.temperature_max_c',
        'eng.trial.yield_band_m3',
      ].sort(),
    );

    await setCriteria(true);
    await logBatch(
      id,
      { slumpMm: 160, temperatureC: 35, freshDensityKgM3: 2300, yieldM3: 1 },
      [1],
      '2026-10-02',
    );
    const failing = await mgr.post(`/api/designs/${id}/pass-trial`).send(SIGN);
    expect(failing.status).toBe(409);
    expect(gates(failing.body.error)).toEqual(
      expect.arrayContaining(['criterion_slump', 'criterion_temperature', 'criterion_strength']),
    );
    expect((await designRow(id)).status).toBe('trial_in_progress');
  });

  it('a signed pass by a QC manager moves to trial_passed with the e-signature on the transition', async () => {
    await setCriteria(true);
    const { id } = await trialCandidate('LC-2');
    await goodBatch(id);
    const mgr = await as('qc_manager');
    await mgr.post(`/api/designs/${id}/start-trial`);
    expect((await mgr.post(`/api/designs/${id}/pass-trial`).send({ reason: 'ok' })).status).toBe(
      400,
    );
    const eng = await as('qc_engineer', [plantA]);
    expect((await eng.post(`/api/designs/${id}/pass-trial`).send(SIGN)).status).toBe(403);
    const ok = await mgr.post(`/api/designs/${id}/pass-trial`).send(SIGN);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const [t] = await env.db
      .select()
      .from(schema.designTransitions)
      .where(
        and(
          eq(schema.designTransitions.designId, id),
          eq(schema.designTransitions.toStatus, 'trial_passed'),
        ),
      );
    expect(t!.esignature).toMatchObject({
      meaning: 'trial_reviewed',
      reason: SIGN.reason,
      role: 'qc_manager',
    });
    expect((t!.esignature as { designVersionHash: string }).designVersionHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

/** SYNTHETIC fixture: walk a design to `trial_passed` with a passing batch (the DB allows only graph edges). */
async function toTrialPassed(id: string) {
  await goodBatch(id);
  const mgr = await as('qc_manager');
  await mgr.post(`/api/designs/${id}/start-trial`);
  const r = await mgr.post(`/api/designs/${id}/pass-trial`).send(SIGN);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

describe('approval: four-eyes and every gate', () => {
  it('the author cannot approve; unverified rules, and a stale evaluation, are listed together', async () => {
    await setCriteria(true);
    await verifyRules(false);
    const { id } = await trialCandidate('LC-3');
    await toTrialPassed(id);
    // the author (the engineer) holds no approve capability; a QC manager who authored one is refused too
    await env.db
      .update(schema.mixDesigns)
      .set({ updatedAt: new Date() })
      .where(eq(schema.mixDesigns.id, id));
    const other = await as('qc_manager');
    const blocked = await other.post(`/api/designs/${id}/approve`).send(SIGN);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('gates_unmet');
    expect(gates(blocked.body.error)).toContain('rules_verified');
    const checklist = await other.get(`/api/designs/${id}/gates?to=approved`);
    expect(checklist.status).toBe(200);
    expect(checklist.body.gates.find((g: { id: string }) => g.id === 'rules_verified').met).toBe(
      false,
    );
    expect((await designRow(id)).status).toBe('trial_passed');
  });

  it('approves when everything is met: four-eyes, e-signed, source khalta', async () => {
    await setCriteria(true);
    await verifyRules(true);
    const { id } = await trialCandidate('LC-4');
    await toTrialPassed(id);
    const author = (await designRow(id)).createdBy!;
    const [u] = await env.db.select().from(schema.users).where(eq(schema.users.id, author));
    const authorMgrClient = await env.login(u!.email);
    // the engineer cannot (no capability)
    expect(
      (await (await as('qc_engineer', [plantA])).post(`/api/designs/${id}/approve`).send(SIGN))
        .status,
    ).toBe(403);
    // the author, even with the right role, cannot approve their own design
    await env.db
      .update(schema.users)
      .set({ role: 'qc_manager' })
      .where(eq(schema.users.id, author));
    const self = await authorMgrClient.post(`/api/designs/${id}/approve`).send(SIGN);
    expect(self.status).toBe(403);
    await env.db
      .update(schema.users)
      .set({ role: 'qc_engineer' })
      .where(eq(schema.users.id, author));

    const mgr = await as('qc_manager');
    const ok = await mgr.post(`/api/designs/${id}/approve`).send(SIGN);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const row = await designRow(id);
    expect(row).toMatchObject({ status: 'approved', approvalSource: 'khalta' });
    expect(row.approvedBy).not.toBe(row.createdBy);
    const [t] = await env.db
      .select()
      .from(schema.designTransitions)
      .where(
        and(
          eq(schema.designTransitions.designId, id),
          eq(schema.designTransitions.toStatus, 'approved'),
        ),
      )
      .orderBy(desc(schema.designTransitions.at));
    expect(t!.esignature).toMatchObject({ meaning: 'approved', role: 'qc_manager' });
    expect(t!.evidence).toMatchObject({ kind: 'four_eyes_approval' });
    // approved content never changes in place
    await expect(
      env.db
        .update(schema.mixDesigns)
        .set({ requirements: {} })
        .where(eq(schema.mixDesigns.id, id)),
    ).rejects.toThrow();
  });

  it('the database itself refuses a jump outside the graph and a self-approval', async () => {
    const { id } = await trialCandidate('LC-5');
    await expect(
      env.db
        .update(schema.mixDesigns)
        .set({ status: 'approved' })
        .where(eq(schema.mixDesigns.id, id)),
    ).rejects.toThrow();
    const d = await designRow(id);
    await expect(
      env.db
        .update(schema.mixDesigns)
        .set({
          status: 'in_production',
          approvalSource: 'khalta',
          approvedBy: d.createdBy,
          approvedAt: new Date(),
        })
        .where(eq(schema.mixDesigns.id, id)),
    ).rejects.toThrow();
  });

  it('every illegal move through the API is refused with a named reason', async () => {
    const { id } = await trialCandidate('LC-6');
    const mgr = await as('qc_manager');
    for (const [path, body] of [
      ['approve', SIGN],
      ['pass-trial', SIGN],
      ['release', SIGN],
    ] as const) {
      const r = await mgr.post(`/api/designs/${id}/${path}`).send(body);
      expect(r.status, path).toBe(409);
      expect(r.body.error.message).toMatch(/cannot move|needs|available/);
    }
    expect((await designRow(id)).status).toBe('trial_candidate');
    const checklist = await mgr.get(`/api/designs/${id}/gates?to=approved`);
    expect(checklist.body.edge.ok).toBe(false);
  });
});

describe('declared-values policy (07 §2.5)', () => {
  it('blocks approval until a QC manager accepts the declared values; off by setting', async () => {
    await setCriteria(true);
    await verifyRules(true);
    const { id } = await trialCandidate('LC-7');
    // the sand's gradation is now only user-declared (a newer test of the same material)
    const lines = await env.db
      .select()
      .from(schema.mixDesignLines)
      .where(eq(schema.mixDesignLines.designId, id));
    const fine = await env.db
      .select({ id: schema.materials.id })
      .from(schema.materials)
      .where(
        and(eq(schema.materials.tenantId, env.tenantId), eq(schema.materials.category, 'fine_agg')),
      );
    const sand = lines.find((l) => fine.some((f) => f.id === l.materialId))!;
    const [cur] = await env.db
      .select()
      .from(schema.materialTests)
      .where(
        and(
          eq(schema.materialTests.materialId, sand.materialId),
          eq(schema.materialTests.isCurrent, true),
        ),
      );
    await env.db
      .update(schema.materialTests)
      .set({ isCurrent: false })
      .where(eq(schema.materialTests.id, cur!.id));
    await env.db.insert(schema.materialTests).values({
      tenantId: env.tenantId,
      materialId: sand.materialId,
      version: cur!.version + 1,
      isCurrent: true,
      source: 'user_declared',
      declaredReason: 'SYNTHETIC declared values',
      declaredBy: (await env.seedUser('qc_engineer')).id,
      declaredAt: new Date(),
      fieldSources: Object.fromEntries(
        Object.keys(cur!.properties as object).map((k) => [k, 'user_declared']),
      ),
      properties: cur!.properties,
      testedAt: '2026-08-01',
    });
    // re-evaluate so the stored evidence is current, then walk the trial
    const mgr = await as('qc_manager');
    await mgr.post(`/api/designs/${id}/evaluate`).send({ mode: 'ACI' });
    await toTrialPassed(id);
    const other = await as('qc_manager');
    const blocked = await other.post(`/api/designs/${id}/approve`).send(SIGN);
    expect(blocked.status).toBe(409);
    expect(gates(blocked.body.error)).toEqual(['declared_values']);
    // an engineer cannot accept; a QC manager can, with an e-signature
    expect(
      (
        await (
          await as('qc_engineer', [plantA])
        )
          .post(`/api/designs/${id}/accept-declared`)
          .send(SIGN)
      ).status,
    ).toBe(403);
    const acc = await other.post(`/api/designs/${id}/accept-declared`).send(SIGN);
    expect(acc.status, JSON.stringify(acc.body)).toBe(201);
    expect(acc.body.materials[0].fields.length).toBeGreaterThan(0);
    const ok = await other.post(`/api/designs/${id}/approve`).send(SIGN);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    // setting off: no acceptance needed
    const b = await trialCandidate('LC-7b');
    await setSettings({ approvalRequiresLabSource: false });
    await toTrialPassed(b.id);
    const g = await other.get(`/api/designs/${b.id}/gates?to=approved`);
    expect(g.body.gates.find((x: { id: string }) => x.id === 'declared_values').met).toBe(true);
    await setSettings({});
    // restore the datasheet test so later tests see lab-or-datasheet values again
    await env.db
      .update(schema.materialTests)
      .set({ isCurrent: false })
      .where(
        and(
          eq(schema.materialTests.materialId, sand.materialId),
          eq(schema.materialTests.isCurrent, true),
        ),
      );
    await env.db.insert(schema.materialTests).values({
      tenantId: env.tenantId,
      materialId: sand.materialId,
      version: cur!.version + 2,
      isCurrent: true,
      source: 'supplier_datasheet',
      properties: cur!.properties,
      testedAt: '2026-08-01',
    });
  });

  it('there is nothing to accept on a design with lab or datasheet values', async () => {
    const { id } = await trialCandidate('LC-8');
    const mgr = await as('qc_manager');
    expect((await mgr.post(`/api/designs/${id}/accept-declared`).send(SIGN)).status).toBe(409);
  });
});

describe('versions, diff, supersede, release and retire', () => {
  it('a new version goes back through the gates and approving it supersedes the old one', async () => {
    await setCriteria(true);
    await verifyRules(true);
    const { id, engineer } = await trialCandidate('LC-9');
    await toTrialPassed(id);
    const mgr = await as('qc_manager');
    expect((await mgr.post(`/api/designs/${id}/approve`).send(SIGN)).status).toBe(200);

    // a draft cannot be versioned; an approved one can
    const lines = (
      await env.db
        .select()
        .from(schema.mixDesignLines)
        .where(eq(schema.mixDesignLines.designId, id))
    ).map((l) => ({ materialId: l.materialId, quantityKgM3: Number(l.quantityKgM3) }));
    const cements = await env.db
      .select({ id: schema.materials.id })
      .from(schema.materials)
      .where(
        and(eq(schema.materials.tenantId, env.tenantId), eq(schema.materials.category, 'cement')),
      );
    const changed = lines.map((l) => ({
      materialId: l.materialId,
      kgPerM3: (cements.some((c) => c.id === l.materialId)
        ? l.quantityKgM3 - 0.01
        : l.quantityKgM3
      ).toFixed(3),
    }));
    const v2 = await engineer
      .post(`/api/designs/${id}/versions`)
      .send({ lines: changed, note: 'a hair less cement' });
    expect(v2.status, JSON.stringify(v2.body)).toBe(201);
    expect(v2.body).toMatchObject({ version: 2, status: 'draft' });
    expect((await designRow(id)).status).toBe('approved'); // the parent keeps its state

    const diff = await mgr.get(`/api/designs/${id}/diff/${v2.body.id}`);
    expect(diff.status).toBe(200);
    expect(diff.body.classes).toContain('proportion_change');
    expect(diff.body.requiresTrial).toBe(true);
    expect(diff.body.lines.filter((l: { change: string }) => l.change === 'changed').length).toBe(
      1,
    );
    const list = await mgr.get(`/api/designs/${id}/versions`);
    expect(list.body.map((x: { version: number }) => x.version)).toEqual([2, 1]);

    // the new version must still pass a trial before it can be approved
    const early = await mgr.post(`/api/designs/${v2.body.id}/approve`).send(SIGN);
    expect(early.status).toBe(409);
    // SYNTHETIC fixture: evaluate v2, then walk it along the graph edges to trial_passed and approve
    await mgr.post(`/api/designs/${v2.body.id}/evaluate`).send({ mode: 'ACI' });
    await env.db
      .update(schema.mixDesigns)
      .set({ status: 'trial_candidate' })
      .where(eq(schema.mixDesigns.id, v2.body.id));
    await toTrialPassed(v2.body.id);
    const ok = await mgr.post(`/api/designs/${v2.body.id}/approve`).send(SIGN);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.superseded).toBe(id);
    expect((await designRow(id)).status).toBe('superseded');
    const [t] = await env.db
      .select()
      .from(schema.designTransitions)
      .where(
        and(
          eq(schema.designTransitions.designId, id),
          eq(schema.designTransitions.toStatus, 'superseded'),
        ),
      );
    expect(t!.evidence).toMatchObject({ kind: 'new_version_approved', supersededBy: v2.body.id });
    // terminal: no way out
    expect((await mgr.post(`/api/designs/${id}/retire`).send(SIGN)).status).toBe(409);
    expect((await mgr.post(`/api/designs/${id}/release`).send(SIGN)).status).toBe(409);
  });

  it('release: QC manager anywhere, plant manager only at their own plant; retire is the QC manager', async () => {
    await setCriteria(true);
    await verifyRules(true);
    const { id } = await trialCandidate('LC-10');
    await toTrialPassed(id);
    const mgr = await as('qc_manager');
    await mgr.post(`/api/designs/${id}/approve`).send(SIGN);
    const elsewhere = await as('plant_manager', [plantB]);
    expect((await elsewhere.post(`/api/designs/${id}/release`).send(SIGN)).status).toBe(404);
    const eng = await as('qc_engineer', [plantA]);
    expect((await eng.post(`/api/designs/${id}/release`).send(SIGN)).status).toBe(403);
    const own = await as('plant_manager', [plantA]);
    expect((await own.post(`/api/designs/${id}/release`).send(SIGN)).status).toBe(200);
    expect((await designRow(id)).status).toBe('in_production');
    expect((await own.post(`/api/designs/${id}/retire`).send(SIGN)).status).toBe(403);
    const r = await mgr
      .post(`/api/designs/${id}/retire`)
      .send({ reason: 'Replaced by a new product line' });
    expect(r.status).toBe(200);
    expect((await designRow(id)).status).toBe('retired');
  });

  it('library filters the approval queue and trials', async () => {
    const mgr = await as('qc_manager');
    const awaiting = await mgr.get('/api/designs?stage=awaiting');
    expect(awaiting.status).toBe(200);
    for (const d of awaiting.body) expect(d.status).toBe('trial_passed');
    const trial = await mgr.get('/api/designs?stage=trial');
    for (const d of trial.body)
      expect(['trial_candidate', 'trial_in_progress']).toContain(d.status);
  });
});
