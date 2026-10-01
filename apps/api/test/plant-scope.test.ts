import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
let a: { id: string }, b: { id: string }, c: { id: string };
beforeAll(async () => {
  env = await createTestEnv();
  a = await env.seedPlant('AMM-01');
  b = await env.seedPlant('AQB-01');
  c = await env.seedPlant('ZRQ-01');
});
afterAll(() => env.close());

const codes = (body: { code: string }[]) => body.map((p) => p.code).sort();

describe('plant scoping', () => {
  it('admin and QC manager see every plant', async () => {
    for (const role of ['admin', 'qc_manager'] as const) {
      const agent = await env.login((await env.seedUser(role)).email);
      expect(codes((await agent.get('/api/plants')).body)).toEqual(['AMM-01', 'AQB-01', 'ZRQ-01']);
    }
  });

  it('scoped roles see only assigned plants, and others look non-existent (404, not 403)', async () => {
    for (const role of [
      'qc_engineer',
      'procurement',
      'plant_manager',
      'sales',
      'viewer',
    ] as const) {
      const agent = await env.login((await env.seedUser(role, { plantIds: [a.id] })).email);
      expect(codes((await agent.get('/api/plants')).body), role).toEqual(['AMM-01']);
      expect((await agent.get(`/api/plants/${a.id}`)).status).toBe(200);
      expect((await agent.get(`/api/plants/${b.id}`)).status, role).toBe(404);
      const missing = await agent.get('/api/plants/00000000-0000-4000-8000-0000000000ff');
      expect((await agent.get(`/api/plants/${b.id}`)).body).toEqual(missing.body); // no existence leak
    }
  });

  it('a scoped user with no assignments sees nothing', async () => {
    const agent = await env.login((await env.seedUser('plant_manager')).email);
    expect((await agent.get('/api/plants')).body).toEqual([]);
  });

  it('assignment changes take effect on the next request and soft-deleted plants disappear', async () => {
    const admin = await env.login((await env.seedUser('admin')).email);
    const u = await env.seedUser('plant_manager', { plantIds: [a.id] });
    const agent = await env.login(u.email);
    expect(codes((await agent.get('/api/plants')).body)).toEqual(['AMM-01']);
    expect(
      (await admin.put(`/api/users/${u.id}/plants`).send({ plantIds: [b.id, c.id] })).status,
    ).toBe(200);
    expect(codes((await agent.get('/api/plants')).body)).toEqual(['AQB-01', 'ZRQ-01']);
    expect((await admin.delete(`/api/plants/${c.id}`)).status).toBe(200);
    expect(codes((await agent.get('/api/plants')).body)).toEqual(['AQB-01']);
    expect((await agent.get(`/api/plants/${c.id}`)).status).toBe(404);
  });
});
