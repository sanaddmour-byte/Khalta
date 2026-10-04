import { schema } from '@khalta/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';
import { optimizerWorld, REQUIREMENTS } from './opt-world';

// SYNTHETIC world (engine/src/testing/optimizer.ts).
let env: TestEnv;
let plantA: string;
let plantB: string;

beforeAll(async () => {
  env = await createTestEnv();
  [plantA, plantB] = (await optimizerWorld(env, ['TR-A', 'TR-B'])).plants as [string, string];
}, 120_000);
afterAll(async () => env.close());

const as = async (role: Parameters<TestEnv['seedUser']>[0], plantIds: string[] = []) =>
  env.login((await env.seedUser(role, { plantIds })).email);
const make = async (extra: Record<string, unknown> = {}) => {
  const m = await as('qc_manager');
  const res = await m
    .post('/api/design-requests')
    .send({ plantId: plantA, mode: 'ACI', requirements: REQUIREMENTS, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; candidates: { id: string }[] };
};

describe('optimizer transparency', () => {
  it('states how the search ended, what it ran under and what the validator did', async () => {
    const r = await make();
    const m = await as('qc_manager');
    const got = (await m.get(`/api/design-requests/${r.id}`)).body;
    const t = got.transparency;
    expect(t.termination.kind).toBe('optimal_within_search');
    expect(t.termination.searchComplete).toBe(true);
    expect(t.termination.objective.statement).toBe('lowest_cost_found');
    expect(t.termination.validator.accepted).toBe(got.candidates.length);
    expect(t.optimizerVersion).toBe('1.1.0');
    expect(t.priceBasis).toBeTruthy();
    // the LP cost before rounding and the rounding gap are stored for each candidate
    for (const c of got.candidates) {
      expect(c.solve.lpCostJod).toBeGreaterThan(0);
      expect(typeof c.solve.roundingGapJod).toBe('number');
    }
  });

  it('cost-blind roles see neither money figures nor the solve record', async () => {
    const r = await make();
    const sales = await as('sales', [plantA]);
    const got = (await sales.get(`/api/design-requests/${r.id}`)).body;
    expect(got.transparency.priceBasis).toBeNull();
    expect(got.outcome.termination.maxRoundingGapJod).toBeUndefined();
    expect(got.transparency.termination.maxRoundingGapJod).toBeUndefined();
    for (const c of got.candidates) {
      expect(c.solve).toBeNull();
      expect(c.costJodPerM3).toBeNull();
    }
    expect((await sales.get(`/api/design-requests/${r.id}/sensitivity`)).status).toBe(403);
  });

  it('a newer request supersedes the older: it stays readable but cannot make a design', async () => {
    const first = await make();
    const second = await make({ supersedes: first.id });
    const m = await as('qc_manager');
    const old = (await m.get(`/api/design-requests/${first.id}`)).body;
    expect(old.supersededBy).toBe(second.id);
    expect(old.candidates.length).toBeGreaterThan(0); // not overwritten, not deleted
    const eng = await as('qc_engineer', [plantA]);
    const refused = await eng
      .post(
        `/api/design-requests/${first.id}/candidates/${first.candidates[0]!.id}/trial-candidate`,
      )
      .send({ code: 'TR-OLD', name: 'old' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('request_superseded');
    expect(refused.body.error.details.supersededBy).toBe(second.id);
    const ok = await eng
      .post(
        `/api/design-requests/${second.id}/candidates/${second.candidates[0]!.id}/trial-candidate`,
      )
      .send({ code: 'TR-NEW', name: 'new' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    // the supersession is audited
    const rows = await env.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, second.id));
    expect(JSON.stringify(rows.map((x) => x.after))).toContain(first.id);
  });

  it('replacing twice is harmless and a request of another plant cannot be superseded', async () => {
    const a = await make();
    const b1 = await make({ supersedes: a.id });
    const b2 = await make({ supersedes: a.id });
    const m = await as('qc_manager');
    expect((await m.get(`/api/design-requests/${a.id}`)).body.supersededBy).toBe(b1.id);
    expect((await m.get(`/api/design-requests/${b2.id}`)).body.supersededBy).toBeNull();
    // a request made at plant B naming a plant A request leaves it untouched
    const c = await make();
    const other = await m
      .post('/api/design-requests')
      .send({ plantId: plantB, mode: 'ACI', requirements: REQUIREMENTS, supersedes: c.id });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    expect((await m.get(`/api/design-requests/${c.id}`)).body.supersededBy).toBeNull();
  });

  it('sensitivity re-prices the stored candidates, never re-solves, and rejects absurd changes', async () => {
    const r = await make();
    const m = await as('qc_manager');
    const res = await m.get(`/api/design-requests/${r.id}/sensitivity?changes=-0.2,0.2`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reSolved).toBe(false);
    expect(res.body.baseline.ranking.length).toBe(r.candidates.length);
    expect(res.body.scenarios.length).toBeGreaterThan(0);
    expect(res.body.note).toMatch(/nothing was re-solved/);
    expect((await m.get(`/api/design-requests/${r.id}/sensitivity?changes=-1`)).status).toBe(400);
    expect((await m.get(`/api/design-requests/${r.id}/sensitivity?changes=abc`)).status).toBe(400);
    // the stored candidates are unchanged by asking
    const again = (await m.get(`/api/design-requests/${r.id}`)).body;
    expect(again.candidates.map((c: { id: string }) => c.id)).toEqual(
      r.candidates.map((c) => c.id),
    );
  });
});
