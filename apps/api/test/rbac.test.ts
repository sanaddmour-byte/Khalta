import { CAPABILITIES, ROLES, roleCan, type Role } from '@khalta/rbac';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

const UUID = '00000000-0000-4000-8000-000000000001';
const fill = (path: string) => path.replace(':id', UUID);

// Every declared route x every role. 403 iff the role lacks the route's capability; otherwise the
// request must get past authorization (anything but 401/403; invalid probes hit 400/404 safely).
describe('route authorization matrix (generated from declared routes)', () => {
  for (const role of ROLES) {
    it(`${role}`, async () => {
      const user = await env.seedUser(role);
      const agent = await env.login(user.email);
      const settings = { salesCanViewCost: false };
      for (const r of env.app.api.routes) {
        const call = agent[r.method.toLowerCase() as 'get'](fill(r.path));
        const res = await (r.method === 'GET' ? call : call.send({}));
        const allowed = r.capability === null || roleCan(role as Role, r.capability, settings);
        const label = `${role} ${r.method} ${r.path}`;
        if (allowed) expect([401, 403], label).not.toContain(res.status);
        else expect(res.status, label).toBe(403);
      }
    });
  }

  it('declares routes for the capabilities it claims to protect', () => {
    const used = new Set(env.app.api.routes.map((r) => r.capability).filter(Boolean));
    expect(used.size).toBeGreaterThan(0);
    for (const c of used) expect(CAPABILITIES).toContain(c);
  });

  it('/api/me reports exactly the matrix capabilities', async () => {
    for (const role of ROLES) {
      const u = await env.seedUser(role);
      const me = await (await env.login(u.email)).get('/api/me');
      const expected = CAPABILITIES.filter((c) => roleCan(role, c, { salesCanViewCost: false }));
      expect(me.body.capabilities).toEqual(expected);
    }
  });
});
