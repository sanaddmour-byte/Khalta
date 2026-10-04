import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withColour } from '../src/optimizer/service';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
let mgr: Awaited<ReturnType<TestEnv['login']>>;

beforeAll(async () => {
  env = await createTestEnv({}, { seedRules: true });
  mgr = await env.login((await env.seedUser('qc_manager')).email);
});
afterAll(() => env.close());

const cement = (id: string, props: Record<string, unknown> | null) => ({
  id,
  category: 'cement',
  test: props ? { properties: props } : null,
});
const POOL = [
  cement('opc', { cement_kind: 'opc', cement_strength_class: 42.5 }),
  cement('wht', { cement_kind: 'white', cement_strength_class: 52.5 }),
  cement('old', null),
  { id: 'sand', category: 'fine_agg', test: null },
];

describe('cement colour option', () => {
  it('any changes nothing; grey excludes white only; white excludes everything not recorded white', () => {
    expect(withColour(undefined, POOL, 'any')).toBeUndefined();
    expect(withColour(undefined, POOL, 'grey')?.exclude).toEqual(['wht']);
    expect(withColour(undefined, POOL, 'white')?.exclude?.sort()).toEqual(['old', 'opc']);
  });

  it('keeps the request own exclusions and never touches non-cement materials', () => {
    const r = withColour({ exclude: ['sand'] }, POOL, 'white');
    expect(r?.exclude).toEqual(expect.arrayContaining(['sand', 'opc', 'old']));
    expect(r?.exclude).not.toContain('wht');
  });
});

describe('materials list carries the cement label', () => {
  it('shows kind and class for cements from the current test, and nothing for other categories', async () => {
    const mk = async (category: string, name: string, properties: Record<string, unknown>) => {
      const m = (await mgr.post('/api/materials').send({ category, marketNameEn: name })).body as {
        id: string;
      };
      const r = await mgr.post(`/api/materials/${m.id}/tests`).send({
        properties,
        source: 'user_declared',
        declaredReason: 'test',
        testedAt: '2026-09-01',
      });
      expect(r.status).toBe(201);
    };
    await mk('cement', 'White 52.5', {
      cement_kind: 'white',
      cement_strength_class: 52.5,
      sg: 3.1,
    });
    await mk('cement', 'Unlabelled cement', { sg: 3.15 });
    await mk('fine_agg', 'Label sand', { sg_ssd: 2.6, absorption_pct: 1.2 });
    const rows = (await mgr.get('/api/materials')).body as Record<string, unknown>[];
    const by = (n: string) => rows.find((r) => r['marketNameEn'] === n)!;
    // the legacy type "white" reads as a colour with the type unstated, and is marked for re-recording
    expect(by('White 52.5')).toMatchObject({
      cementKind: null,
      cementClass: 52.5,
      cementColour: 'white',
      cementLegacyWhite: true,
    });
    expect(by('Unlabelled cement')).toMatchObject({
      cementKind: null,
      cementClass: null,
      cementColour: null,
    });
    expect(by('Label sand')).not.toHaveProperty('cementKind');
  });

  it('rejects a strength class outside 32.5 / 42.5 / 52.5', async () => {
    const m = (
      await mgr.post('/api/materials').send({ category: 'cement', marketNameEn: 'Bad class' })
    ).body as { id: string };
    const r = await mgr.post(`/api/materials/${m.id}/tests`).send({
      properties: { cement_strength_class: 40, sg: 3.15 },
      source: 'user_declared',
      declaredReason: 'test',
      testedAt: '2026-09-01',
    });
    expect(r.status).toBe(400);
  });
});

describe('the reviewed reclassification (type, class and colour are separate)', () => {
  const material = async (name: string, properties: Record<string, unknown>) => {
    const m = (await mgr.post('/api/materials').send({ category: 'cement', marketNameEn: name }))
      .body as {
      id: string;
    };
    expect(
      (
        await mgr.post(`/api/materials/${m.id}/tests`).send({
          properties,
          source: 'user_declared',
          declaredReason: 'test',
          testedAt: '2026-09-01',
        })
      ).status,
    ).toBe(201);
    return m.id;
  };
  const review = async () =>
    (await mgr.get('/api/materials/cement-label-review')).body as {
      materialId: string;
      issues: string[];
      suggestion: { kind: string | null; colour: string | null };
      current: { kind: string | null; colour: string | null };
    }[];

  it('lists legacy and incomplete records with suggestions, applies nothing, and a person re-records them', async () => {
    const legacy = await material('White OPC 52.5 review', {
      cement_kind: 'white',
      cement_strength_class: 52.5,
      sg: 3.1,
    });
    const bare = await material('Plain cement review', { sg: 3.15 });
    const done = await material('Done cement review', {
      cement_kind: 'opc',
      cement_colour: 'grey',
      sg: 3.15,
    });
    const q = await review();
    const l = q.find((x) => x.materialId === legacy)!;
    expect(l.issues).toEqual(['legacy_white', 'type_missing']);
    expect(l.suggestion).toMatchObject({ kind: 'opc', colour: 'white' }); // from the name, not applied
    expect(l.current).toMatchObject({ kind: null, colour: 'white' });
    expect(q.find((x) => x.materialId === bare)!.issues).toEqual([
      'type_missing',
      'colour_missing',
    ]);
    expect(q.find((x) => x.materialId === done)).toBeUndefined();
    // nothing changed by listing: the current record is still the legacy one
    expect((await review()).find((x) => x.materialId === legacy)).toBeTruthy();
    // a person records type, class and colour: it leaves the queue (and the old version is kept)
    const re = await mgr.post(`/api/materials/${legacy}/tests`).send({
      properties: {
        cement_kind: 'opc',
        cement_colour: 'white',
        cement_strength_class: 52.5,
        sg: 3.1,
      },
      source: 'user_declared',
      declaredReason: 'type confirmed from the mill certificate',
      testedAt: '2026-09-02',
    });
    expect(re.status, JSON.stringify(re.body)).toBe(201);
    expect((await review()).find((x) => x.materialId === legacy)).toBeUndefined();
    const hist = (await mgr.get(`/api/materials/${legacy}/tests`)).body as unknown[];
    expect(JSON.stringify(hist)).toContain('"white"');
    // the cement colour is a separate filterable value now
    const row = ((await mgr.get('/api/materials')).body as Record<string, unknown>[]).find(
      (r) => r['id'] === legacy,
    )!;
    expect(row).toMatchObject({
      cementKind: 'opc',
      cementColour: 'white',
      cementLegacyWhite: false,
    });
  });
});
