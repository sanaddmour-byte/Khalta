// Unit tests for the optimizer's building blocks. SYNTHETIC materials and engineering parameters throughout
// (src/testing/optimizer.ts): nothing here is a plant material or a code value.
import { describe, expect, it } from 'vitest';
import { RuleIndex } from '../src/evaluate/util';
import { aciBaseline } from '../src/optimizer/baseline';
import { enumerate } from '../src/optimizer/enumerate';
import { createHighsSolver, toLpText } from '../src/optimizer/highsSolver';
import {
  dmaxFor,
  gradingSieves,
  measure,
  targetPassing,
  wfAdjustment,
} from '../src/optimizer/measure';
import { byNmas, readGuardrails } from '../src/optimizer/params';
import { prepare, type Prepared } from '../src/optimizer/prepare';
import { DEFAULT_OPTIMIZER_SETTINGS, type LpProblem } from '../src/optimizer/types';
import type { SnapshotMaterial } from '../src/evaluate/types';
import type { ResolvedCharacteristic } from '../src/characteristics/resolve';
import type { RuleRecord } from '@khalta/rules';
import { selectRules } from '../src/evaluate/select';
import { ALL_RULES } from '../src/testing/synthetic';
import { OPT_MATERIALS, optimizerInput, syntheticRules } from '../src/testing/optimizer';

const ch = (key: string, spec: Record<string, unknown>, sub: string | null = null) =>
  ({ key, sub, spec, origin: 'request' }) as ResolvedCharacteristic;
const ok = (r: ReturnType<typeof prepare>): Prepared => {
  if (!r.ok) throw new Error(`blocked: ${r.blockers.map((b) => b.subject).join(', ')}`);
  return r.prepared;
};
const withMat = (id: string, f: (m: SnapshotMaterial) => SnapshotMaterial) =>
  OPT_MATERIALS.map((m) => (m.id === id ? f(m) : m));
const patchProps = (id: string, props: Record<string, unknown>, drop: string[] = []) =>
  withMat(id, (m) => {
    const p = { ...(m.test!.properties as Record<string, unknown>), ...props };
    for (const d of drop) delete p[d];
    return { ...m, test: { ...m.test!, properties: p } };
  });
const blockers = (r: ReturnType<typeof prepare>) => (r.ok ? [] : r.blockers.map((b) => b.subject));
/** Rules with an in-test change applied before the request's rules are selected. */
const patched = (
  f: (r: RuleRecord) => RuleRecord,
  request = optimizerInput().base.request,
  mode: 'ACI' | 'JS' | 'BOTH' = 'ACI',
) => selectRules(syntheticRules(ALL_RULES).map(f), mode, request);
const excluded = (p: Prepared, id: string) => p.excluded.find((e) => e.materialId === id)?.reason;

describe('guardrail parameters', () => {
  it('names every missing engineering parameter (the shipped seeds leave them empty)', () => {
    const rules = new RuleIndex(
      ALL_RULES.filter((r) => r.ruleset === 'ENGINEERING' || r.ruleset === 'ACI'),
    );
    const r = readGuardrails(rules, { needPumpable: true, codes: ['ACI'] });
    expect(r.params).toBeNull();
    const subjects = r.blockers.map((b) => b.subject);
    expect(subjects).toEqual(
      expect.arrayContaining([
        'eng.grading.target.band_pct',
        'eng.fines.max_pct_75um',
        'eng.pumpable.min_passing_0_3mm_pct',
        'ACI:grading.fine.limits',
        'ACI:grading.coarse.limits',
      ]),
    );
  });

  it('reads Shilstone WF bounds as one number or per NMAS, and blocks a missing NMAS entry', () => {
    expect(byNmas(30, 19)).toBe(30);
    expect(byNmas({ '19': 31 }, 19)).toBe(31);
    expect(byNmas({ '19': 31 }, 25)).toBeNull();
    expect(byNmas(null, 19)).toBeNull();
    const p = ok(
      prepare(
        optimizerInput({
          extraRules: {
            'eng.shilstone.wf.min': { '19': 28 },
            'eng.shilstone.wf.max': { '19': 45 },
          },
        }),
      ),
    );
    expect(p.guard.forNmas(19)).toEqual({ wf: { min: 28, max: 45 } });
    expect(p.guard.forNmas(25)).toMatchObject({
      blocker: { code: 'parameter_missing', subject: 'eng.shilstone.wf.min' },
    });
  });

  it('merges the individual grading limits of both codes, tightest first', () => {
    const lim = (min: number) => ({ '4.75': { min, max: 100 } });
    const r = prepare(
      optimizerInput({
        mode: 'BOTH',
        mirrorJs: true,
        extraRules: { 'ACI:grading.fine.limits': lim(90), 'JS:grading.fine.limits': lim(95) },
      }),
    );
    const p = ok(r);
    expect(p.guard.base.fineLimits).toEqual([{ sieve_mm: 4.75, min_pct: 95, max_pct: 100 }]);
    // the crusher fines (95 % at 4.75 mm) still pass; the sand (97 %) too
    expect(p.fines.map((f) => f.id)).toEqual(['crusher', 'sand']);
  });

  it('blocks when a selected code has no limits (JS values are not on file)', () => {
    // The JS rule values are not on file: the optimizer names what it cannot respect.
    expect(blockers(prepare(optimizerInput({ mode: 'JS' })))).toEqual(
      expect.arrayContaining(["f'cr", 'min_fc', 'max_cl_nonprestressed']),
    );
    const bare = prepare(
      optimizerInput({
        rules: ALL_RULES.filter((r) => r.ruleset === 'ENGINEERING' || r.ruleset === 'JS'),
      }),
    );
    expect(bare.ok).toBe(false);
  });
});

