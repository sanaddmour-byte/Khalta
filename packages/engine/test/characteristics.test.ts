import { describe, expect, it } from 'vitest';
import { resolve } from '@khalta/rules';
import {
  achievedRows,
  characteristicsInputSchema,
  checkCharacteristics,
  describeSpec,
  mergeLayers,
  normalizeUnits,
  rejectLoosening,
  type Layer,
  type ResolvedCharacteristic,
} from '../src/characteristics';
import { evaluate, evaluationContext } from '../src/evaluate';
import { ALL_RULES, MATERIALS, makeSnapshot } from '../src/testing/synthetic';
import type { EvaluationSnapshot, SnapshotMaterial } from '../src/evaluate';

const layer = (level: Layer['level'], origin: string, characteristics: unknown): Layer => ({
  level,
  origin,
  characteristics,
});
const merged = (layers: Layer[]) => {
  const r = mergeLayers(layers);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.characteristics;
};

describe('schema (Appendix E)', () => {
  it('accepts the documented example', () => {
    const r = characteristicsInputSchema.safeParse({
      objective: 'cheapest',
      characteristics: {
        wcm: { mode: 'range', max: 0.45 },
        cement_kg: { mode: 'range', min: 330, max: 380 },
        scm: { mode: 'fixed', product: 'np-pozzolan-01', pct: 15 },
        water_kg: { mode: 'auto' },
        admixture: { mode: 'fixed', product: 'sp-typeF-01', dosage_level: 2 },
        sand_ratio_pct: { mode: 'target', value: 44, basis: 'mass', weight_jod_per_unit: 0.05 },
        agg_share_pct: { 'simsimiyyeh-amm-01': { mode: 'range', min: 10, max: 20 } },
        slump_mm: { mode: 'fixed', value: 150 },
        extra_margin_mpa: { mode: 'fixed', value: 2 },
        max_cost_jod_m3: { mode: 'range', max: 32 },
      },
      materials: { include: ['a'], exclude: ['b'], prefer: ['c'] },
      origin: { profiles: ['c30-pump-aqaba@3'], request_overrides: ['cement_kg'] },
    });
    expect(r.success).toBe(true);
  });
  it.each([
    ['unknown key', { turbo: { mode: 'fixed', value: 1 } }],
    ['a mode the key does not support', { wcm: { mode: 'target', value: 0.4 } }],
    ['a range with no bound', { wcm: { mode: 'range' } }],
    ['min above max', { cement_kg: { mode: 'range', min: 400, max: 300 } }],
    ['negative extra margin', { extra_margin_mpa: { mode: 'fixed', value: -1 } }],
    ['scm percent above 100', { scm: { mode: 'fixed', product: 'x', pct: 120 } }],
    ['extra field', { wcm: { mode: 'fixed', value: 0.4, note: 'x' } }],
    ['non-finite number', { wcm: { mode: 'fixed', value: Number.POSITIVE_INFINITY } }],
  ])('rejects %s', (_n, c) => {
    expect(characteristicsInputSchema.safeParse({ characteristics: c }).success).toBe(false);
  });
});

