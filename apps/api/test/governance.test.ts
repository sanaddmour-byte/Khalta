import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';

// Administrative privilege never substitutes for engineering authority (ADR 0020).
let env: TestEnv;
let admin: Awaited<ReturnType<TestEnv['login']>>;
let qcm: Awaited<ReturnType<TestEnv['login']>>;
let adminId: string;

beforeAll(async () => {
  env = await createTestEnv({}, { seedRules: true });
  const a = await env.seedUser('admin');
  adminId = a.id;
  admin = await env.login(a.email);
  qcm = await env.login((await env.seedUser('qc_manager')).email);
});
afterAll(() => env.close());

describe('settings: administrative keys vs safety-relevant keys', () => {
  it('the admin changes organisational keys but not the ones that shape evidence, limits or acceptance', async () => {
    expect((await admin.patch('/api/settings').send({ maxPlants: 25 })).status).toBe(200);
    for (const body of [
      { approvalRequiresLabSource: false },
      { strengthModelMinResults: 5 },
      { safetyMarginMpa: 0 },
      { optimizer: { timeBudgetSeconds: 40 } },
    ]) {
      const r = await admin.patch('/api/settings').send(body);
      expect(r.status, JSON.stringify(body)).toBe(403);
      expect(r.body.error.code).toBe('engineering_authorization_required');
      expect(r.body.error.details.keys).toEqual(Object.keys(body));
    }
    // nothing changed
    expect((await qcm.get('/api/settings')).body.approvalRequiresLabSource).toBe(true);
  });

  it('the QC manager changes the safety-relevant keys, not the organisational ones, and the audit says which', async () => {
    const before = (await env.auditRows()).length;
    const q1 = await qcm.patch('/api/settings').send({ safetyMarginMpa: 1 });
    expect(q1.status, JSON.stringify(q1.body)).toBe(200);
    const row = (await env.auditRows()).slice(before).find((r) => r.action === 'settings.update')!;
    expect(row.after).toMatchObject({
      _changed: ['safetyMarginMpa'],
      _safetyRelevant: ['safetyMarginMpa'],
    });
    const denied = await qcm.patch('/api/settings').send({ maxPlants: 30 });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('administrator_required');
    // a mixed request is refused whole: nothing is applied
    const mixed = await admin.patch('/api/settings').send({ maxPlants: 22, safetyMarginMpa: 5 });
    expect(mixed.status).toBe(403);
    expect((await qcm.get('/api/settings')).body).toMatchObject({
      maxPlants: 25,
      safetyMarginMpa: 1,
    });
  });
});

describe('rule values and the engineering sign-offs', () => {
  it('the admin can read rules but cannot change a value, commit JS values, verify a rule or sign off a design', async () => {
    const rules = (await admin.get('/api/rules')).body.rules as { id: string; key: string }[];
    expect(rules.length).toBeGreaterThan(0);
    const some = rules[0]!;
    expect(
      (await admin.patch(`/api/rules/${some.id}/value`).send({ value: 1, reason: 'admin trying' }))
        .status,
    ).toBe(403);
    expect((await admin.post('/api/rules/import/commit').send({ rows: [] })).status).toBe(403);
    expect(
      (await admin.post(`/api/rules/${some.id}/verify`).send({ note: 'admin verifying' })).status,
    ).toBe(403);
    for (const path of ['pass-trial', 'approve', 'release', 'retire', 'suspend', 'reinstate']) {
      const r = await admin
        .post(`/api/designs/00000000-0000-4000-8000-000000000001/${path}`)
        .send({ reason: 'admin bypass attempt' });
      expect(r.status, path).toBe(403);
    }
    expect((await qcm.get('/api/rules')).status).toBe(200);
  });
});

describe('role changes are governed and audited', () => {
  it('nobody changes their own role; an engineering role needs a recorded reason in both directions', async () => {
    expect((await admin.patch(`/api/users/${adminId}`).send({ role: 'viewer' })).status).toBe(409);

    const u = await admin.post('/api/users').send({
      email: 'gov@example.test',
      name: 'Gov',
      role: 'viewer',
      password: 'a-long-test-password-1',
    });
    expect(u.status).toBe(201);
    const noReason = await admin.patch(`/api/users/${u.body.id}`).send({ role: 'qc_manager' });
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.code).toBe('reason_required');

    const before = (await env.auditRows()).length;
    const ok = await admin
      .patch(`/api/users/${u.body.id}`)
      .send({ role: 'qc_manager', reason: 'Appointed QC manager for the Amman plant' });
    expect(ok.status).toBe(200);
    const row = (await env.auditRows()).slice(before).find((r) => r.action === 'user.update')!;
    expect(row.before).toMatchObject({ role: 'viewer' });
    expect(row.after).toMatchObject({
      role: 'qc_manager',
      reason: 'Appointed QC manager for the Amman plant',
      engineeringRoleChange: true,
    });

    // removing an engineering role is governed the same way
    expect((await admin.patch(`/api/users/${u.body.id}`).send({ role: 'viewer' })).status).toBe(
      422,
    );
    expect(
      (
        await admin
          .patch(`/api/users/${u.body.id}`)
          .send({ role: 'viewer', reason: 'Left the QC team' })
      ).status,
    ).toBe(200);
    // a change between two non-engineering roles needs no reason
    expect((await admin.patch(`/api/users/${u.body.id}`).send({ role: 'sales' })).status).toBe(200);
  });
});