describe('prepare: blockers', () => {
  it('blocks air-entrained exposure, a missing slump, strength and NMAS', () => {
    expect(
      blockers(prepare(optimizerInput({ request: { exposure: ['F1', 'S0', 'W0', 'C1'] } }))),
    ).toContain('exposure F1–F3');
    expect(blockers(prepare(optimizerInput({ request: { slumpMm: null } })))).toContain('slump');
    expect(blockers(prepare(optimizerInput({ request: { fcMpa: null } })))).toContain(
      'specified strength',
    );
    expect(blockers(prepare(optimizerInput({ request: { nmasMm: null } })))).toContain('NMAS');
  });

  it('takes the NMAS from the characteristics when the request has none', () => {
    const fixed = ok(
      prepare(
        optimizerInput({
          request: { nmasMm: null },
          characteristics: [ch('nmas_mm', { mode: 'fixed', value: 19 })],
        }),
      ),
    );
    expect(fixed.nmasList).toEqual([19]);
    const list = ok(
      prepare(
        optimizerInput({
          request: { nmasMm: null },
          characteristics: [ch('nmas_mm', { mode: 'list', values: [25, 19] })],
        }),
      ),
    );
    expect(list.nmasList).toEqual([19, 25]);
  });

  it('blocks a request whose strength is below the exposure minimum (no mix can fix it)', () => {
    const r = prepare(
      optimizerInput({ request: { exposure: ['F0', 'S2', 'W0', 'C1'], fcMpa: 25 } }),
    );
    expect(blockers(r)).toContain('min_fc');
    expect(r.ok === false && r.blockers.find((b) => b.subject === 'min_fc')!.code).toBe(
      'request_infeasible',
    );
  });

  it('blocks a strength outside the ACI baseline table (no extrapolation) and an impossible band', () => {
    expect(blockers(prepare(optimizerInput({ request: { fcMpa: 60 } })))).toContain(
      'prop.wc_strength',
    );
    expect(
      blockers(prepare(optimizerInput({ extraRules: { 'eng.grading.target.band_pct': 1.5 } }))),
    ).toContain('eng.grading.target.band_pct');
  });

  it('blocks when a whole category is unusable, and when a required SCM is not available', () => {
    const noCoarse = OPT_MATERIALS.filter((m) => m.category !== 'coarse_agg');
    expect(blockers(prepare(optimizerInput({ materials: noCoarse })))).toContain(
      'coarse aggregate',
    );
    const noWater = OPT_MATERIALS.filter((m) => m.category !== 'water');
    expect(blockers(prepare(optimizerInput({ materials: noWater })))).toContain('water');
    const noCement = OPT_MATERIALS.filter((m) => m.category !== 'cement');
    expect(blockers(prepare(optimizerInput({ materials: noCement })))).toContain('cement');
    const noFine = OPT_MATERIALS.filter((m) => m.category !== 'fine_agg');
    expect(blockers(prepare(optimizerInput({ materials: noFine })))).toContain('fine aggregate');
  });
});

