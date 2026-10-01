import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

describe('tenant settings', () => {
  it('returns defaults, merges patches, rejects unknown and invalid values', async () => {
    const admin = await env.login((await env.seedUser('admin')).email);
    const defaults = (await admin.get('/api/settings')).body;
    expect(defaults).toMatchObject({
      maxPlants: 20,
      salesCanViewCost: false,
      minorAdjustmentPolicy: 'none',
      stalePriceDays: null,
    });
    const patched = await admin.patch('/api/settings').send({ stalePriceDays: 30 });
    expect(patched.body).toMatchObject({ stalePriceDays: 30, maxPlants: 20 });
    expect((await admin.get('/api/settings')).body.stalePriceDays).toBe(30);
    expect((await admin.patch('/api/settings').send({ maxPlants: 0 })).status).toBe(400);
    expect(
      (await admin.patch('/api/settings').send({ minorAdjustmentPolicy: 'always' })).status,
    ).toBe(400);
    expect((await admin.patch('/api/settings').send({ unknown: true })).status).toBe(400);
  });

  it('sales_can_view_cost flips only the sales cost capability', async () => {
    const admin = await env.login((await env.seedUser('admin')).email);
    const sales = await env.login((await env.seedUser('sales')).email);
    await admin.patch('/api/settings').send({ salesCanViewCost: false });
    expect((await sales.get('/api/me')).body.capabilities).not.toContain('cost.view');
    await admin.patch('/api/settings').send({ salesCanViewCost: true });
    expect((await sales.get('/api/me')).body.capabilities).toEqual(['cost.view', 'library.read']);
    await admin.patch('/api/settings').send({ salesCanViewCost: false });
  });

  it('enforces the plant limit', async () => {
    const small = await createTestEnv();
    try {
      const admin = await small.login((await small.seedUser('admin')).email);
      await admin.patch('/api/settings').send({ maxPlants: 2 });
      const mk = (code: string) =>
        admin.post('/api/plants').send({ code, nameAr: 'م', nameEn: code });
      expect((await mk('L-1')).status).toBe(201);
      expect((await mk('L-2')).status).toBe(201);
      expect((await mk('L-3')).status).toBe(409);
    } finally {
      await small.close();
    }
  });

  it('rejects non-decimal money-like input on plants (no floats)', async () => {
    const admin = await env.login((await env.seedUser('admin')).email);
    const base = { nameAr: 'م', nameEn: 'P' };
    expect(
      (await admin.post('/api/plants').send({ ...base, code: 'M-1', haulCostJodPerM3Km: '0.045' }))
        .status,
    ).toBe(201);
    expect(
      (await admin.post('/api/plants').send({ ...base, code: 'M-2', haulCostJodPerM3Km: 0.045 }))
        .status,
    ).toBe(400);
    expect(
      (await admin.post('/api/plants').send({ ...base, code: 'M-3', haulCostJodPerM3Km: '0.0455' }))
        .status,
    ).toBe(400);
  });
});

describe('tenant isolation', () => {
  it("one tenant never sees or touches another tenant's data", async () => {
    const other = await env.seedTenant('other');
    const foreignAdmin = await env.seedUser('admin', { tenantId: other.id });
    const foreignPlant = await env.seedPlant('OTH-1', foreignAdmin.id, other.id);
    const mine = await env.login((await env.seedUser('admin')).email);
    const theirs = await env.login(foreignAdmin.email);

    expect((await mine.get('/api/plants')).body.map((p: { code: string }) => p.code)).not.toContain(
      'OTH-1',
    );
    expect((await theirs.get('/api/plants')).body.map((p: { code: string }) => p.code)).toEqual([
      'OTH-1',
    ]);
    expect((await mine.get(`/api/plants/${foreignPlant.id}`)).status).toBe(404);
    expect((await mine.patch(`/api/plants/${foreignPlant.id}`).send({ city: 'x' })).status).toBe(
      404,
    );
    expect((await mine.delete(`/api/plants/${foreignPlant.id}`)).status).toBe(404);
    expect((await mine.delete(`/api/users/${foreignAdmin.id}`)).status).toBe(404);
    expect((await mine.get('/api/users')).body.map((u: { id: string }) => u.id)).not.toContain(
      foreignAdmin.id,
    );
    expect(
      (await mine.put(`/api/users/${foreignAdmin.id}/plants`).send({ plantIds: [] })).status,
    ).toBe(404);

    const mineAudit = await mine.get('/api/audit?limit=200');
    expect(mineAudit.body.every((r: { tenantId: string }) => r.tenantId === env.tenantId)).toBe(
      true,
    );
    // a plant of another tenant cannot be assigned to my user either
    const u = await env.seedUser('viewer');
    expect(
      (await mine.put(`/api/users/${u.id}/plants`).send({ plantIds: [foreignPlant.id] })).status,
    ).toBe(404);
  });
});
