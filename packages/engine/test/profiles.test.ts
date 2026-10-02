import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkCharacteristics, mergeLayers } from '../src/characteristics';
import {
  defaultsOf,
  diffVersions,
  matches,
  mergePreferences,
  originOf,
  profileLayers,
  selectProfiles,
  specificity,
  type ProfileVersionView,
} from '../src/profiles';

const P = (over: Partial<ProfileVersionView>): ProfileVersionView => ({
  profileId: 'p1',
  version: 1,
  status: 'approved',
  scope: 'tenant',
  plantId: null,
  name: 'x',
  family: null,
  appliesTo: {},
  characteristics: {},
  materials: {},
  objective: null,
  mode: null,
  createdAt: '2026-10-02',
  ...over,
});
const ctx = {
  fcMpa: 30,
  exposure: ['F0', 'S0', 'W0', 'C1'],
  pumpable: true,
  placement: 'slab',
  season: 'summer',
  plantId: 'A',
};

describe('matching', () => {
  it('every stated applies_to field must match; omitted fields match anything', () => {
    expect(matches(P({}), ctx)).toBe(true);
    expect(matches(P({ appliesTo: { fcMin: 25, fcMax: 35 } }), ctx)).toBe(true);
    expect(matches(P({ appliesTo: { fcMin: 31 } }), ctx)).toBe(false);
    expect(matches(P({ appliesTo: { fcMax: 29 } }), ctx)).toBe(false);
    expect(matches(P({ appliesTo: { fcMin: 1 } }), { ...ctx, fcMpa: null })).toBe(false);
    expect(matches(P({ appliesTo: { exposure: ['S0', 'C1'] } }), ctx)).toBe(true);
    expect(matches(P({ appliesTo: { exposure: ['S2'] } }), ctx)).toBe(false);
    expect(matches(P({ appliesTo: { pumpable: false } }), ctx)).toBe(false);
    expect(matches(P({ appliesTo: { placement: 'column' } }), ctx)).toBe(false);
    expect(matches(P({ appliesTo: { season: 'winter' } }), ctx)).toBe(false);
    expect(matches(P({ appliesTo: { season: 'all' } }), ctx)).toBe(true);
    expect(matches(P({ scope: 'plant', plantId: 'A' }), ctx)).toBe(true);
    expect(matches(P({ scope: 'plant', plantId: 'B' }), ctx)).toBe(false);
    expect(matches(P({ scope: 'plant', plantId: null }), ctx)).toBe(false);
  });

  it('counts specificity', () => {
    expect(specificity({})).toBe(0);
    expect(
      specificity({
        fcMin: 1,
        fcMax: 2,
        exposure: ['F0'],
        pumpable: true,
        placement: 'slab',
        season: 'all',
      }),
    ).toBe(5);
    expect(specificity({ exposure: [] })).toBe(0);
  });

  it('picks the narrowest per scope, lists the rest, and never guesses between equals', () => {
    const wide = P({ profileId: 'w', scope: 'product_family' });
    const narrow = P({ profileId: 'n', scope: 'product_family', appliesTo: { pumpable: true } });
    const t1 = P({ profileId: 't1', scope: 'plant', plantId: 'A', appliesTo: { pumpable: true } });
    const t2 = P({
      profileId: 't2',
      scope: 'plant',
      plantId: 'A',
      appliesTo: { placement: 'slab' },
    });
    const sel = selectProfiles([wide, narrow, t1, t2, P({ profileId: 'tn' })], ctx);
    expect(sel.chosen.map((v) => v.profileId)).toEqual(['tn', 'n']);
    expect(sel.alsoMatched.map((v) => v.profileId)).toEqual(['w']);
    expect(sel.ties).toHaveLength(1);
    expect(sel.ties[0]!.scope).toBe('plant');
    expect(sel.ties[0]!.candidates.map((v) => v.profileId)).toEqual(['t1', 't2']);
  });
});

