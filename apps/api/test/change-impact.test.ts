import { schema } from '@khalta/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assessChange } from '../src/impact/service';
import { createTestEnv, type TestEnv } from './helpers';
import { optimizerWorld, REQUIREMENTS } from './opt-world';

// SYNTHETIC world. The designs are put in production directly: the lifecycle itself is tested elsewhere.
let env: TestEnv;
let plantA: string;
let plantB: string;
let designA: string;

beforeAll(async () => {
  env = await createTestEnv();
  [plantA, plantB] = (await optimizerWorld(env, ['CI-A', 'CI-B'])).plants as [string, string];
  const m = await env.login((await env.seedUser('qc_manager')).email);
  const made = await m
    .post('/api/design-requests')
    .send({ plantId: plantA, mode: 'ACI', requirements: REQUIREMENTS });
  const eng = await env.login((await env.seedUser('qc_engineer', { plantIds: [plantA] })).email);
  const t = await eng
    .post(
      `/api/design-requests/${made.body.id}/candidates/${made.body.candidates[0].id}/trial-candidate`,
    )
    .send({ code: 'CI-1', name: 'CI-1' });
  designA = t.body.design.id;
  // the status guard only lets the lifecycle move a design; the setup lifts it for one statement
  await env.db.execute(sql`ALTER TABLE mix_designs DISABLE TRIGGER mix_designs_status_guard`);
  try {
    await env.db
      .update(schema.mixDesigns)
      .set({
        status: 'approved',
        approvalSource: 'khalta',
        approvedBy: (await env.seedUser('qc_manager')).id,
        approvedAt: new Date(),
      })
      .where(eq(schema.mixDesigns.id, designA));
  } finally {
    await env.db.execute(sql`ALTER TABLE mix_designs ENABLE TRIGGER mix_designs_status_guard`);
  }
}, 120_000);
afterAll(async () => env.close());

const impacts = () =>
  env.db.select().from(schema.changeImpacts).where(eq(schema.changeImpacts.tenantId, env.tenantId));
const items = () => env.db.select().from(schema.changeImpactItems);

describe('change-impact assessment', () => {
  it('a price change touches the live design and needs no action; the design itself is untouched', async () => {
    const before = (
      await env.db.select().from(schema.mixDesigns).where(eq(schema.mixDesigns.id, designA))
    )[0]!;
    const r = await assessChange(env.db, env.tenantId, {
      trigger: 'price_change',
      subject: 'all',
      token: 't1',
    });
    expect(r.state).toBe('completed');
    const [imp] = (await impacts()).filter((i) => i.trigger === 'price_change');
    expect(imp).toMatchObject({ jobState: 'completed', attempts: 1 });
    const it_ = (await items()).find((x) => x.impactId === imp!.id)!;
    expect(it_).toMatchObject({ designId: designA, klass: 'no_action' });
    expect(it_.designVersion).toBe(before.version);
    const after = (
      await env.db.select().from(schema.mixDesigns).where(eq(schema.mixDesigns.id, designA))
    )[0]!;
    expect(after.status).toBe(before.status);
    expect(after.version).toBe(before.version);
  });

  it('the same change is assessed once: a repeat is skipped and nothing is duplicated', async () => {
    const c = { trigger: 'price_change' as const, subject: 'all', token: 't1' };
    expect((await assessChange(env.db, env.tenantId, c)).state).toBe('skipped');
    expect((await impacts()).filter((i) => i.trigger === 'price_change')).toHaveLength(1);
    // a different version of the change is a different assessment
    expect((await assessChange(env.db, env.tenantId, { ...c, token: 't2' })).state).toBe(
      'completed',
    );
    expect((await impacts()).filter((i) => i.trigger === 'price_change')).toHaveLength(2);
  });

  it('a failure is recorded and rethrown; the retry reuses the row and completes it', async () => {
    const c = {
      trigger: 'material_change' as const,
      subject: '00000000-0000-4000-8000-000000000000',
      token: 'v1',
    };
    // sabotage the next insert of an item, once
    await env.db.execute(
      sql`CREATE OR REPLACE FUNCTION ci_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql`,
    );
    // a material no design uses has no items, so use a real one: any material of design A
    const [line] = await env.db
      .select()
      .from(schema.mixDesignLines)
      .where(eq(schema.mixDesignLines.designId, designA));
    const real = { ...c, subject: line!.materialId };
    await env.db.execute(
      sql`CREATE TRIGGER ci_fail_trg BEFORE INSERT ON change_impact_items FOR EACH ROW EXECUTE FUNCTION ci_fail()`,
    );
    await expect(assessChange(env.db, env.tenantId, real)).rejects.toThrow();
    const failed = (await impacts()).find((i) => i.dedupeKey.startsWith('material_change'))!;
    expect(failed).toMatchObject({ jobState: 'failed', attempts: 1 });
    expect(failed.lastError).toMatch(/boom/);
    await env.db.execute(sql`DROP TRIGGER ci_fail_trg ON change_impact_items`);
    const ok = await assessChange(env.db, env.tenantId, real);
    expect(ok.state).toBe('completed');
    const done = (await impacts()).filter((i) => i.dedupeKey.startsWith('material_change'));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ jobState: 'completed', attempts: 2, lastError: null });
    expect((await items()).filter((x) => x.impactId === done[0]!.id)).toHaveLength(1);
  });

  it('a strength set below f′cr recommends suspension and nothing is suspended', async () => {
    await env.db.insert(schema.strengthResults).values(
      [0, 1].map(() => ({
        tenantId: env.tenantId,
        plantId: plantA,
        designId: designA,
        castDate: '2026-10-01',
        ageDays: 28,
        specimenType: 'cylinder' as const,
        setId: 'LOW',
        resultMpa: '5.00',
      })),
    );
    const r = await assessChange(env.db, env.tenantId, {
      trigger: 'strength_deterioration',
      subject: designA,
      token: 'x1',
    });
    expect(r.state).toBe('completed');
    const imp = (await impacts()).find((i) => i.trigger === 'strength_deterioration')!;
    const item = (await items()).find((x) => x.impactId === imp.id)!;
    expect(item.klass).toBe('suspend_recommended');
    expect(item.reasons).toEqual(['strength_below_fcr']);
    expect(
      (await env.db.select().from(schema.mixDesigns).where(eq(schema.mixDesigns.id, designA)))[0]!
        .status,
    ).toBe('approved');
  });
});

