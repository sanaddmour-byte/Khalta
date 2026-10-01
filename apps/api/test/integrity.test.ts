import { schema } from '@khalta/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, PASSWORD, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

describe('no hard deletes', () => {
  it('the database rejects DELETE on every business table', async () => {
    const u = await env.seedUser('admin');
    const p = await env.seedPlant('HD-1', u.id);
    await env.pool.query(
      `INSERT INTO user_plants (tenant_id, user_id, plant_id) VALUES ($1,$2,$3)`,
      [env.tenantId, u.id, p.id],
    );
    await env.pool.query(
      `INSERT INTO suppliers (tenant_id, name_ar, name_en) VALUES ($1,'م','S')`,
      [env.tenantId],
    );
    await env.pool.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [env.tenantId]);
    for (const table of [
      'users',
      'plants',
      'user_plants',
      'suppliers',
      'tenant_settings',
      'tenants',
    ])
      await expect(env.pool.query(`DELETE FROM ${table}`), table).rejects.toThrow(/hard delete/);
  });

  it('API deletes are soft, audited, and the row is retained', async () => {
    const admin = await env.login((await env.seedUser('admin')).email);
    const p = await env.seedPlant('HD-2');
    expect((await admin.delete(`/api/plants/${p.id}`)).status).toBe(200);
    const [row] = await env.db.select().from(schema.plants).where(eq(schema.plants.id, p.id));
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(row?.isActive).toBe(false);
    expect((await admin.delete(`/api/plants/${p.id}`)).status).toBe(404); // already gone from the API
  });

  it('a soft-deleted code can be reused; an active duplicate cannot', async () => {
    const admin = await env.login((await env.seedUser('admin')).email);
    const body = { code: 'DUP-1', nameAr: 'مكرر', nameEn: 'Dup' };
    const first = await admin.post('/api/plants').send(body);
    expect(first.status).toBe(201);
    expect((await admin.post('/api/plants').send(body)).status).toBe(409);
    await admin.delete(`/api/plants/${first.body.id}`);
    expect((await admin.post('/api/plants').send(body)).status).toBe(201);
  });
});

describe('user lifecycle', () => {
  it('creates users with normalized email, rejects duplicates and weak passwords', async () => {
    const admin = await env.login((await env.seedUser('admin')).email);
    const ok = await admin
      .post('/api/users')
      .send({ email: 'Case@Example.TEST', name: 'Case', role: 'sales', password: PASSWORD });
    expect(ok.status).toBe(201);
    expect(ok.body.email).toBe('case@example.test');
    expect(
      (
        await admin
          .post('/api/users')
          .send({ email: 'case@example.test', name: 'Again', role: 'sales', password: PASSWORD })
      ).status,
    ).toBe(409);
    expect(
      (
        await admin
          .post('/api/users')
          .send({ email: 'weak@example.test', name: 'W', role: 'sales', password: 'short' })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin
          .post('/api/users')
          .send({ email: 'r@example.test', name: 'R', role: 'root', password: PASSWORD })
      ).status,
    ).toBe(400);
    const list = await admin.get('/api/users');
    expect(JSON.stringify(list.body)).not.toMatch(/password|hash/i);
    // the new user can sign in and is scoped as a sales role
    const me = await (await env.login('case@example.test')).get('/api/me');
    expect(me.body.role).toBe('sales');
  });

  it('deactivation kills sessions, blocks sign-in, and keeps the row', async () => {
    const admin = await env.login((await env.seedUser('admin')).email);
    const victim = await env.seedUser('qc_engineer');
    const session = await env.login(victim.email);
    expect((await session.get('/api/me')).status).toBe(200);
    expect((await admin.delete(`/api/users/${victim.id}`)).status).toBe(200);
    expect((await session.get('/api/me')).status).toBe(401);
    await expect(env.login(victim.email)).rejects.toThrow(/login failed/);
    const [row] = await env.db.select().from(schema.users).where(eq(schema.users.id, victim.id));
    expect(row?.deletedAt).not.toBeNull();
    expect((await admin.get('/api/users')).body.map((u: { id: string }) => u.id)).not.toContain(
      victim.id,
    );
  });

  it('admin password reset changes the credential and signs the user out everywhere', async () => {
    const admin = await env.login((await env.seedUser('admin')).email);
    const u = await env.seedUser('viewer');
    const old = await env.login(u.email);
    expect(
      (await admin.post(`/api/users/${u.id}/password`).send({ password: 'brand-new-passphrase' }))
        .status,
    ).toBe(200);
    expect((await old.get('/api/me')).status).toBe(401);
    await expect(env.login(u.email, PASSWORD)).rejects.toThrow();
    expect((await (await env.login(u.email, 'brand-new-passphrase')).get('/api/me')).status).toBe(
      200,
    );
  });

  it('protects the last active admin and the caller from self-deletion', async () => {
    const solo = await createTestEnv();
    try {
      const only = await solo.seedUser('admin');
      const agent = await solo.login(only.email);
      expect((await agent.delete(`/api/users/${only.id}`)).status).toBe(409);
      expect((await agent.patch(`/api/users/${only.id}`).send({ role: 'viewer' })).status).toBe(
        409,
      );
      const second = await solo.seedUser('admin');
      expect((await agent.patch(`/api/users/${second.id}`).send({ role: 'viewer' })).status).toBe(
        200,
      );
      expect((await agent.patch(`/api/users/${only.id}`).send({ role: 'viewer' })).status).toBe(
        409,
      ); // again the last one
      expect((await agent.patch(`/api/users/${only.id}`).send({ name: 'Renamed' })).status).toBe(
        200,
      );
    } finally {
      await solo.close();
    }
  });

  it('validates plant assignment inputs', async () => {
    const admin = await env.login((await env.seedUser('admin')).email);
    const u = await env.seedUser('viewer');
    const p = await env.seedPlant('ASG-1');
    expect((await admin.put(`/api/users/${u.id}/plants`).send({ plantIds: ['nope'] })).status).toBe(
      400,
    );
    expect(
      (
        await admin
          .put(`/api/users/${u.id}/plants`)
          .send({ plantIds: ['00000000-0000-4000-8000-0000000000ab'] })
      ).status,
    ).toBe(404);
    expect(
      (await admin.put(`/api/users/${u.id}/plants`).send({ plantIds: [p.id, p.id] })).status,
    ).toBe(200);
    expect((await admin.put(`/api/users/${u.id}/plants`).send({ plantIds: [] })).status).toBe(200);
    expect((await admin.put('/api/users/missing-user/plants').send({ plantIds: [] })).status).toBe(
      404,
    );
  });
});