describe('layer merge', () => {
  it('more specific layer replaces the same key; others stay; origin is recorded', () => {
    const out = merged([
      layer('request', 'request', { wcm: { mode: 'fixed', value: 0.42 } }),
      layer('tenant', 'tenant-default@1', {
        wcm: { mode: 'range', max: 0.5 },
        binder_kg: { mode: 'range', min: 300 },
      }),
      layer('plant', 'aqaba@2', {
        binder_kg: { mode: 'range', min: 320 },
        water_kg: { mode: 'range', max: 180 },
      }),
      layer('product_family', 'c30-pump@3', { water_kg: { mode: 'range', max: 175 } }),
    ]);
    const by = Object.fromEntries(out.map((c) => [c.key, c]));
    expect(by['wcm']).toMatchObject({ spec: { mode: 'fixed', value: 0.42 }, origin: 'request' });
    expect(by['binder_kg']).toMatchObject({ spec: { min: 320 }, origin: 'aqaba@2' });
    expect(by['water_kg']).toMatchObject({ spec: { max: 175 }, origin: 'c30-pump@3' });
  });
  it('keyed characteristics merge per sub-key', () => {
    const out = merged([
      layer('plant', 'plant', {
        agg_share_pct: { a: { mode: 'range', min: 10 }, b: { mode: 'range', max: 30 } },
      }),
      layer('request', 'request', { agg_share_pct: { a: { mode: 'fixed', value: 15 } } }),
    ]);
    expect(out.map((c) => [c.key, c.sub, c.origin])).toEqual([
      ['agg_share_pct', 'a', 'request'],
      ['agg_share_pct', 'b', 'plant'],
    ]);
  });
  it('is deterministic, idempotent and independent of the order layers are given in', () => {
    const a = layer('tenant', 't', { wcm: { mode: 'range', max: 0.5 } });
    const b = layer('request', 'r', {
      wcm: { mode: 'range', max: 0.4 },
      binder_kg: { mode: 'fixed', value: 350 },
    });
    expect(merged([a, b])).toEqual(merged([b, a]));
    expect(merged([a, b, b])).toEqual(merged([a, b]));
    expect(merged([a, b])).toEqual(merged([a, b]));
  });
  it('auto characteristics are dropped (no extra row)', () => {
    expect(
      merged([
        layer('request', 'r', { wcm: { mode: 'auto' }, water_kg: { mode: 'fixed', value: 170 } }),
      ]).map((c) => c.key),
    ).toEqual(['water_kg']);
  });
  it('reports schema errors with the layer they came from', () => {
    const r = mergeLayers([layer('plant', 'aqaba@2', { wcm: { mode: 'range' } })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatchObject({ level: 'plant', origin: 'aqaba@2' });
  });
});

describe('unit normalization', () => {
  it('converts kg/cm² and fractions to the canonical unit', () => {
    const out = merged([
      layer('request', 'r', {
        fcr_mpa: { mode: 'fixed', value: 400, unit: 'kg/cm2' },
        sand_ratio_pct: { mode: 'target', value: 0.44, unit: 'fraction' },
        paste_l: { mode: 'range', max: 0.3, unit: 'm3' },
        fresh_density_kg_m3: { mode: 'range', min: 2.35, unit: 't/m3' },
        agg_share_pct: { a: { mode: 'fixed', value: 0.5, unit: 'fraction' } },
      }),
    ]);
    const v = (key: string) => out.find((c) => c.key === key)!.spec;
    expect(v('fcr_mpa').value).toBeCloseTo(39.2266, 4);
    expect(v('sand_ratio_pct').value).toBe(44);
    expect(v('paste_l').max).toBe(300);
    expect(v('fresh_density_kg_m3').min).toBe(2350);
    expect(out.find((c) => c.key === 'agg_share_pct')!.spec.value).toBe(50);
  });
  it('rejects a unit it does not know instead of guessing', () => {
    const r = normalizeUnits({ wcm: { mode: 'fixed', value: 0.4, unit: 'psi' } });
    expect(r).toEqual({ ok: false, key: 'wcm', message: expect.stringMatching(/not supported/) });
    const keyed = normalizeUnits({
      agg_share_pct: { a: { mode: 'fixed', value: 1, unit: 'furlong' } },
    });
    expect(keyed.ok).toBe(false);
    expect(normalizeUnits(null)).toEqual({ ok: true, characteristics: null });
    expect(
      mergeLayers([layer('request', 'r', { wcm: { mode: 'fixed', value: 1, unit: 'psi' } })]).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------- hard-limit rejection

const fa: SnapshotMaterial = {
  ...MATERIALS[0]!,
  id: 'fa',
  category: 'scm',
  test: { ...MATERIALS[0]!.test!, properties: { scm_type: 'fly_ash', sg: 2.2 } },
};
const unk: SnapshotMaterial = {
  ...fa,
  id: 'mystery',
  test: { ...fa.test!, properties: { sg: 2.2 } },
};

function ctxFor(over: Partial<EvaluationSnapshot['request']>, codeFcr: number | null = 38.3) {
  const s = makeSnapshot({
    request: { ...makeSnapshot().request, ...over },
    materials: [...MATERIALS, fa, unk],
  });
  const resolved = resolve(s.rules, { mode: 'ACI', context: evaluationContext(s.request, 30) });
  return { resolved, materials: s.materials, codeFcrMpa: codeFcr, nmasMm: s.request.nmasMm };
}
const one = (
  key: string,
  spec: Record<string, unknown>,
  sub: string | null = null,
): ResolvedCharacteristic[] => [
  { key, sub, spec: spec as ResolvedCharacteristic['spec'], origin: 'request' },
];

describe('rejection of loosening input (CODE_HARD / PROJECT_HARD never loosened)', () => {
  const s2 = ctxFor({ exposure: ['S2'] }); // max w/cm 0.45
  it('w/cm above the limit is rejected with rule, clause and the allowed bound', () => {
    const r = rejectLoosening(one('wcm', { mode: 'fixed', value: 0.5 }), s2);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      key: 'wcm',
      code: 'override_loosens',
      allowed: 0.45,
      rule: 'durability.S2.max_wcm',
      clause: 'ACI 318-19 Table 19.3.2.1',
      source: 'ACI',
    });
    expect(rejectLoosening(one('wcm', { mode: 'range', max: 0.5 }), s2)[0]?.code).toBe(
      'override_loosens',
    );
    expect(rejectLoosening(one('wcm', { mode: 'range', min: 0.4, max: 0.5 }), s2)[0]?.code).toBe(
      'override_loosens',
    );
  });
  it('tightening or matching is accepted; open-ended ranges rely on the limit that still applies', () => {
    expect(rejectLoosening(one('wcm', { mode: 'fixed', value: 0.4 }), s2)).toEqual([]);
    expect(rejectLoosening(one('wcm', { mode: 'fixed', value: 0.45 }), s2)).toEqual([]);
    expect(rejectLoosening(one('wcm', { mode: 'range', max: 0.4 }), s2)).toEqual([]);
    expect(rejectLoosening(one('wcm', { mode: 'range', min: 0.3 }), s2)).toEqual([]);
  });
  it('a minimum above the limit can never be satisfied: rejected as infeasible', () => {
    expect(rejectLoosening(one('wcm', { mode: 'range', min: 0.5 }), s2)[0]).toMatchObject({
      code: 'infeasible_with_limit',
      allowed: 0.45,
    });
  });
  it('no applicable limit, nothing to loosen', () => {
    expect(
      rejectLoosening(one('wcm', { mode: 'fixed', value: 0.9 }), ctxFor({ exposure: ['F0'] })),
    ).toEqual([]);
  });
  it('SCM percentage against the type limit and the total limit', () => {
    const f3 = ctxFor({ exposure: ['F3'], fcMpa: 40 });
    const r = rejectLoosening(one('scm', { mode: 'fixed', product: 'fa', pct: 30 }), f3);
    expect(r[0]).toMatchObject({
      code: 'override_loosens',
      allowed: 25,
      rule: 'scm.max.fly_ash_pozzolan_pct',
    });
    expect(rejectLoosening(one('scm', { mode: 'range', product: 'fa', max: 20 }), f3)).toEqual([]);
    expect(rejectLoosening(one('scm', { mode: 'range', product: 'fa', min: 10 }), f3)).toEqual([]);
    expect(
      rejectLoosening(one('scm', { mode: 'fixed', product: 'mystery', pct: 60 }), f3)[0]?.allowed,
    ).toBe(50); // total limit applies even if the type is unknown
    expect(rejectLoosening(one('scm', { mode: 'fixed', product: 'nope', pct: 10 }), f3)).toEqual(
      [],
    );
  });
  it('air content must stay inside the target band', () => {
    const f2 = ctxFor({ exposure: ['F2'] }); // target 6.0 ± 1.5 at 19 mm
    expect(rejectLoosening(one('air_pct', { mode: 'fixed', value: 3 }), f2)[0]).toMatchObject({
      code: 'override_loosens',
      allowed: [4.5, 7.5],
    });
    expect(rejectLoosening(one('air_pct', { mode: 'range', min: 5, max: 9 }), f2)).toHaveLength(1);
    expect(rejectLoosening(one('air_pct', { mode: 'range', min: 5, max: 7 }), f2)).toEqual([]);
    expect(rejectLoosening(one('air_pct', { mode: 'fixed', value: 6 }), f2)).toEqual([]);
    expect(
      rejectLoosening(
        one('air_pct', { mode: 'fixed', value: 9 }),
        ctxFor({ exposure: ['F2'], nmasMm: null }),
      ),
    ).toEqual([]);
    expect(
      rejectLoosening(one('air_pct', { mode: 'fixed', value: 9 }), ctxFor({ exposure: ['F0'] })),
    ).toEqual([]);
  });
  it('a fixed f′cr below the code value is rejected; at or above is fine', () => {
    expect(rejectLoosening(one('fcr_mpa', { mode: 'fixed', value: 35 }), s2)[0]).toMatchObject({
      code: 'override_loosens',
      allowed: 38.3,
    });
    expect(rejectLoosening(one('fcr_mpa', { mode: 'fixed', value: 38.3 }), s2)).toEqual([]);
    expect(
      rejectLoosening(one('fcr_mpa', { mode: 'fixed', value: 10 }), { ...s2, codeFcrMpa: null }),
    ).toEqual([]);
  });
  it('admixture dosage outside the product range is rejected', () => {
    const c = ctxFor({});
    const sp = c.materials.find((m) => m.id === 'sp')!;
    expect(sp).toBeTruthy();
    expect(
      rejectLoosening(one('admixture', { mode: 'fixed', product: 'sp', dosage_pct: 2 }), c)[0],
    ).toMatchObject({ code: 'outside_product_range' });
    expect(
      rejectLoosening(one('admixture', { mode: 'range', product: 'sp', min: 0.1 }), c),
    ).toHaveLength(1);
    expect(
      rejectLoosening(one('admixture', { mode: 'range', product: 'sp', min: 0.5, max: 1 }), c),
    ).toEqual([]);
    expect(
      rejectLoosening(one('admixture', { mode: 'fixed', product: 'sp', dosage_level: 2 }), c),
    ).toEqual([]);
  });
  it('checkCharacteristics returns every rejection at once (what the API sends back)', () => {
    const r = checkCharacteristics(
      [
        layer('request', 'request', {
          wcm: { mode: 'fixed', value: 0.6 },
          fcr_mpa: { mode: 'fixed', value: 20 },
          cement_kg: { mode: 'range', min: 330 },
        }),
      ],
      s2,
    );
    expect(r.ok).toBe(false);
    expect(r.rejected.map((x) => x.key).sort()).toEqual(['fcr_mpa', 'wcm']);
    const bad = checkCharacteristics([layer('request', 'request', { wcm: { mode: 'range' } })], s2);
    expect(bad.ok).toBe(false);
    expect(bad.invalid.length).toBeGreaterThan(0);
    const good = checkCharacteristics(
      [layer('request', 'request', { wcm: { mode: 'fixed', value: 0.4 } })],
      s2,
    );
    expect(good.ok).toBe(true);
  });
});

// ---------------------------------------------------------------- requested vs achieved

describe('requested vs achieved', () => {
  const snap = (chars: ResolvedCharacteristic[], over: Partial<EvaluationSnapshot> = {}) =>
    makeSnapshot({ characteristics: chars, ...over });
  const row = (
    chars: ResolvedCharacteristic[],
    key: string,
    over: Partial<EvaluationSnapshot> = {},
  ) => evaluate(snap(chars, over)).characteristics.rows.find((r) => r.key === key)!;
  const C = (
    key: string,
    spec: Record<string, unknown>,
    sub: string | null = null,
    origin = 'request',
  ) => ({ key, sub, spec, origin }) as ResolvedCharacteristic;

  it('computes each supported key from the proportions (hand values)', () => {
    expect(row([C('wcm', { mode: 'range', max: 0.55 })], 'wcm')).toMatchObject({
      achieved: 0.506,
      status: 'met',
      requested: '≤ 0.55',
      unit: 'ratio',
      klass: 'USER_SPECIFIED',
    });
    expect(row([C('wcm', { mode: 'range', max: 0.45 })], 'wcm')).toMatchObject({
      status: 'deviated',
      delta: 0.056,
    });
    expect(row([C('binder_kg', { mode: 'fixed', value: 350 })], 'binder_kg')).toMatchObject({
      achieved: 350,
      status: 'met',
      delta: 0,
    });
    expect(row([C('cement_kg', { mode: 'range', min: 330, max: 380 })], 'cement_kg')).toMatchObject(
      { achieved: 350, status: 'met', requested: '330–380' },
    );
    expect(row([C('cement_kg', { mode: 'range', min: 360 })], 'cement_kg')).toMatchObject({
      status: 'deviated',
      delta: -10,
      requested: '≥ 360',
    });
    expect(row([C('water_kg', { mode: 'target', value: 170 })], 'water_kg')).toMatchObject({
      achieved: 177.1,
      status: 'deviated',
      requested: 'target 170',
    });
    expect(
      row([C('sand_ratio_pct', { mode: 'target', value: 43, basis: 'mass' })], 'sand_ratio_pct'),
    ).toMatchObject({ status: 'deviated' });
    expect(
      row(
        [C('sand_ratio_pct', { mode: 'range', min: 43, max: 44, basis: 'volume' })],
        'sand_ratio_pct',
      ).achieved,
    ).toBeCloseTo(43.442623, 6);
    expect(
      row([C('agg_share_pct', { mode: 'range', min: 40, max: 45 }, 'sand')], 'agg_share_pct.sand'),
    ).toMatchObject({ status: 'met' });
    expect(row([C('agg_kg', { mode: 'fixed', value: 780 }, 'sand')], 'agg_kg.sand')).toMatchObject({
      achieved: 780,
      status: 'met',
    });
    expect(
      row([C('agg_kg', { mode: 'fixed', value: 780 }, 'ghost')], 'agg_kg.ghost'),
    ).toMatchObject({ achieved: null, status: 'not_evaluated' });
    expect(row([C('paste_l', { mode: 'range', max: 320 })], 'paste_l').achieved).toBeCloseTo(
      309.433962,
      6,
    );
    expect(
      row(
        [C('fresh_density_kg_m3', { mode: 'range', min: 2300, max: 2400 })],
        'fresh_density_kg_m3',
      ),
    ).toMatchObject({ achieved: 2343.5, status: 'met' });
    expect(
      row([C('max_cost_jod_m3', { mode: 'range', max: 40 })], 'max_cost_jod_m3'),
    ).toMatchObject({ achieved: 44.023, status: 'deviated' });
    expect(row([C('max_cost_jod_m3', { mode: 'range', max: 50 })], 'max_cost_jod_m3').status).toBe(
      'met',
    );
    expect(row([C('fm_combined', { mode: 'range', min: 4, max: 6 })], 'fm_combined').status).toBe(
      'met',
    );
    expect(
      row([C('passing_pct', { mode: 'range', min: 40, max: 60 }, '4.75')], 'passing_pct.4.75')
        .achieved,
    ).toBeCloseTo((780 * 98 + 1035 * 3) / 1815, 5);
    expect(row([C('slump_mm', { mode: 'fixed', value: 100 })], 'slump_mm')).toMatchObject({
      achieved: 100,
      status: 'met',
    });
    expect(row([C('nmas_mm', { mode: 'list', values: [19, 25] })], 'nmas_mm')).toMatchObject({
      status: 'met',
      requested: 'one of 19, 25',
    });
    expect(row([C('nmas_mm', { mode: 'fixed', value: 25 })], 'nmas_mm')).toMatchObject({
      status: 'deviated',
    });
    expect(row([C('nmas_mm', { mode: 'list', values: [12.5] })], 'nmas_mm').status).toBe(
      'deviated',
    );
    expect(
      row([C('extra_margin_mpa', { mode: 'fixed', value: 2 })], 'extra_margin_mpa'),
    ).toMatchObject({ achieved: 2, status: 'met', evidence: ['USER_OVERRIDE'] });
    expect(row([C('fcr_mpa', { mode: 'fixed', value: 42 })], 'fcr_mpa')).toMatchObject({
      achieved: 42,
      status: 'met',
    });
  });
  it('air, SCM product share and admixture dosage', () => {
    expect(row([C('air_pct', { mode: 'fixed', value: 2 })], 'air_pct')).toMatchObject({
      achieved: 2,
      status: 'met',
    });
    const baselineAir = row([C('air_pct', { mode: 'fixed', value: 2 })], 'air_pct', {
      request: { ...makeSnapshot().request, airPct: null },
    });
    expect(baselineAir.evidence).toEqual(['MODEL_BASELINE']);
    expect(
      row([C('admixture', { mode: 'fixed', product: 'sp', dosage_pct: 1 })], 'admixture'),
    ).toMatchObject({ achieved: 1, status: 'met' });
    expect(
      row([C('admixture', { mode: 'range', product: 'sp', min: 0.4, max: 0.8 })], 'admixture')
        .status,
    ).toBe('deviated');
    const lvl = row(
      [C('admixture', { mode: 'fixed', product: 'sp', dosage_level: 2 })],
      'admixture',
    );
    expect(lvl).toMatchObject({ status: 'not_evaluated' });
    expect(lvl.blocker?.detail).toMatch(/dosage level/);
    expect(lvl.requested).toBe('sp = level 2');
    const faMat: SnapshotMaterial = { ...fa };
    const withFa = row([C('scm', { mode: 'fixed', product: 'fa', pct: 20 })], 'scm', {
      materials: [...MATERIALS, faMat],
      lines: [
        { materialId: 'cem', kgPerM3: '280.000' },
        { materialId: 'fa', kgPerM3: '70.000' },
        { materialId: 'water', kgPerM3: '175.000' },
      ],
    });
    expect(withFa).toMatchObject({ achieved: 20, status: 'met', requested: 'fa = 20' });
    expect(
      row([C('scm', { mode: 'range', product: 'fa', max: 10 })], 'scm', {
        materials: [...MATERIALS, faMat],
      }).status,
    ).toBe('not_evaluated');
  });
  it('values that cannot be computed yet are named, never invented', () => {
    const cf = row([C('shilstone.cf', { mode: 'range', min: 45 })], 'shilstone.cf');
    expect(cf.status).toBe('not_evaluated');
    expect(cf.blocker?.detail).toMatch(/M3\.1/);
    expect(
      row([C('wcm', { mode: 'fixed', value: 0.5 })], 'wcm', {
        lines: [{ materialId: 'cem', kgPerM3: '350.000' }],
      }).status,
    ).toBe('not_evaluated');
    expect(
      row([C('max_cost_jod_m3', { mode: 'range', max: 50 })], 'max_cost_jod_m3', {
        materials: MATERIALS.map((m) =>
          m.id === 'cem' ? { ...m, price: { status: 'unavailable' as const } } : m,
        ),
      }).status,
    ).toBe('not_evaluated');
  });
  it('rounding tolerance per characteristic is a setting; unset means exact', () => {
    const c = [C('wcm', { mode: 'fixed', value: 0.505 })];
    expect(row(c, 'wcm').status).toBe('deviated');
    const settings = { ...makeSnapshot().settings, roundingTolerance: { wcm: 0.002 } };
    expect(row(c, 'wcm', { settings }).status).toBe('met');
    const range = [C('wcm', { mode: 'range', max: 0.505 })];
    expect(row(range, 'wcm', { settings }).status).toBe('met');
    expect(row([C('wcm', { mode: 'range', min: 0.51 })], 'wcm', { settings }).status).toBe(
      'deviated',
    );
  });
  it('describes every mode', () => {
    expect(describeSpec(C('wcm', { mode: 'fixed', value: 0.4 }))).toBe('= 0.4');
    expect(describeSpec(C('scm', { mode: 'range', product: 'fa', min: 10, max: 20 }))).toBe(
      'fa 10–20',
    );
    expect(describeSpec(C('wcm', { mode: 'range', max: 0.4 }))).toBe('≤ 0.4');
    expect(describeSpec(C('wcm', { mode: 'auto' }))).toBe('auto');
    expect(achievedRows([], makeSnapshot(), {})).toEqual([]);
  });
  it('is part of the report next to, not inside, code compliance', () => {
    const r = evaluate(snap([C('wcm', { mode: 'fixed', value: 0.3 })]));
    expect(r.characteristics.rows[0]!.status).toBe('deviated');
    expect(r.checks.some((c) => c.id === 'wcm')).toBe(false);
    expect(r.verdict).toBe('pass');
  });
});

describe('selectRules', () => {
  it('keeps the selected codes, ACI design aids and shared/engineering parameters; drops rules that cannot apply', () => {
    const s = makeSnapshot({ mode: 'JS' });
    const keys = (rs: typeof s.rules) => new Set(rs.map((r) => `${r.ruleset}:${r.key}`));
    const k = keys(s.rules);
    expect(k.has('ACI:prop.wc_strength.non_ae')).toBe(true);
    expect(k.has('ACI:durability.S2.max_wcm')).toBe(false);
    expect(k.has('SHARED:strength.basis_map')).toBe(true);
    expect(k.has('JS:fcr.no_data.mid.add')).toBe(true);
    expect(k.has('JS:durability.C1.max_cl_nonprestressed')).toBe(true);
    expect(k.has('JS:durability.F3.max_wcm')).toBe(false); // not in this request's exposure classes
    expect(ALL_RULES.length).toBeGreaterThan(s.rules.length);
  });
});