describe('layering (F-021)', () => {
  const tenant = P({
    profileId: 'T',
    version: 2,
    scope: 'tenant',
    characteristics: {
      sand_ratio_pct: { mode: 'range', min: 35, max: 50 },
      wcm: { mode: 'range', max: 0.5 },
    },
  });
  const plant = P({
    profileId: 'P',
    version: 1,
    scope: 'plant',
    plantId: 'A',
    characteristics: { sand_ratio_pct: { mode: 'range', min: 38, max: 46 } },
  });
  const family = P({
    profileId: 'F',
    version: 3,
    scope: 'product_family',
    characteristics: {
      sand_ratio_pct: { mode: 'range', min: 40, max: 44 },
      agg_kg: { c20: { mode: 'fixed', value: 700 } },
    },
  });

  it('the product-family value applies when tenant, plant and family set the same characteristic, and its origin is kept', () => {
    const merged = mergeLayers(profileLayers([tenant, plant, family], {}));
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const sand = merged.characteristics.find((c) => c.key === 'sand_ratio_pct')!;
    expect(sand.spec).toMatchObject({ min: 40, max: 44 });
    expect(sand.origin).toBe(originOf(family));
    expect(merged.characteristics.find((c) => c.key === 'wcm')!.origin).toBe(originOf(tenant));
    expect(merged.characteristics.find((c) => c.key === 'agg_kg')!.origin).toBe('profile:F@3');
  });

  it('the request replaces any profile value, per key and per sub-key', () => {
    const merged = mergeLayers(
      profileLayers([tenant, family], {
        sand_ratio_pct: { mode: 'fixed', value: 42 },
        agg_kg: { c10: { mode: 'fixed', value: 300 } },
      }),
    );
    if (!merged.ok) throw new Error('layers');
    expect(merged.characteristics.find((c) => c.key === 'sand_ratio_pct')).toMatchObject({
      spec: { mode: 'fixed', value: 42 },
      origin: 'request',
    });
    expect(
      merged.characteristics
        .filter((c) => c.key === 'agg_kg')
        .map((c) => `${c.sub}:${c.origin}`)
        .sort(),
    ).toEqual(['c10:request', 'c20:profile:F@3']);
  });

  it('a profile can never loosen a code limit: the hard-limit checker rejects it like typed input', () => {
    const loose = P({ characteristics: { wcm: { mode: 'fixed', value: 0.7 } } });
    const ctxLimits = {
      resolved: {
        mode: 'ACI',
        issues: [],
        rejectedOverrides: [],
        requirements: [
          {
            requirement: 'max_wcm',
            kind: 'limit_max',
            units: 'ratio',
            value: 0.5,
            status: 'resolved',
            governing: {
              source: 'ACI',
              ruleKey: 'k',
              ruleId: 'i',
              version: 1,
              value: 0.5,
              clause_ref: 'Table',
              verified: false,
              requirement_class: 'CODE_HARD',
            },
            contributions: [],
            issues: [],
            verified: false,
          },
        ],
      },
      materials: [],
      codeFcrMpa: 38.3,
      nmasMm: 19,
    } as never;
    const r = checkCharacteristics(profileLayers([loose], {}), ctxLimits);
    expect(r.ok).toBe(false);
    expect(r.rejected[0]).toMatchObject({ key: 'wcm', code: 'override_loosens' });
  });

  it('property: layering never invents a key no layer supplied, and the request always wins', () => {
    const keys = ['wcm', 'binder_kg', 'paste_l'];
    fc.assert(
      fc.property(
        fc.array(fc.subarray(keys), { minLength: 1, maxLength: 3 }),
        fc.subarray(keys),
        (profileKeys, requestKeys) => {
          const spec = (n: number) => ({ mode: 'range', max: n });
          const profiles = profileKeys.map((ks, i) =>
            P({
              profileId: `p${i}`,
              scope: (['tenant', 'plant', 'product_family'] as const)[i]!,
              plantId: 'A',
              characteristics: Object.fromEntries(ks.map((k) => [k, spec(100 + i)])),
            }),
          );
          const req = Object.fromEntries(requestKeys.map((k) => [k, spec(1)]));
          const m = mergeLayers(profileLayers(profiles, req));
          if (!m.ok) return false;
          const supplied = new Set([...profileKeys.flat(), ...requestKeys]);
          return m.characteristics.every(
            (c) =>
              supplied.has(c.key) &&
              (requestKeys.includes(c.key)
                ? c.origin === 'request'
                : c.origin.startsWith('profile:')),
          );
        },
      ),
    );
  });
});

describe('preferences, defaults and diff', () => {
  it('exclusion always wins, includes intersect, preferences accumulate', () => {
    const a = P({ materials: { include: ['a', 'b', 'c'], exclude: ['x'], prefer: ['a'] } });
    const b = P({ scope: 'plant', materials: { include: ['b', 'c', 'x'], prefer: ['c'] } });
    expect(mergePreferences([a, b], { exclude: ['c'] })).toEqual({
      include: ['b'],
      exclude: ['x', 'c'],
      prefer: ['a', 'c'],
    });
    expect(mergePreferences([], undefined)).toEqual({});
  });

  it('the most specific profile sets the default objective and mode', () => {
    expect(
      defaultsOf([
        P({ objective: 'cheapest', mode: 'ACI' }),
        P({ objective: 'closest_to_targets' }),
      ]),
    ).toEqual({ objective: 'closest_to_targets', mode: 'ACI' });
    expect(defaultsOf([])).toEqual({ objective: null, mode: null });
  });

  it('diffs two versions row by row, keyed characteristics per sub-key', () => {
    const a = P({
      characteristics: {
        wcm: { mode: 'range', max: 0.5 },
        agg_kg: { c20: { mode: 'fixed', value: 700 } },
      },
      appliesTo: { fcMin: 25 },
    });
    const b = P({
      characteristics: {
        wcm: { mode: 'range', max: 0.45 },
        binder_kg: { mode: 'range', max: 400 },
        agg_kg: {},
      },
      appliesTo: { fcMin: 25 },
      objective: 'cheapest',
    });
    const d = diffVersions(a, b);
    expect(d.map((r) => `${r.kind}:${r.key}`)).toEqual([
      'removed:chars.agg_kg.c20',
      'added:chars.binder_kg',
      'changed:chars.wcm',
      'added:objective',
    ]);
    expect(diffVersions(a, a)).toEqual([]);
  });
});
