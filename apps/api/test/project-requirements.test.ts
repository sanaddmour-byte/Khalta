import { schema } from '@khalta/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';

// SYNTHETIC project requirements: the values are invented for tests and are not any project's specification.
let env: TestEnv;
let eng: Awaited<ReturnType<TestEnv['login']>>;
let qcm: Awaited<ReturnType<TestEnv['login']>>;
let qcm2: Awaited<ReturnType<TestEnv['login']>>;

const limit = (over: Record<string, unknown> = {}) => ({
  key: 'max_wcm',
  bound: 'max',
  value: 0.45,
  unit: 'ratio',
  basis: { specimen: 'cylinder', ageDays: 28, method: null },
  source: 'project',
  sourceRef: 'SYNTHETIC spec §3.2',
  ...over,
});
const content = (limits: unknown[] = [limit()]) => ({
  standards: [{ ruleset: 'JS', name: 'SYNTHETIC standard', edition: 'SYNTHETIC' }],
  specification: { reference: 'SYN-SPEC-1', revision: 'A' },
  strength: {
    designation: 'C30/37',
    basis: 'cylinder',
    specifiedMpa: 30,
    testAgeDays: 28,
    acceptanceMethod: 'SYNTHETIC acceptance method',
  },
  exposure: ['S2'],
  governingLimits: limits,
});
const SIGN = { reason: 'Checked against the project specification' };

beforeAll(async () => {
  env = await createTestEnv({}, { seedRules: true });
  eng = await env.login((await env.seedUser('qc_engineer')).email);
  qcm = await env.login((await env.seedUser('qc_manager')).email);
  qcm2 = await env.login((await env.seedUser('qc_manager')).email);
});
afterAll(() => env.close());

describe('project requirements revisions', () => {
  it('a draft is verified by a second person; the author cannot, and the database says so too', async () => {
    const made = await eng
      .post('/api/project-requirements')
      .send({ projectRef: 'PR-1', content: content() });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ projectRef: 'PR-1', revision: 1, status: 'draft' });
    // the engineer lacks rules.verify
    expect(
      (await eng.post(`/api/project-requirements/${made.body.id}/verify`).send(SIGN)).status,
    ).toBe(403);
    // a QC manager who is also the author cannot verify (four-eyes)
    const own = await qcm
      .post('/api/project-requirements')
      .send({ projectRef: 'PR-OWN', content: content() });
    expect(
      (await qcm.post(`/api/project-requirements/${own.body.id}/verify`).send(SIGN)).status,
    ).toBe(403);
    // the database refuses a self-verification even from outside the API
    await expect(
      env.pool.query(
        `UPDATE project_requirements SET status = 'verified', verified_by = created_by, verified_at = now(),
           verification = '{"x":1}'::jsonb WHERE id = $1`,
        [own.body.id],
      ),
    ).rejects.toThrow(/four-eyes/);
    const ok = await qcm.post(`/api/project-requirements/${made.body.id}/verify`).send(SIGN);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'verified' });
    const [row] = await env.db
      .select()
      .from(schema.projectRequirements)
      .where(eq(schema.projectRequirements.id, made.body.id));
    expect(row!.verification).toMatchObject({
      meaning: 'requirements_verified',
      role: 'qc_manager',
      contentHash: row!.contentHash,
    });
  });

  it('limits of one requirement on different bases block verification and are named, never merged', async () => {
    const made = await eng.post('/api/project-requirements').send({
      projectRef: 'PR-2',
      content: content([
        limit({ value: 0.5, source: 'code', sourceRef: 'SYNTHETIC code' }),
        limit({ value: 0.4, basis: { specimen: 'cube', ageDays: 28, method: null } }),
      ]),
    });
    expect(made.status).toBe(201);
    const shown = await eng.get(`/api/project-requirements/${made.body.id}`);
    expect(shown.body.limits.resolved).toEqual([]);
    expect(shown.body.limits.incompatible[0]).toMatchObject({
      key: 'max_wcm',
      reasons: ['specimen'],
    });
    const refused = await qcm.post(`/api/project-requirements/${made.body.id}/verify`).send(SIGN);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('incompatible_limits');
    expect(refused.body.error.details.incompatible).toHaveLength(1);
    // restated on a common basis it can be verified
    const fixed = await eng.patch(`/api/project-requirements/${made.body.id}`).send({
      content: content([
        limit({ value: 0.5, source: 'code', sourceRef: 'SYNTHETIC code' }),
        limit({ value: 0.4 }),
      ]),
    });
    expect(fixed.status).toBe(200);
    expect(
      (await qcm.post(`/api/project-requirements/${made.body.id}/verify`).send(SIGN)).status,
    ).toBe(200);
    const after = await eng.get(`/api/project-requirements/${made.body.id}`);
    expect(after.body.limits.resolved[0]).toMatchObject({ value: 0.4 });
    expect(after.body.limits.resolved[0].setAsideLooser).toHaveLength(1);
  });

  it('a verified revision is immutable; a change is a new revision, and verifying it supersedes the old one', async () => {
    const r1 = await eng
      .post('/api/project-requirements')
      .send({ projectRef: 'PR-3', content: content() });
    await qcm.post(`/api/project-requirements/${r1.body.id}/verify`).send(SIGN);
    expect(
      (
        await eng
          .patch(`/api/project-requirements/${r1.body.id}`)
          .send({ content: content([limit({ value: 0.4 })]) })
      ).status,
    ).toBe(409);
    await expect(
      env.pool.query(`UPDATE project_requirements SET content = '{}'::jsonb WHERE id = $1`, [
        r1.body.id,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      env.db
        .delete(schema.projectRequirements)
        .where(eq(schema.projectRequirements.id, r1.body.id)),
    ).rejects.toThrow();

    const r2 = await eng
      .post('/api/project-requirements')
      .send({ projectRef: 'PR-3', content: content([limit({ value: 0.4 })]) });
    expect(r2.body).toMatchObject({ revision: 2, status: 'draft', supersedesId: r1.body.id });
    // only one draft at a time
    expect(
      (await eng.post('/api/project-requirements').send({ projectRef: 'PR-3', content: content() }))
        .status,
    ).toBe(409);
    expect(
      (await qcm2.post(`/api/project-requirements/${r2.body.id}/verify`).send(SIGN)).status,
    ).toBe(200);
    const old = await eng.get(`/api/project-requirements/${r1.body.id}`);
    expect(old.body).toMatchObject({ status: 'superseded', supersededById: r2.body.id });
    expect(old.body.contentHash).toBe(r1.body.contentHash); // content untouched
  });

  it('every create, edit and verification is audited', async () => {
    const actions = (await env.auditRows()).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'project_requirements.create',
        'project_requirements.update',
        'project_requirements.verify',
      ]),
    );
  });
});
