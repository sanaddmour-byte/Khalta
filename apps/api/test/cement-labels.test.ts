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
    expect(by('White 52.5')).toMatchObject({ cementKind: 'white', cementClass: 52.5 });
    expect(by('Unlabelled cement')).toMatchObject({ cementKind: null, cementClass: null });
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
