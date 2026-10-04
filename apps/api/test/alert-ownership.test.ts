import { schema } from '@khalta/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { escalateOverdue } from '../src/insights/service';
import { createTestEnv, type TestEnv } from './helpers';
import { optimizerWorld } from './opt-world';

let env: TestEnv;
let plantA: string;
let plantB: string;

beforeAll(async () => {
  env = await createTestEnv();
  [plantA, plantB] = (await optimizerWorld(env, ['AO-A', 'AO-B'])).plants as [string, string];
}, 120_000);
afterAll(async () => env.close());

const as = async (role: Parameters<TestEnv['seedUser']>[0], plantIds: string[] = []) =>
  env.login((await env.seedUser(role, { plantIds })).email);
const setSettings = (settings: Record<string, unknown>) =>
  env.db
    .insert(schema.tenantSettings)
    .values({ tenantId: env.tenantId, settings })
    .onConflictDoUpdate({ target: schema.tenantSettings.tenantId, set: { settings } });
let n = 0;
const alert = async (severity: 'critical' | 'high' | 'info' = 'critical') => {
  const [r] = await env.db
    .insert(schema.insights)
    .values({
      tenantId: env.tenantId,
      type: 'low_strength',
      severity,
      plantId: plantA,
      dedupeKey: `ao-${n++}`,
      payload: { note: 'SYNTHETIC' },
    })
    .returning();
  return r!.id;
};
const view = async (id: string) =>
  (
    (await (await as('qc_manager')).get('/api/insights')).body as {
      id: string;
      ownership: { state: string; dueAt: string | null; ownerId: string };
    }[]
  ).find((i) => i.id === id)!;

describe('alert ownership, acknowledgement and escalation', () => {
  it('an unassigned alert says so; assigning needs the QC manager and a real owner', async () => {
    const id = await alert();
    expect((await view(id)).ownership.state).toBe('unassigned');
    const owner = await env.seedUser('plant_manager', { plantIds: [plantA] });
    const eng = await as('qc_engineer', [plantA]);
    expect((await eng.post(`/api/insights/${id}/assign`).send({ ownerId: owner.id })).status).toBe(
      403,
    );
    const m = await as('qc_manager');
    expect((await m.post(`/api/insights/${id}/assign`).send({ ownerId: 'nobody' })).status).toBe(
      400,
    );
    const ok = await m.post(`/api/insights/${id}/assign`).send({ ownerId: owner.id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // no deadline is configured, so none is set and nothing can escalate by itself
    expect(ok.body.dueAt).toBeNull();
    expect((await view(id)).ownership).toMatchObject({
      state: 'assigned',
      ownerId: owner.id,
      dueAt: null,
    });
    expect(
      (await escalateOverdue(env.db, env.tenantId, new Date(Date.now() + 90 * 86_400_000)))
        .escalated,
    ).toBe(0);
  });

  it('with a deadline set, an unacknowledged alert escalates once after it passes; acknowledging stops it', async () => {
    await setSettings({ alertAckHoursCritical: 2 });
    const owner = await env.seedUser('plant_manager', { plantIds: [plantA] });
    const m = await as('qc_manager');
    const late = await alert();
    const acked = await alert();
    for (const id of [late, acked]) {
      const a = await m.post(`/api/insights/${id}/assign`).send({ ownerId: owner.id });
      expect(a.body.dueAt).toBeTruthy();
    }
    const ownerClient = await env.login(owner.email);
    // another plant's manager cannot acknowledge it
    const stranger = await as('plant_manager', [plantB]);
    expect(
      (await stranger.post(`/api/insights/${acked}/acknowledge`).send({})).status,
    ).toBeGreaterThanOrEqual(403);
    expect(
      (await ownerClient.post(`/api/insights/${acked}/acknowledge`).send({ note: 'on it' })).status,
    ).toBe(200);
    expect((await ownerClient.post(`/api/insights/${acked}/acknowledge`).send({})).status).toBe(
      409,
    );
    const before = new Date();
    expect((await escalateOverdue(env.db, env.tenantId, before)).escalated).toBe(0); // not yet due
    const later = new Date(Date.now() + 3 * 3_600_000);
    expect((await escalateOverdue(env.db, env.tenantId, later)).escalated).toBe(1);
    expect((await escalateOverdue(env.db, env.tenantId, later)).escalated).toBe(0); // once per assignment
    const events = await env.db
      .select()
      .from(schema.insightEvents)
      .where(eq(schema.insightEvents.insightId, late));
    expect(events.filter((e) => e.kind === 'escalated')).toHaveLength(1);
    expect((await view(late)).ownership.state).toBe('escalated');
    expect((await view(acked)).ownership.state).toBe('acknowledged');
    // reassigning restarts the clock and answers the escalation
    expect((await m.post(`/api/insights/${late}/assign`).send({ ownerId: owner.id })).status).toBe(
      200,
    );
    expect((await view(late)).ownership.state).toBe('assigned');
    // the alert itself is untouched: still open, no design changed
    expect(
      (await env.db.select().from(schema.insights).where(eq(schema.insights.id, late)))[0]!.status,
    ).toBe('open');
  });

  it('only a QC manager or the engineering authority may set the deadline', async () => {
    const admin = await as('admin');
    expect((await admin.patch('/api/settings').send({ alertAckHoursHigh: 4 })).status).toBe(403);
    const m = await as('qc_manager');
    expect((await m.patch('/api/settings').send({ alertAckHoursHigh: 4 })).status).toBe(200);
    expect((await m.patch('/api/settings').send({ alertAckHoursHigh: 0 })).status).toBe(400);
  });
});
