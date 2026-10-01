import { AuditMissingError, schema, withAudit } from '@khalta/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, PASSWORD, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

const after = async (fn: () => Promise<unknown>) => {
  const before = (await env.auditRows()).length;
  await fn();
  return (await env.auditRows()).slice(before);
};

describe('audit completeness', () => {
  it('records exactly one correct row per successful mutation', async () => {
    const admin = await env.seedUser('admin');
    const agent = await env.login(admin.email);
    const ctx = { actorId: admin.id, actorRole: 'admin', tenantId: env.tenantId };

    let rows = await after(async () => {
      const res = await agent
        .post('/api/plants')
        .send({ code: 'AMM-01', nameAr: 'عمان', nameEn: 'Amman' });
      expect(res.status).toBe(201);
      (env as unknown as { plantId: string }).plantId = res.body.id;
    });
    const plantId = (env as unknown as { plantId: string }).plantId;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ...ctx,
      action: 'plant.create',
      entityType: 'plant',
      entityId: plantId,
      before: null,
    });
    expect(rows[0]!.after).toMatchObject({ code: 'AMM-01' });
    expect(rows[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);

    rows = await after(async () => {
      await agent.patch(`/api/plants/${plantId}`).send({ city: 'Amman' });
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'plant.update', entityId: plantId });
    expect(rows[0]!.before).toMatchObject({ city: null });
    expect(rows[0]!.after).toMatchObject({ city: 'Amman' });

    let userId = '';
    rows = await after(async () => {
      const res = await agent
        .post('/api/users')
        .send({ email: 'New@Example.test', name: 'New', role: 'viewer', password: PASSWORD });
      expect(res.status).toBe(201);
      userId = res.body.id;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'user.create', entityId: userId });
    expect(rows[0]!.after).toMatchObject({ email: 'new@example.test' }); // normalized

    rows = await after(async () => {
      await agent.patch(`/api/users/${userId}`).send({ role: 'qc_engineer' });
    });
    expect(rows[0]).toMatchObject({ action: 'user.update' });
    expect(rows[0]!.before).toMatchObject({ role: 'viewer' });
    expect(rows[0]!.after).toMatchObject({ role: 'qc_engineer' });

    rows = await after(async () => {
      await agent.put(`/api/users/${userId}/plants`).send({ plantIds: [plantId] });
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'user.plants_set' });
    expect(rows[0]!.after).toEqual({ plantIds: [plantId] });

    rows = await after(async () => {
      await agent
        .post(`/api/users/${userId}/password`)
        .send({ password: 'another-long-passphrase' });
    });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain('another-long-passphrase');

    rows = await after(async () => {
      await agent.patch('/api/settings').send({ maxPlants: 7 });
    });
    expect(rows[0]).toMatchObject({ action: 'settings.update', entityType: 'tenant_settings' });
    expect(rows[0]!.before).toMatchObject({ maxPlants: 20 });
    expect(rows[0]!.after).toMatchObject({ maxPlants: 7 });

    rows = await after(async () => {
      await agent.delete(`/api/plants/${plantId}`);
    });
    expect(rows[0]).toMatchObject({ action: 'plant.delete' });
    rows = await after(async () => {
      await agent.delete(`/api/users/${userId}`);
    });
    expect(rows[0]).toMatchObject({ action: 'user.delete' });
  });

  it('writes nothing when the request fails validation, authorization or lookup', async () => {
    const admin = await env.login((await env.seedUser('admin')).email);
    const viewer = await env.login((await env.seedUser('viewer')).email);
    const rows = await after(async () => {
      expect(
        (await admin.post('/api/plants').send({ code: '', nameAr: 'x', nameEn: 'x' })).status,
      ).toBe(400);
      expect(
        (await admin.post('/api/plants').send({ code: 'X', nameAr: 'x', nameEn: 'x', extra: 1 }))
          .status,
      ).toBe(400);
      expect(
        (await viewer.post('/api/plants').send({ code: 'V', nameAr: 'x', nameEn: 'x' })).status,
      ).toBe(403);
      expect(
        (await admin.patch('/api/plants/00000000-0000-4000-8000-0000000000aa').send({ city: 'x' }))
          .status,
      ).toBe(404);
    });
    expect(rows).toEqual([]);
  });

  it('rolls back the change when the audit write or the handler fails (same transaction)', async () => {
    const ctx = { tenantId: env.tenantId, actor: null, requestId: 'test' };
    const countPlants = async () =>
      (await env.db.select().from(schema.plants).where(eq(schema.plants.code, 'RB-1'))).length;

    await expect(
      withAudit(env.db, ctx, async (tx, audit) => {
        await tx
          .insert(schema.plants)
          .values({ tenantId: env.tenantId, code: 'RB-1', nameAr: 'a', nameEn: 'a' });
        await audit.record({ action: 'x', entityType: 'plant', entityId: 'x' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await countPlants()).toBe(0);

    const before = (await env.auditRows()).length;
    await expect(
      withAudit(env.db, ctx, async (tx) => {
        await tx
          .insert(schema.plants)
          .values({ tenantId: env.tenantId, code: 'RB-1', nameAr: 'a', nameEn: 'a' });
      }),
    ).rejects.toBeInstanceOf(AuditMissingError);
    expect(await countPlants()).toBe(0);
    expect((await env.auditRows()).length).toBe(before);

    // A failing audit insert (bad tenant FK) rolls back the business row too.
    await expect(
      withAudit(
        env.db,
        { ...ctx, tenantId: '00000000-0000-4000-8000-000000000000' },
        async (tx, audit) => {
          await tx
            .insert(schema.plants)
            .values({ tenantId: env.tenantId, code: 'RB-1', nameAr: 'a', nameEn: 'a' });
          await audit.record({ action: 'x', entityType: 'plant', entityId: 'x' });
        },
      ),
    ).rejects.toThrow();
    expect(await countPlants()).toBe(0);
  });

  it('every non-GET route except the auth handler is declared through the audited mutation helper', () => {
    interface Layer {
      route?: { path: string; methods: Record<string, boolean> };
      handle?: { stack?: Layer[] };
    }
    const stack = (env.app as unknown as { router: { stack: Layer[] } }).router.stack;
    const found: string[] = [];
    const walk = (layers: Layer[]) => {
      for (const l of layers) {
        if (l.route) {
          for (const m of Object.keys(l.route.methods))
            if (!['get', 'head', 'options'].includes(m) && !l.route.path.startsWith('/api/auth'))
              found.push(`${m.toUpperCase()} ${l.route.path}`);
        } else if (l.handle?.stack) walk(l.handle.stack);
      }
    };
    walk(stack);
    expect(found.length).toBeGreaterThan(0);
    // Read-only POSTs (a body carries the query) write nothing and are declared separately.
    const writes = found.filter((f) => !env.app.api.readOnlyPosts.has(f));
    for (const f of writes) expect(env.app.api.mutationRoutes, f).toContain(f);
    expect(writes.length).toBe(env.app.api.mutationRoutes.size);
  });

  it('audit_log is append-only at the database level', async () => {
    await env.seedUser('admin'); // ensure at least one row exists
    const q = (s: string) => env.pool.query(s);
    await expect(q(`UPDATE audit_log SET action = 'tampered'`)).rejects.toThrow(/append-only/);
    await expect(q(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
    await expect(q(`TRUNCATE audit_log`)).rejects.toThrow(/append-only/);
    expect((await env.auditRows()).length).toBeGreaterThan(0);
  });

  it('is readable only through audit.read, scoped to the tenant, and filterable', async () => {
    const admin = await env.login((await env.seedUser('admin')).email);
    const qce = await env.login((await env.seedUser('qc_engineer')).email);
    expect((await qce.get('/api/audit')).status).toBe(403);
    const res = await admin.get('/api/audit?entityType=settings&limit=5');
    expect(res.status).toBe(200);
    const all = await admin.get('/api/audit?limit=200');
    expect(all.body.length).toBeGreaterThan(3);
    const ids = all.body.map((r: { id: number }) => r.id);
    expect(ids).toEqual([...ids].sort((x: number, y: number) => y - x));
    const page = await admin.get(`/api/audit?limit=2&before=${ids[1]}`);
    expect(page.body[0].id).toBeLessThan(ids[1]);
    expect((await admin.get('/api/audit?limit=0')).status).toBe(400);
  });

  it('records the bootstrap admin as a system action', async () => {
    const boot = await createTestEnv({
      BOOTSTRAP_ADMIN_EMAIL: 'root@example.test',
      BOOTSTRAP_ADMIN_PASSWORD: 'bootstrap-passphrase-1',
    });
    try {
      const rows = await boot.auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'user.bootstrap_admin', actorId: null });
      const agent = await boot.login('root@example.test', 'bootstrap-passphrase-1');
      expect((await agent.get('/api/me')).body.role).toBe('admin');
    } finally {
      await boot.close();
    }
    // Not re-created once users exist.
    const rows = await env.db
      .select({ n: sql<number>`count(*)` })
      .from(schema.users)
      .where(eq(schema.users.email, 'root@example.test'));
    expect(Number(rows[0]!.n)).toBe(0);
  });
});