describe('change-impact list and dispositions', () => {
  it('lists the job state and items within the caller’s plants only', async () => {
    const m = await env.login((await env.seedUser('qc_manager')).email);
    const all = (await m.get('/api/change-impacts')).body as {
      jobState: string;
      items: unknown[];
    }[];
    expect(all.length).toBeGreaterThan(0);
    expect(all.some((i) => i.jobState === 'completed')).toBe(true);
    const other = await env.login(
      (await env.seedUser('plant_manager', { plantIds: [plantB] })).email,
    );
    const theirs = (await other.get('/api/change-impacts')).body as { items: unknown[] }[];
    expect(theirs.flatMap((i) => i.items)).toHaveLength(0);
    const open = (await m.get('/api/change-impacts?open=true')).body as {
      items: { class: string }[];
    }[];
    expect(open.flatMap((i) => i.items).every((x) => x.class !== 'no_action')).toBe(true);
  });

  it('a disposition needs the QC manager and a reason, fits the class, and is final', async () => {
    const [susp] = await env.db
      .select()
      .from(schema.changeImpactItems)
      .where(eq(schema.changeImpactItems.klass, 'suspend_recommended'));
    const url = `/api/change-impacts/items/${susp!.id}/disposition`;
    const eng = await env.login((await env.seedUser('qc_engineer', { plantIds: [plantA] })).email);
    expect(
      (await eng.post(url).send({ disposition: 'accepted_risk', reason: 'a long enough reason' }))
        .status,
    ).toBe(403);
    const admin = await env.login((await env.seedUser('admin')).email);
    expect(
      (await admin.post(url).send({ disposition: 'accepted_risk', reason: 'a long enough reason' }))
        .status,
    ).toBe(403);
    const m = await env.login((await env.seedUser('qc_manager')).email);
    expect((await m.post(url).send({ disposition: 'accepted_risk', reason: 'short' })).status).toBe(
      400,
    );
    const waved = await m
      .post(url)
      .send({ disposition: 'dismissed', reason: 'not a real concern here' });
    expect(waved.status).toBe(409);
    expect(waved.body.error.code).toBe('disposition_not_allowed');
    const ok = await m.post(url).send({
      disposition: 'requalification_required',
      reason: 'a retest is arranged for next week',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(
      (await m.post(url).send({ disposition: 'accepted_risk', reason: 'changed my mind about it' }))
        .status,
    ).toBe(409);
    const [after] = await env.db
      .select()
      .from(schema.changeImpactItems)
      .where(eq(schema.changeImpactItems.id, susp!.id));
    expect(after).toMatchObject({ disposition: 'requalification_required' });
    expect(after!.dispositionBy).toBeTruthy();
    // the database refuses to alter a decided item
    await expect(
      env.db
        .update(schema.changeImpactItems)
        .set({ dispositionNote: 'rewritten after the fact' })
        .where(eq(schema.changeImpactItems.id, susp!.id)),
    ).rejects.toThrow();
    const audits = await env.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'change_impact.disposition'),
          eq(schema.auditLog.entityId, susp!.id),
        ),
      );
    expect(audits).toHaveLength(1);
  });
});
