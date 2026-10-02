import { schema } from '@khalta/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';
import { optimizerWorld, REQUIREMENTS } from './opt-world';

let env: TestEnv;
let plantA: string;
let plantB: string;
let mat: Record<string, string>;
beforeAll(async () => {
  env = await createTestEnv();
  const w = await optimizerWorld(env, ['PRF-A', 'PRF-B']);
  [plantA, plantB] = w.plants as [string, string];
  mat = w.mats[0]!;
}, 120_000);
afterAll(() => env.close());

const as = async (role: Parameters<TestEnv['seedUser']>[0], plantIds: string[] = []) =>
  env.login((await env.seedUser(role, { plantIds })).email);
const sand = (min: number, max: number) => ({ sand_ratio_pct: { mode: 'range', min, max } });
const create = (a: Awaited<ReturnType<typeof as>>, over: Record<string, unknown> = {}) =>
  a.post('/api/profiles').send({
    scope: 'tenant',
    nameEn: 'Base',
    nameAr: 'أساس',
    appliesTo: {},
    characteristics: {},
    ...over,
  });

describe('governance', () => {
  it('QC engineers draft, only a QC manager approves, never their own version', async () => {
    const eng = await as('qc_engineer', [plantA]);
    const mgr = await as('qc_manager');
    const made = await create(eng, { nameEn: 'C30 pump', characteristics: sand(38, 46) });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ version: 1, status: 'draft' });
    expect((await eng.post(`/api/profiles/${made.body.id}/versions/1/approve`)).status).toBe(403);
    // the author, even as a manager, cannot approve their own version
    const own = await create(mgr, { nameEn: 'Mgr own' });
    expect((await mgr.post(`/api/profiles/${own.body.id}/versions/1/approve`)).status).toBe(403);
    const ok = await mgr.post(`/api/profiles/${made.body.id}/versions/1/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
    expect((await mgr.post(`/api/profiles/${made.body.id}/versions/1/approve`)).status).toBe(409);
    const [row] = await env.db
      .select()
      .from(schema.characteristicProfileVersions)
      .where(eq(schema.characteristicProfileVersions.profileId, made.body.id));
    expect(row).toMatchObject({ status: 'approved' });
    expect(row!.approvedBy).not.toBe(row!.createdBy);
    const procurement = await as('procurement');
    expect((await create(procurement)).status).toBe(403);
  });

  it('versions are append-only: approved content cannot change, nothing is deleted', async () => {
    const eng = await as('qc_engineer');
    const mgr = await as('qc_manager');
    const made = await create(eng, { nameEn: 'Immut', characteristics: sand(38, 46) });
    await mgr.post(`/api/profiles/${made.body.id}/versions/1/approve`);
    await expect(
      env.db
        .update(schema.characteristicProfileVersions)
        .set({ characteristics: {} })
        .where(eq(schema.characteristicProfileVersions.profileId, made.body.id)),
    ).rejects.toThrow();
    await expect(
      env.db
        .delete(schema.characteristicProfileVersions)
        .where(eq(schema.characteristicProfileVersions.profileId, made.body.id)),
    ).rejects.toThrow();
    await expect(
      env.db
        .delete(schema.characteristicProfiles)
        .where(eq(schema.characteristicProfiles.id, made.body.id)),
    ).rejects.toThrow();
    // the database also refuses a self-approval
    const draft = await create(eng, { nameEn: 'Draft two' });
    const [d] = await env.db
      .select()
      .from(schema.characteristicProfileVersions)
      .where(eq(schema.characteristicProfileVersions.profileId, draft.body.id));
    await expect(
      env.db
        .update(schema.characteristicProfileVersions)
        .set({ status: 'approved', approvedBy: d!.createdBy, approvedAt: new Date() })
        .where(eq(schema.characteristicProfileVersions.id, d!.id)),
    ).rejects.toThrow();
  });

  it('editing creates the next DRAFT version; the approved one stays in force; diff shows the change', async () => {
    const eng = await as('qc_engineer');
    const mgr = await as('qc_manager');
    const made = await create(eng, { nameEn: 'Versioned', characteristics: sand(38, 46) });
    await mgr.post(`/api/profiles/${made.body.id}/versions/1/approve`);
    const v2 = await eng
      .post(`/api/profiles/${made.body.id}/versions`)
      .send({ appliesTo: {}, characteristics: sand(40, 44), changeNote: 'tighter' });
    expect(v2.body).toMatchObject({ version: 2, status: 'draft' });
    const got = await eng.get(`/api/profiles/${made.body.id}`);
    expect(
      got.body.versions.map((v: { version: number; status: string }) => `${v.version}:${v.status}`),
    ).toEqual(['2:draft', '1:approved']);
    const list = await eng.get('/api/profiles');
    const row = list.body.find((p: { id: string }) => p.id === made.body.id);
    expect(row.approved.version).toBe(1);
    expect(row.latest.version).toBe(2);
    const d = await eng.get(`/api/profiles/${made.body.id}/diff?from=1&to=2`);
    expect(d.body.rows[0]).toMatchObject({ key: 'chars.sand_ratio_pct', kind: 'changed' });
  });

  it('is checked against ACI and JS for every covered exposure; a loosening version cannot be approved', async () => {
    const eng = await as('qc_engineer');
    const mgr = await as('qc_manager');
    const made = await create(eng, {
      nameEn: 'Loose',
      appliesTo: { exposure: ['S1'] },
      characteristics: { wcm: { mode: 'fixed', value: 0.7 } },
    });
    expect(made.body.check.ok).toBe(false);
    expect(
      made.body.check.results.some(
        (r: { exposure: string; ok: boolean }) => r.exposure === 'S1' && !r.ok,
      ),
    ).toBe(true);
    const res = await mgr.post(`/api/profiles/${made.body.id}/versions/1/approve`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('profile_loosens_limits');
    const bad = await create(eng, { characteristics: { not_a_key: {} } });
    expect(bad.status).toBe(400);
  });
});

describe('matching and layering (F-021)', () => {
  it('the product-family value wins over plant and tenant, and its origin is shown', async () => {
    const eng = await as('qc_engineer', [plantA]);
    const mgr = await as('qc_manager');
    const mk = async (over: Record<string, unknown>) => {
      const r = await create(eng, over);
      expect((await mgr.post(`/api/profiles/${r.body.id}/versions/1/approve`)).status).toBe(200);
      return r.body.id as string;
    };
    const t = await mk({
      nameEn: 'L tenant',
      scope: 'tenant',
      appliesTo: { exposure: ['C0'] },
      characteristics: { ...sand(35, 50), paste_l: { mode: 'range', max: 420 } },
    });
    const p = await mk({
      nameEn: 'L plant',
      scope: 'plant',
      plantId: plantA,
      appliesTo: { exposure: ['C0'] },
      characteristics: sand(38, 46),
    });
    const f = await mk({
      nameEn: 'L family',
      scope: 'product_family',
      family: 'C30 pump',
      appliesTo: { fcMin: 25, fcMax: 35, pumpable: true, exposure: ['C0'] },
      characteristics: sand(40, 44),
    });
    const m = await eng
      .post('/api/profiles/match')
      .send({ plantId: plantA, fcMpa: 30, exposure: ['F0', 'C0'], pumpable: true, mode: 'ACI' });
    expect(m.status).toBe(200);
    expect(m.body.chosen.map((c: { profileId: string }) => c.profileId)).toEqual(
      expect.arrayContaining([t, p, f]),
    );
    const sandRow = m.body.characteristics.find((c: { key: string }) => c.key === 'sand_ratio_pct');
    expect(sandRow.spec).toMatchObject({ min: 40, max: 44 });
    expect(sandRow.origin).toBe(`profile:${f}@1`);
    expect(m.body.characteristics.find((c: { key: string }) => c.key === 'paste_l').origin).toBe(
      `profile:${t}@1`,
    );
    // not pumpable → the family profile does not match; the plant value applies
    const np = await eng
      .post('/api/profiles/match')
      .send({ plantId: plantA, fcMpa: 30, exposure: ['F0', 'C0'], pumpable: false, mode: 'ACI' });
    expect(
      np.body.characteristics.find((c: { key: string }) => c.key === 'sand_ratio_pct').origin,
    ).toBe(`profile:${p}@1`);
    // at the other plant the plant profile does not apply
    const other = await mgr
      .post('/api/profiles/match')
      .send({ plantId: plantB, fcMpa: 30, exposure: ['F0', 'C0'], pumpable: false, mode: 'ACI' });
    expect(other.body.chosen.map((c: { scope: string }) => c.scope)).not.toContain('plant');
    // a plant profile is invisible to a user of another plant
    const away = await as('qc_engineer', [plantB]);
    expect((await away.get(`/api/profiles/${p}`)).status).toBe(404);
  });

  it('equally narrow profiles of one scope are a tie: reported, none applied', async () => {
    const eng = await as('qc_engineer', [plantA]);
    const mgr = await as('qc_manager');
    const ids: string[] = [];
    for (const name of ['Tie A', 'Tie B']) {
      const r = await create(eng, {
        nameEn: name,
        scope: 'product_family',
        appliesTo: { exposure: ['W2'] },
        characteristics: sand(36, 48),
      });
      await mgr.post(`/api/profiles/${r.body.id}/versions/1/approve`);
      ids.push(r.body.id);
    }
    const m = await eng
      .post('/api/profiles/match')
      .send({ plantId: plantA, fcMpa: 28, exposure: ['W2'], mode: 'ACI' });
    const tie = m.body.ties.find((t: { scope: string }) => t.scope === 'product_family');
    expect(tie).toBeDefined();
    expect(tie.candidates.map((c: { profileId: string }) => c.profileId).sort()).toEqual(
      [...ids].sort(),
    );
    expect(
      m.body.chosen.filter((c: { scope: string }) => c.scope === 'product_family'),
    ).toHaveLength(0);
    const picked = await eng
      .post('/api/profiles/match')
      .send({ plantId: plantA, fcMpa: 28, exposure: ['W2'], mode: 'ACI', profileIds: [ids[0]] });
    expect(picked.body.chosen).toHaveLength(1);
  });
});

describe('use in a request', () => {
  it('a draft profile can be previewed and evaluated but not used for trial generation; approved ones are snapshotted', async () => {
    const eng = await as('qc_engineer', [plantA]);
    const mgr = await as('qc_manager');
    const made = await create(eng, { nameEn: 'Gen', characteristics: sand(36, 56) });
    const pre = await eng.post('/api/design-requests/preflight').send({
      plantId: plantA,
      mode: 'ACI',
      requirements: REQUIREMENTS,
      profileIds: [made.body.id],
    });
    expect(pre.status).toBe(200);
    expect(pre.body.profiles[0]).toMatchObject({ version: 1, status: 'draft' });
    expect(Object.values(pre.body.origins)).toContain(`profile:${made.body.id}@1`);
    const blocked = await eng.post('/api/design-requests').send({
      plantId: plantA,
      mode: 'ACI',
      requirements: REQUIREMENTS,
      profileIds: [made.body.id],
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('profile_draft');
    await mgr.post(`/api/profiles/${made.body.id}/versions/1/approve`);
    const ok = await eng.post('/api/design-requests').send({
      plantId: plantA,
      mode: 'ACI',
      requirements: REQUIREMENTS,
      profileIds: [made.body.id],
    });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('candidates');
    const [req] = await env.db
      .select()
      .from(schema.designRequests)
      .where(eq(schema.designRequests.id, ok.body.id));
    expect(req!.profileVersions).toEqual([
      { profileId: made.body.id, version: 1, status: 'approved' },
    ]);
    expect(Object.values(req!.profileOrigins as object)).toContain(`profile:${made.body.id}@1`);
    for (const c of ok.body.candidates) {
      const row = c.characteristics.find((r: { key: string }) => r.key === 'sand_ratio_pct');
      expect(row.status).toBe('met');
      expect(row.origin).toBe(`profile:${made.body.id}@1`);
    }
    // design from a candidate snapshots the profile version; a new version changes nothing that exists
    const t = await eng
      .post(
        `/api/design-requests/${ok.body.id}/candidates/${ok.body.candidates[0].id}/trial-candidate`,
      )
      .send({ code: 'PRF-D1', name: 'From profile' });
    expect(t.status).toBe(201);
    const v2 = await eng
      .post(`/api/profiles/${made.body.id}/versions`)
      .send({ appliesTo: {}, characteristics: sand(40, 44) });
    await mgr.post(`/api/profiles/${made.body.id}/versions/${v2.body.version}/approve`);
    const [d] = await env.db
      .select()
      .from(schema.mixDesigns)
      .where(eq(schema.mixDesigns.id, t.body.design.id));
    expect((d!.inputsSnapshot as { profiles: unknown }).profiles).toEqual([
      { profileId: made.body.id, version: 1, status: 'approved' },
    ]);
    const usage = await eng.get(`/api/profiles/${made.body.id}/usage`);
    expect(usage.body.requests).toBe(1);
    expect(usage.body.olderDesigns.map((x: { code: string }) => x.code)).toEqual(['PRF-D1']);
  });

  it('a profile cannot loosen a code limit in a request, and a request value overrides a profile value', async () => {
    const eng = await as('qc_engineer', [plantA]);
    const loose = await create(eng, {
      nameEn: 'Loose gen',
      characteristics: { wcm: { mode: 'fixed', value: 0.7 } },
    });
    const res = await eng.post('/api/design-requests/preflight').send({
      plantId: plantA,
      mode: 'ACI',
      requirements: { ...REQUIREMENTS, exposure: ['F0', 'S1', 'W0', 'C1'] },
      profileIds: [loose.body.id],
    });
    expect(res.body.characteristics.ok).toBe(false);
    const prof = await create(eng, { nameEn: 'Over', characteristics: sand(36, 40) });
    const over = await eng.post('/api/design-requests/preflight').send({
      plantId: plantA,
      mode: 'ACI',
      requirements: REQUIREMENTS,
      profileIds: [prof.body.id],
      characteristics: sand(44, 52),
    });
    expect(over.body.origins['sand_ratio_pct']).toBe('request');
    const two = await eng.post('/api/design-requests/preflight').send({
      plantId: plantA,
      requirements: REQUIREMENTS,
      profileIds: [prof.body.id, loose.body.id],
    });
    expect(two.status).toBe(400);
    const mine = await create(await as('qc_manager'), {
      nameEn: 'Plant only',
      scope: 'plant',
      plantId: plantA,
    });
    const wrong = await (
      await as('qc_manager')
    )
      .post('/api/design-requests/preflight')
      .send({ plantId: plantB, requirements: REQUIREMENTS, profileIds: [mine.body.id] });
    expect(wrong.status).toBe(409);
  });

  it('material preferences merge into the request: excluded materials stay out', async () => {
    const eng = await as('qc_engineer', [plantA]);
    const mgr = await as('qc_manager');
    const r = await create(eng, { nameEn: 'NoFly', materials: { exclude: [mat['fly']!] } });
    await mgr.post(`/api/profiles/${r.body.id}/versions/1/approve`);
    const res = await eng
      .post('/api/design-requests')
      .send({ plantId: plantA, mode: 'ACI', requirements: REQUIREMENTS, profileIds: [r.body.id] });
    expect(res.status).toBe(201);
    for (const c of res.body.candidates)
      expect(c.lines.map((l: { materialId: string }) => l.materialId)).not.toContain(mat['fly']);
  });
});