describe('prepare: materials are excluded with a stated reason, never silently', () => {
  /** The prepared context, or (when the exclusions left a category empty) just the exclusion list. */
  const run = (materials: SnapshotMaterial[], over: Parameters<typeof optimizerInput>[0] = {}) => {
    const r = prepare(optimizerInput({ materials, ...over }));
    return r.ok
      ? r.prepared
      : ({ excluded: r.excluded, notes: [], cements: [], admixtures: [] } as unknown as Prepared);
  };

  it('drops untested, expired, unpriced and ambiguous materials', () => {
    const p = run(
      OPT_MATERIALS.map((m) =>
        m.id === 'ggbs'
          ? { ...m, test: null }
          : m.id === 'fly'
            ? { ...m, test: { ...m.test!, freshness: 'expired' as const } }
            : m.id === 'c10'
              ? { ...m, price: { status: 'unavailable' as const } }
              : m.id === 'cem-sr'
                ? { ...m, price: { status: 'ambiguous' as const, supplierIds: ['a', 'b'] } }
                : m,
      ),
    );
    expect(excluded(p, 'ggbs')).toBe('no test data on file');
    expect(excluded(p, 'fly')).toContain('past its validity');
    expect(excluded(p, 'c10')).toContain('no price');
    expect(excluded(p, 'cem-sr')).toContain('several suppliers');
  });

  it('drops materials with an unconvertible price, no SG, and categories it does not optimize', () => {
    const p = run([
      ...OPT_MATERIALS.map((m) =>
        m.id === 'cem-sr'
          ? { ...m, price: { ...(m.price as object), unit: 'JOD/m3' } as never }
          : m,
      ).filter((m) => m.id !== 'crusher'),
      {
        ...OPT_MATERIALS.find((m) => m.id === 'crusher')!,
        test: {
          ...OPT_MATERIALS.find((m) => m.id === 'crusher')!.test!,
          properties: { sieve_analysis: [] },
        },
      },
      {
        id: 'fib',
        category: 'fiber',
        nameEn: 'fib',
        nameAr: null,
        test: OPT_MATERIALS[0]!.test,
        price: OPT_MATERIALS[0]!.price,
      },
    ]);
    expect(excluded(p, 'cem-sr')).toContain('cannot be converted');
    expect(excluded(p, 'crusher')).toContain('sg_ssd');
    expect(excluded(p, 'fib')).toContain('not used');
  });

  it('applies the include and exclude lists', () => {
    const p = ok(prepare(optimizerInput({ include: { exclude: ['fly'] } })));
    expect(excluded(p, 'fly')).toBe('excluded by the request');
    const q = ok(
      prepare(optimizerInput({ include: { include: ['cem-i', 'sand', 'c20', 'water'] } })),
    );
    expect(q.cements.map((c) => c.id)).toEqual(['cem-i']);
    expect(excluded(q, 'crusher')).toContain('include list');
  });

  it('filters cements by C3A class and demands C3A when sulfate exposure applies', () => {
    const p = run(OPT_MATERIALS, { request: { exposure: ['F0', 'S1', 'W0', 'C1'] } });
    expect(p.cements.map((c) => c.id)).toEqual(['cem-sr']);
    expect(excluded(p, 'cem-i')).toContain('below the required class');
    const q = run(patchProps('cem-i', {}, ['c3a_pct']), {
      request: { exposure: ['F0', 'S1', 'W0', 'C1'] },
    });
    expect(excluded(q, 'cem-i')).toContain('C₃A is not on file');
  });

  it('needs chloride data on every material when a chloride limit applies', () => {
    const p = run(
      OPT_MATERIALS.map((m) => {
        const drop = (k: string) => ({
          ...m,
          test: { ...m.test!, properties: { ...(m.test!.properties as object), [k]: undefined } },
        });
        return m.id === 'water'
          ? drop('chloride_mg_l')
          : m.id === 'sand'
            ? drop('chlorides_pct')
            : m.id === 'sp'
              ? drop('chloride_pct')
              : m;
      }),
    );
    expect(excluded(p, 'water')).toContain('chloride');
    expect(excluded(p, 'sand')).toContain('chloride');
    expect(excluded(p, 'sp')).toContain('chloride');
  });

  it('drops admixtures with missing type, convention, solids or table', () => {
    const drop = (k: string) => run(patchProps('sp', {}, [k]));
    expect(excluded(drop('type'), 'sp')).toContain('type');
    expect(excluded(drop('water_convention'), 'sp')).toContain('convention');
    expect(excluded(drop('solids_pct'), 'sp')).toContain('solids');
    expect(excluded(drop('water_reduction_table'), 'sp')).toContain('table');
  });

  it('drops aggregates with incomplete sieve data or that fail the individual grading limits', () => {
    const p = run(
      OPT_MATERIALS.map((m) =>
        m.id === 'sand'
          ? {
              ...m,
              test: {
                ...m.test!,
                properties: { ...(m.test!.properties as object), sieve_analysis: undefined },
              },
            }
          : m.id === 'crusher'
            ? {
                ...m,
                test: {
                  ...m.test!,
                  properties: {
                    ...(m.test!.properties as object),
                    sieve_analysis: [
                      { sieve_mm: 9.5, passing_pct: 100 },
                      { sieve_mm: 4.75, passing_pct: 80 },
                    ],
                  },
                },
              }
            : m.id === 'c10'
              ? {
                  ...m,
                  test: {
                    ...m.test!,
                    properties: {
                      ...(m.test!.properties as object),
                      sieve_analysis: [
                        { sieve_mm: 12.5, passing_pct: 100 },
                        { sieve_mm: 9.5, passing_pct: 90 },
                        { sieve_mm: 4.75, passing_pct: 40 },
                        { sieve_mm: 2.36, passing_pct: 30 },
                        { sieve_mm: 1.18, passing_pct: 10 },
                        { sieve_mm: 0.6, passing_pct: 5 },
                        { sieve_mm: 0.3, passing_pct: 2 },
                        { sieve_mm: 0.15, passing_pct: 1 },
                        { sieve_mm: 0.075, passing_pct: 0 },
                      ],
                    },
                  },
                }
              : m,
      ),
    );
    expect(excluded(p, 'sand')).toContain('sieve analysis');
    expect(excluded(p, 'crusher')).toContain('no % passing');
    expect(excluded(p, 'c10')).toContain('individual grading limits');
  });

  it('notes a missing dry-rodded unit weight (the coarse-volume sanity band is then skipped)', () => {
    const p = run(patchProps('c10', {}, ['dry_rodded_unit_weight_kg_m3']));
    expect(p.notes.some((n) => n.code === 'ca_volume_sanity_skipped')).toBe(true);
  });

  it('refuses accelerators when calcium chloride is prohibited, SCMs of unknown type, and uses limestone as filler only', () => {
    const p = run(
      [
        ...OPT_MATERIALS,
        {
          ...OPT_MATERIALS.find((m) => m.id === 'sp')!,
          id: 'acc',
          test: {
            ...OPT_MATERIALS.find((m) => m.id === 'sp')!.test!,
            properties: {
              ...(OPT_MATERIALS.find((m) => m.id === 'sp')!.test!.properties as object),
              type: 'C',
            },
          },
        },
        {
          ...OPT_MATERIALS.find((m) => m.id === 'fly')!,
          id: 'lime',
          test: {
            ...OPT_MATERIALS.find((m) => m.id === 'fly')!.test!,
            properties: { sg: 2.7, scm_type: 'limestone_filler' },
          },
        },
        {
          ...OPT_MATERIALS.find((m) => m.id === 'fly')!,
          id: 'untyped',
          test: { ...OPT_MATERIALS.find((m) => m.id === 'fly')!.test!, properties: { sg: 2.2 } },
        },
      ],
      { request: { exposure: ['F0', 'S2', 'W0', 'C1'], fcMpa: 31 } },
    );
    expect(excluded(p, 'lime')).toContain('limestone');
    expect(excluded(p, 'untyped')).toContain('type');
    expect(excluded(p, 'acc')).toContain('calcium chloride');
    const c1 = ok(
      prepare(
        optimizerInput({
          materials: [
            ...OPT_MATERIALS,
            {
              ...OPT_MATERIALS.find((m) => m.id === 'sp')!,
              id: 'acc',
              test: {
                ...OPT_MATERIALS.find((m) => m.id === 'sp')!.test!,
                properties: {
                  ...(OPT_MATERIALS.find((m) => m.id === 'sp')!.test!.properties as object),
                  type: 'C',
                },
              },
            },
          ],
        }),
      ),
    );
    // where calcium chloride is not prohibited the accelerator stays available
    expect(c1.admixtures.map((a) => a.id)).toContain('acc');
  });
});

