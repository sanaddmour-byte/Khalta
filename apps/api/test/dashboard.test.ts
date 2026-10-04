import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';
import { optimizerWorld, REQUIREMENTS } from './opt-world';

let env: TestEnv;
let plantA: string;
let plantB: string;

beforeAll(async () => {
  env = await createTestEnv();
  [plantA, plantB] = (await optimizerWorld(env, ['DB-A', 'DB-B'])).plants as [string, string];
  const m = await env.login((await env.seedUser('qc_manager')).email);
  const made = await m
    .post('/api/design-requests')
    .send({ plantId: plantA, mode: 'ACI', requirements: REQUIREMENTS });
  const eng = await env.login((await env.seedUser('qc_engineer', { plantIds: [plantA] })).email);
  await eng
    .post(
      `/api/design-requests/${made.body.id}/candidates/${made.body.candidates[0].id}/trial-candidate`,
    )
    .send({ code: 'DB-1', name: 'DB-1' });
}, 120_000);
afterAll(async () => env.close());

const dash = async (role: Parameters<TestEnv['seedUser']>[0], plantIds: string[] = []) =>
  (await (await env.login((await env.seedUser(role, { plantIds })).email)).get('/api/dashboard'))
    .body as {
    role: string;
    cards: { id: string; count: number; to: string }[];
    worklists: unknown;
  };
const ids = (d: { cards: { id: string }[] }) => d.cards.map((c) => c.id);
const count = (d: { cards: { id: string; count: number }[] }, id: string) =>
  d.cards.find((c) => c.id === id)?.count;

describe('role dashboards', () => {
  it('each role gets the cards its work needs and none it cannot act on', async () => {
    const qm = await dash('qc_manager');
    expect(ids(qm)).toEqual(
      expect.arrayContaining(['awaitingApproval', 'criticalAlerts', 'changeImpacts']),
    );
    const eng = await dash('qc_engineer', [plantA]);
    expect(ids(eng)).toEqual(expect.arrayContaining(['draftDesigns', 'inTrial']));
    expect(ids(eng)).not.toContain('awaitingApproval');
    expect(count(eng, 'inTrial')).toBe(1);
    const proc = await dash('procurement');
    expect(ids(proc)).toContain('priceAlerts');
    expect(ids(proc)).not.toContain('awaitingApproval');
    const sales = await dash('sales', [plantA]);
    expect(ids(sales)).toEqual(['approvedDesigns']);
    const admin = await dash('admin');
    expect(ids(admin)).toEqual(expect.arrayContaining(['failedJobs', 'users']));
    expect(ids(admin)).not.toContain('awaitingApproval'); // admin holds no sign-offs (ADR 0019)
  });

  it('counts are scoped to the caller’s plants', async () => {
    expect(count(await dash('qc_engineer', [plantA]), 'inTrial')).toBe(1);
    expect(count(await dash('qc_engineer', [plantB]), 'inTrial')).toBe(0);
    expect(count(await dash('qc_manager'), 'inTrial') ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('carries no cost figure for anyone', async () => {
    for (const r of ['qc_manager', 'procurement', 'sales', 'admin'] as const)
      expect(JSON.stringify(await dash(r))).not.toMatch(/jod|costJod|saving/i);
  });
});