describe('prepare: limits that bind the mix', () => {
  it('uses the tightest of the baseline and durability limits, less the robustness margin', () => {
    const p = ok(prepare(optimizerInput({ request: { exposure: ['F0', 'S0', 'W0', 'C1'] } })));
    expect(p.baselineWc).toBeGreaterThan(0.4);
    expect(p.wcmCeiling).toBeCloseTo(p.baselineWc - 0.02, 9);
    const f2 = ok(
      prepare(
        optimizerInput({
          request: { exposure: ['F0', 'S1', 'W2', 'C1'] },
          materials: OPT_MATERIALS,
        }),
      ),
    );
    expect(f2.durabilityWcm).toBe(0.5);
  });

  it('limits each SCM by the tightest applicable maximum and says when none is on file', () => {
    const capped = ok(
      prepare(
        optimizerInput({
          rules: patched((r) =>
            r.ruleset === 'ACI' && r.key.startsWith('scm.max.')
              ? { ...r, applies_to: { exposure: ['C1'] } }
              : r,
          ),
        }),
      ),
    );
    const fly = capped.scms.find((s) => s.id === 'fly')!;
    const ggbs = capped.scms.find((s) => s.id === 'ggbs')!;
    expect(capped.scmLimits(fly)).toMatchObject({ maxPct: 25 }); // min(total 50, fly ash 25, FA+SF 35)
    expect(capped.scmLimits(ggbs).maxPct).toBe(50);
    const open = ok(prepare(optimizerInput()));
    expect(open.scmLimits(open.scms[0]!).maxPct).toBeNull();
  });

  it('records the ACI baselines per NMAS', () => {
    const p = ok(
      prepare(
        optimizerInput({
          request: { nmasMm: null },
          characteristics: [ch('nmas_mm', { mode: 'list', values: [12.5, 19, 25] })],
        }),
      ),
    );
    expect([...p.baseWaterKg.keys()]).toEqual([12.5, 19, 25]);
    expect(p.baseWaterKg.get(19)).toBe(205);
    expect(p.airByNmas.get(19)).toBe(2);
  });
});

describe('measure', () => {
  const g = ok(prepare(optimizerInput())).guard;
  const sand = ok(prepare(optimizerInput())).fines.find((f) => f.id === 'sand')!;
  const c20 = ok(prepare(optimizerInput())).coarses.find((c) => c.id === 'c20')!;
  const agg = (kg: [number, number]) => [
    {
      id: 'sand',
      name: 'sand',
      kind: 'fine' as const,
      kg: kg[0],
      points: sand.points,
      finer75Pct: null,
    },
    {
      id: 'c20',
      name: 'c20',
      kind: 'coarse' as const,
      kg: kg[1],
      points: c20.points,
      finer75Pct: null,
    },
  ];

  it('picks the maximum size as the next ASTM sieve above the NMAS and the grading sieves below it', () => {
    expect(dmaxFor(19)).toBe(25);
    expect(dmaxFor(12.5)).toBe(19);
    expect(dmaxFor(500)).toBe(500);
    expect(gradingSieves(25)).toEqual([0.15, 0.3, 0.6, 1.18, 2.36, 4.75, 9.5, 12.5, 19]);
    expect(targetPassing(12.5, 25, 0.45)).toBeCloseTo(100 * 0.5 ** 0.45, 9);
  });

  it('adjusts the workability factor only above the binder threshold', () => {
    const w = { wfAdjustPoints: 2.5, wfAdjustPerKg: 56, wfAdjustAboveKg: 335 };
    expect(wfAdjustment(w, 300)).toBe(0);
    expect(wfAdjustment(w, 335 + 56)).toBeCloseTo(2.5, 9);
  });

  it('computes CF, WF, fines, 0.3 mm passing, FM and the grading rows from the sieve data', () => {
    const r = measure(agg([800, 1000]), 400, 19, g.base, { min: 28, max: 45 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.value;
    // combined passing at 2.36 mm: (800 × 85 + 1000 × 0) / 1800
    expect(m.workabilityFactor).toBeCloseTo((800 * 85) / 1800, 9);
    expect(m.coarsenessFactor).toBeCloseTo(
      ((100 - (800 * 100 + 1000 * 15) / 1800) / (100 - m.workabilityFactor)) * 100,
      9,
    );
    expect(m.workabilityFactorAdjusted).toBeCloseTo(
      m.workabilityFactor - wfAdjustment(g.base, 400),
      9,
    );
    expect(m.finesPct).toBeCloseTo((800 * 3) / 1800, 9);
    expect(m.passing03Pct).toBeCloseTo((800 * 22) / 1800, 9);
    expect(m.gradingSieves.map((s) => s.sieve_mm)).toEqual(gradingSieves(25));
    expect(Number.isFinite(m.fmCombined)).toBe(true);
  });

  it('reports what is missing instead of guessing', () => {
    const bad = [
      { ...agg([1, 1])[0]!, points: [{ sieve_mm: 9.5, passing_pct: 100 }] },
      agg([1, 1])[1]!,
    ];
    const r = measure(bad, 400, 19, g.base, { min: 28, max: 45 });
    expect(r.ok).toBe(false);
    const noFines = measure(
      [
        {
          ...agg([1, 1])[0]!,
          points: sand.points.filter((p) => p.sieve_mm > 0.075),
          finer75Pct: null,
        },
        agg([1, 1])[1]!,
      ],
      400,
      19,
      g.base,
      { min: 28, max: 45 },
    );
    expect(noFines.ok).toBe(false);
  });
});

describe('ACI 211.1 baseline path (golden)', () => {
  // The textbook absolute-volume procedure through the seeded ACI 211.1 tables (all `verified: false`).
  // Expected numbers are worked by hand below from the table values; this is a SYNTHETIC-derived example,
  // not a plant mix. Request: f'c 30 MPa, slump 100 mm, NMAS 19 mm, non-air-entrained, no strength history.
  it('reproduces the hand-worked proportions', () => {
    const p = ok(prepare(optimizerInput()));
    const cem = p.cements.find((c) => c.id === 'cem-i')!;
    const fine = p.fines.find((f) => f.id === 'sand')!;
    const coarse = p.coarses.find((c) => c.id === 'c20')!;
    const b = aciBaseline(p, { nmas: 19, cement: cem, fine, coarse });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    // f'cr = f'c + 8.3 (21 ≤ f'c ≤ 35 MPa, no data) = 38.3 MPa
    expect(p.strength.fcrMpa).toBeCloseTo(38.3, 9);
    // w/c: Table 6.3.4(a) between f'cr 35 (0.47) and 40 (0.42): 0.47 − 0.66 × 0.05
    const wc = 0.47 - 0.66 * 0.05;
    expect(b.wc).toBeCloseTo(wc, 9);
    expect(b.waterKg).toBe(205); // Table 6.3.3: 75–100 mm slump, 19 mm NMAS, non-AE
    expect(b.airPct).toBe(2); // Table 6.3.3 entrapped air, 19 mm
    const cement = 205 / wc;
    expect(b.cementKg).toBeCloseTo(cement, 9);
    // FM of the sand from its own sieve analysis: (0+2+15+34+54+78+93)/100 = 2.76
    expect(b.fmSand).toBeCloseTo(2.76, 9);
    // Table 6.3.6, 19 mm: 0.64 at FM 2.6, 0.62 at FM 2.8 → 0.624 at FM 2.76; × dry-rodded unit weight 1600 kg/m³
    expect(b.caVolumeFraction).toBeCloseTo(0.624, 9);
    expect(b.caKg).toBeCloseTo(0.624 * 1600, 9);
    // the sand takes the volume that remains, SSD
    const faVolume = 1 - cement / 3150 - 0.205 - 0.02 - (0.624 * 1600) / 2680;
    expect(b.faKg).toBeCloseTo(faVolume * 2620, 9);
    expect(b.faKg).toBeCloseTo(664.27, 1);
    expect(b.cementKg).toBeCloseTo(469.11, 1);
    expect(b.lines.map((l) => l.materialId)).toEqual(['cem-i', 'water', 'sand', 'c20']);
  });

  it('says why it cannot run', () => {
    const p = ok(prepare(optimizerInput()));
    const cem = p.cements[0]!;
    const fine = p.fines[0]!;
    const coarse = p.coarses.find((c) => c.id === 'c20')!;
    expect(aciBaseline(p, { nmas: 99, cement: cem, fine, coarse })).toMatchObject({ ok: false });
    expect(
      aciBaseline({ ...p, baselineWc: 0 } as Prepared, { nmas: 19, cement: cem, fine, coarse }),
    ).toMatchObject({ ok: false });
    const noDr = ok(
      prepare(
        optimizerInput({ materials: patchProps('c20', {}, ['dry_rodded_unit_weight_kg_m3']) }),
      ),
    );
    expect(
      aciBaseline(noDr, {
        nmas: 19,
        cement: noDr.cements[0]!,
        fine: noDr.fines[0]!,
        coarse: noDr.coarses.find((c) => c.id === 'c20')!,
      }),
    ).toMatchObject({ ok: false });
    const lowFm = { ...fine, points: [{ sieve_mm: 4.75, passing_pct: 100 }] };
    expect(aciBaseline(p, { nmas: 19, cement: cem, fine: lowFm, coarse })).toMatchObject({
      ok: false,
    });
  });
});

describe('enumeration', () => {
  const prep = (over: Parameters<typeof optimizerInput>[0] = {}) =>
    ok(prepare(optimizerInput(over)));

  it('is deterministic and ordered', () => {
    const a = enumerate(prep());
    const b = enumerate(prep());
    expect(
      a.configs.map(
        (c) => `${c.cement.id}|${c.scm?.id}|${c.scmPct}|${c.admix?.id}|${c.level?.dosagePct}`,
      ),
    ).toEqual(
      b.configs.map(
        (c) => `${c.cement.id}|${c.scm?.id}|${c.scmPct}|${c.admix?.id}|${c.level?.dosagePct}`,
      ),
    );
    expect(a.total).toBe(a.configs.length);
    expect(a.notes.some((n) => n.code === 'scm_cap_defaulted')).toBe(true);
  });

  it('coarsens the grid, then samples, to stay within the cap, and says so', () => {
    const small = enumerate(prep({ settings: { maxConfigurations: 60 } }));
    expect(small.configs.length).toBeLessThanOrEqual(60);
    expect(small.notes.some((n) => n.code === 'search_coarsened')).toBe(true);
    const tiny = enumerate(prep({ settings: { maxConfigurations: 7 } }));
    expect(tiny.configs).toHaveLength(7);
    expect(tiny.truncated).toBe(true);
  });

  it('honours a fixed or ranged SCM, a fixed or ranged admixture and a fixed air content', () => {
    const fixed = enumerate(
      prep({ characteristics: [ch('scm', { mode: 'fixed', product: 'ggbs', pct: 30 })] }),
    );
    expect(new Set(fixed.configs.map((c) => `${c.scm?.id}:${c.scmPct}`))).toEqual(
      new Set(['ggbs:30']),
    );
    const range = enumerate(
      prep({ characteristics: [ch('scm', { mode: 'range', product: 'fly', min: 10, max: 22 })] }),
    );
    expect([...new Set(range.configs.map((c) => c.scmPct))]).toEqual([10, 15, 20, 22]);
    const lvl = enumerate(
      prep({
        characteristics: [ch('admixture', { mode: 'fixed', product: 'sp', dosage_level: 2 })],
      }),
    );
    expect(new Set(lvl.configs.map((c) => c.level?.dosagePct))).toEqual(new Set([0.8]));
    const pct = enumerate(
      prep({
        characteristics: [ch('admixture', { mode: 'fixed', product: 'sp', dosage_pct: 1.0 })],
      }),
    );
    expect(pct.configs[0]!.level!.waterReductionPct).toBeCloseTo(14 + (0.2 / 0.7) * 8, 9);
    const adRange = enumerate(
      prep({
        characteristics: [ch('admixture', { mode: 'range', product: 'sp', min: 0.5, max: 1.6 })],
      }),
    );
    expect(new Set(adRange.configs.map((c) => c.level?.dosagePct))).toEqual(new Set([0.8, 1.5]));
    const air = enumerate(prep({ characteristics: [ch('air_pct', { mode: 'fixed', value: 3 })] }));
    expect(new Set(air.configs.map((c) => c.airPct))).toEqual(new Set([3]));
    const airRange = enumerate(
      prep({ characteristics: [ch('air_pct', { mode: 'range', min: 1, max: 4 })] }),
    );
    expect(new Set(airRange.configs.map((c) => c.airPct))).toEqual(new Set([1, 2, 4]));
  });

  it('applies a stated airPct to every configuration', () => {
    const e = enumerate(prep({ request: { airPct: 1.5 } }));
    expect(new Set(e.configs.map((c) => c.airPct))).toEqual(new Set([1.5]));
  });

  it('blocks on an SCM or admixture the request names but cannot use, or a dosage outside the table', () => {
    const miss = enumerate(
      prep({ characteristics: [ch('scm', { mode: 'fixed', product: 'nope', pct: 10 })] }),
    );
    expect(miss.blockers[0]!.subject).toBe('nope');
    const missA = enumerate(
      prep({
        characteristics: [ch('admixture', { mode: 'fixed', product: 'nope', dosage_level: 1 })],
      }),
    );
    expect(missA.blockers[0]!.subject).toBe('nope');
    const badLvl = enumerate(
      prep({
        characteristics: [ch('admixture', { mode: 'fixed', product: 'sp', dosage_level: 9 })],
      }),
    );
    expect(badLvl.blockers[0]!.code).toBe('out_of_domain');
    const badPct = enumerate(
      prep({ characteristics: [ch('admixture', { mode: 'fixed', product: 'sp', dosage_pct: 5 })] }),
    );
    expect(badPct.blockers[0]!.code).toBe('out_of_domain');
    const none = enumerate(
      prep({ characteristics: [ch('admixture', { mode: 'fixed', product: 'sp' })] }),
    );
    expect(none.blockers[0]!.code).toBe('input_missing');
    const empty = enumerate(
      prep({
        characteristics: [ch('admixture', { mode: 'range', product: 'sp', min: 2, max: 3 })],
      }),
    );
    expect(empty.blockers[0]!.code).toBe('out_of_domain');
  });

  it('forces an SCM of an allowed type where the exposure requires one', () => {
    const base = prep();
    const forced = { ...base, scmRequired: ['slag'] } as Prepared;
    const e = enumerate(forced);
    expect(new Set(e.configs.map((c) => c.scm?.type))).toEqual(new Set(['ggbs']));
    const pozz = enumerate({ ...base, scmRequired: ['pozzolan'] } as Prepared);
    expect(new Set(pozz.configs.map((c) => c.scm?.type))).toEqual(new Set(['fly_ash']));
  });

  it('uses a stated SCM maximum as the top of the grid', () => {
    const base = prep();
    const capped = {
      ...base,
      scmLimits: () => ({ maxPct: 12, governing: ['scm.max.total_pct'] }),
    } as Prepared;
    const e = enumerate(capped);
    expect(Math.max(...e.configs.map((c) => c.scmPct))).toBe(12);
  });
});

describe('HiGHS wrapper', () => {
  it('writes equalities, one-sided and ranged rows and bounds in LP text', () => {
    const p: LpProblem = {
      vars: [
        { name: 'a', lb: 0, ub: 10, cost: 1 },
        { name: 'b', lb: -1, ub: 5, cost: -2 },
        { name: 'c', lb: 0, ub: 1, cost: 0 },
      ],
      rows: [
        {
          name: 'eq',
          terms: [
            ['a', 1],
            ['b', 1],
          ],
          lb: 3,
          ub: 3,
        },
        {
          name: 'rng',
          terms: [
            ['a', 1],
            ['b', -1],
          ],
          lb: -4,
          ub: 4,
        },
        { name: 'none', terms: [], lb: null, ub: 1 },
      ],
    };
    const { text, rows } = toLpText(p);
    expect(text).toContain('Minimize');
    expect(text).toContain('= 3');
    expect(text).toContain('>= -4');
    expect(text).toContain('<= 4');
    expect(rows.map((r) => r.id)).toEqual(['eq', 'rng', 'rng', 'none']);
  });

  it('solves, reports duals and activities, and maps infeasible / unbounded / empty objectives', async () => {
    const solver = await createHighsSolver();
    const s = await solver.solve({
      vars: [
        { name: 'x', lb: 0, ub: 10, cost: 1 },
        { name: 'y', lb: 0, ub: 10, cost: 2 },
      ],
      rows: [
        {
          name: 'need',
          terms: [
            ['x', 1],
            ['y', 1],
          ],
          lb: 3,
          ub: null,
        },
      ],
    });
    expect(s.status).toBe('optimal');
    expect(s.x['x']).toBeCloseTo(3, 9);
    expect(s.duals['need']).toBeCloseTo(1, 9);
    expect(s.activity['need']).toBeCloseTo(3, 9);
    const inf = await solver.solve({
      vars: [{ name: 'x', lb: 0, ub: 1, cost: 1 }],
      rows: [{ name: 'r', terms: [['x', 1]], lb: 5, ub: null }],
    });
    expect(inf.status).toBe('infeasible');
    const free = await solver.solve({ vars: [{ name: 'x', lb: 0, ub: 1, cost: 0 }], rows: [] });
    expect(free.status).toBe('optimal');
    const unb = await solver.solve({
      vars: [{ name: 'x', lb: 0, ub: 1e30, cost: -1 }],
      rows: [],
    });
    expect(['unbounded', 'infeasible', 'error']).toContain(unb.status);
    expect(unb.status).not.toBe('optimal');
    expect(DEFAULT_OPTIMIZER_SETTINGS.maxConfigurations).toBe(200);
  });
});
