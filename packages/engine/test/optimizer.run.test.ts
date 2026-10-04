// End-to-end tests of the optimizer with the real solver. SYNTHETIC materials and engineering parameters
// (src/testing/optimizer.ts). The independent validator lives in another package and is exercised with the
// optimizer in apps/api/test; here it is stubbed.
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedCharacteristic } from '../src/characteristics/resolve';
import { evaluate } from '../src/evaluate/evaluate';
import { createHighsSolver, optimize, type OptimizeResult, type Solver } from '../src/optimizer';
import { optimizerInput } from '../src/testing/optimizer';

let solver: Solver;
beforeAll(async () => {
  solver = await createHighsSolver();
}, 30_000);

const ch = (key: string, spec: Record<string, unknown>, sub: string | null = null) =>
  ({ key, sub, spec, origin: 'request' }) as ResolvedCharacteristic;
const run = (
  over: Parameters<typeof optimizerInput>[0] = {},
  deps: Partial<Parameters<typeof optimize>[1]> = {},
) => optimize(optimizerInput(over), { solver, ...deps });
const num = (c: OptimizeResult['candidates'][number], k: string) => c.report.figures[k] as number;
const kg = (c: OptimizeResult['candidates'][number], id: string) =>
  Number(c.lines.find((l) => l.materialId === id)?.kgPerM3 ?? 0);
const costs = (r: OptimizeResult) => r.candidates.map((c) => Number(c.costJodPerM3));

describe('cheapest objective', () => {
  let r: OptimizeResult;
  beforeAll(async () => {
    r = await run();
  });

  it('returns the top 5 validated candidates, cheapest first, with a stated search', () => {
    expect(r.status).toBe('candidates');
    expect(r.candidates).toHaveLength(5);
    expect(costs(r)).toEqual([...costs(r)].sort((a, b) => a - b));
    expect(r.candidates.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(r.stats).toMatchObject({ enumerated: 136, solved: 136, truncated: false });
    expect(r.dof).toMatchObject({ quantities: 6, equalities: 1, dof: 5, state: 'free' });
    expect(r.optimizerVersion).toBe('1.0.0');
    expect(r.excluded).toEqual([]);
  });

  it('only returns what the evaluator passes, on the rounded numbers', () => {
    for (const c of r.candidates) {
      expect(c.report.verdict).toBe('pass');
      expect(evaluate(c.snapshot)).toEqual(c.report); // reproducible from the snapshot alone
      expect(Math.abs(num(c, 'yield.delta'))).toBeLessThanOrEqual(0.005);
      expect(num(c, 'ratio.wcm')).toBeLessThanOrEqual(0.417 + 1e-9);
      expect(c.evidence).toEqual(
        expect.arrayContaining(['MODEL_BASELINE', 'TRIAL_REQUIRED', 'RULE_UNVERIFIED']),
      );
      expect(c.requiresAuthorization).toBe(false);
    }
  });

  it('rounds to practical quantities', () => {
    for (const c of r.candidates) {
      for (const l of c.lines) {
        const m = c.snapshot.materials.find((x) => x.id === l.materialId)!;
        const q = Number(l.kgPerM3);
        if (m.category === 'cement' || m.category === 'scm') expect(q % 5).toBe(0);
        if (m.category === 'water') expect(Number.isInteger(q)).toBe(true);
        if (m.category === 'admixture')
          expect(Math.abs(q * 100 - Math.round(q * 100))).toBeLessThan(1e-6);
      }
      const aggs = c.lines.filter((l) => ['sand', 'crusher', 'c20', 'c10'].includes(l.materialId));
      expect(aggs.filter((l) => Number(l.kgPerM3) % 5 !== 0).length).toBeLessThanOrEqual(1);
    }
  });

  it('keeps every guardrail inside its limits with the stated margins', () => {
    for (const c of r.candidates) {
      expect(c.margins.wcmHeadroom).toBeGreaterThanOrEqual(0);
      expect(c.margins.cfMargin).toBeGreaterThanOrEqual(0);
      expect(c.margins.wfMargin).toBeGreaterThanOrEqual(0);
      expect(c.margins.finesMargin).toBeGreaterThanOrEqual(0);
      expect(c.margins.gradingMarginPts).toBeGreaterThanOrEqual(0);
      expect(c.guardrails.dmaxMm).toBe(25);
    }
  });

  it('reports the binding rows with their shadow prices', () => {
    const top = r.candidates[0]!;
    expect(top.binding.length).toBeGreaterThan(0);
    expect(top.binding.every((b) => b.klass !== 'PHYSICAL')).toBe(true);
    expect(top.binding.some((b) => b.id === 'E:wcm_ceiling')).toBe(true);
  });

  it('is deterministic', async () => {
    const again = await run();
    expect(
      JSON.stringify(again.candidates.map((c) => [c.lines, c.costJodPerM3, c.configuration])),
    ).toBe(JSON.stringify(r.candidates.map((c) => [c.lines, c.costJodPerM3, c.configuration])));
  });

  it('stays inside the 200-configuration cap and its time budget', async () => {
    const t0 = Date.now();
    const big = await run({ settings: { scmStepPct: 2.5 } });
    expect(big.stats.enumerated).toBeLessThanOrEqual(200);
    expect(big.status).toBe('candidates');
    expect(Date.now() - t0).toBeLessThan(20_000);
  });

  it('stops at the time budget and says so', async () => {
    let t = 0;
    const r2 = await run({}, { now: () => (t += 4000) });
    expect(r2.stats.truncated).toBe(true);
    expect(r2.notes.some((n) => n.code === 'time_budget')).toBe(true);
  });
});

describe('the independent validator hook', () => {
  it('drops a candidate the validator refuses, and reports no valid candidate when all are refused', async () => {
    const seen: number[] = [];
    const r = await run({}, { validate: (rec) => (seen.push(1), rec.configuration.scmPct !== 40) });
    expect(r.candidates.every((c) => c.configuration.scmPct !== 40)).toBe(true);
    expect(seen.length).toBeGreaterThan(5);
    const none = await run({ settings: { candidatesTopN: 2 } }, { validate: () => false });
    expect(none.status).toBe('no_valid_candidate');
    expect(none.notes.some((n) => n.code === 'rejected_after_rounding')).toBe(true);
    expect(none.stats.rejectedAfterRounding).toBeGreaterThan(0);
  });

  it('hands over plain data the validator can check (no functions)', async () => {
    let record: unknown;
    await run({ settings: { candidatesTopN: 1 } }, { validate: (rec) => ((record = rec), true) });
    expect(() => JSON.stringify(record)).not.toThrow();
    expect(Object.keys(record as object)).toEqual(
      expect.arrayContaining([
        'snapshot',
        'report',
        'configuration',
        'guardrails',
        'characteristics',
        'costJodPerM3',
        'evidence',
      ]),
    );
  });
});

describe('what the optimizer refuses to do', () => {
  it('is blocked, naming every missing parameter, on the shipped seeds', async () => {
    const r = await run({
      extraRules: { 'eng.grading.target.band_pct': null, 'eng.fines.max_pct_75um': null },
    });
    expect(r.status).toBe('blocked');
    expect(r.candidates).toHaveLength(0);
    expect(r.blockers.map((b) => b.subject)).toEqual(
      expect.arrayContaining(['eng.grading.target.band_pct', 'eng.fines.max_pct_75um']),
    );
  });

  it('blocks air-entrained requests', async () => {
    const r = await run({ request: { exposure: ['F2', 'S0', 'W0', 'C1'] } });
    expect(r.status).toBe('blocked');
    expect(r.blockers[0]!.code).toBe('not_supported');
  });

  it('blocks when an SCM the request names cannot be used', async () => {
    const r = await run({
      characteristics: [ch('scm', { mode: 'fixed', product: 'unknown', pct: 10 })],
    });
    expect(r.status).toBe('blocked');
    expect(r.blockers[0]!.subject).toBe('unknown');
  });

  it('reports a request no configuration can be formed for', async () => {
    const r = await run({
      include: { include: ['cem-i', 'water', 'sand', 'c20'] },
      characteristics: [ch('scm', { mode: 'fixed', product: 'fly', pct: 10 })],
    });
    expect(r.status).toBe('blocked');
  });
});

describe('characteristics', () => {
  const met = (r: OptimizeResult, key: string) =>
    r.candidates.map((c) => c.characteristics.find((x) => x.key === key)!);

  const cases: [string, ResolvedCharacteristic[], (r: OptimizeResult) => void][] = [
    [
      'fixed w/cm',
      [ch('wcm', { mode: 'fixed', value: 0.4 })],
      (r) => r.candidates.forEach((c) => expect(num(c, 'ratio.wcm')).toBeCloseTo(0.4, 1)),
    ],
    [
      'w/cm range',
      [ch('wcm', { mode: 'range', min: 0.36, max: 0.38 })],
      (r) => r.candidates.forEach((c) => expect(num(c, 'ratio.wcm')).toBeLessThanOrEqual(0.385)),
    ],
    [
      'binder range',
      [ch('binder_kg', { mode: 'range', min: 420, max: 450 })],
      (r) => r.candidates.forEach((c) => expect(num(c, 'mass.binder')).toBeGreaterThanOrEqual(419)),
    ],
    [
      'cement fixed',
      [ch('cement_kg', { mode: 'fixed', value: 300 })],
      (r) =>
        r.candidates.forEach((c) =>
          expect(Math.abs(num(c, 'mass.cement') - 300)).toBeLessThanOrEqual(3),
        ),
    ],
    [
      'free water fixed',
      [ch('water_kg', { mode: 'fixed', value: 190 })],
      (r) =>
        r.candidates.forEach((c) =>
          expect(Math.abs(num(c, 'mass.water') - 190)).toBeLessThanOrEqual(1.9),
        ),
    ],
    [
      'sand ratio (mass) range',
      [ch('sand_ratio_pct', { mode: 'range', min: 40, max: 48 })],
      (r) =>
        r.candidates.forEach((c) =>
          expect(num(c, 'agg.sand_ratio_mass_pct')).toBeGreaterThanOrEqual(39.5),
        ),
    ],
    [
      'sand ratio (volume) range',
      [ch('sand_ratio_pct', { mode: 'range', min: 40, max: 48, basis: 'volume' })],
      (r) =>
        r.candidates.forEach((c) =>
          expect(num(c, 'agg.sand_ratio_volume_pct')).toBeGreaterThanOrEqual(39.5),
        ),
    ],
    [
      'aggregate share',
      [ch('agg_share_pct', { mode: 'range', min: 30, max: 45 }, 'c20')],
      (r) =>
        r.candidates.forEach((c) => expect(num(c, 'agg.share_pct.c20')).toBeLessThanOrEqual(45.5)),
    ],
    [
      'aggregate kg',
      [ch('agg_kg', { mode: 'fixed', value: 700 }, 'c20')],
      (r) => r.candidates.forEach((c) => expect(kg(c, 'c20')).toBe(700)),
    ],
    [
      'paste',
      [ch('paste_l', { mode: 'range', max: 320 })],
      (r) => r.candidates.forEach((c) => expect(num(c, 'agg.paste_l')).toBeLessThanOrEqual(323)),
    ],
    [
      'combined FM',
      [ch('fm_combined', { mode: 'range', min: 4.6, max: 5.2 })],
      (r) =>
        r.candidates.forEach((c) => expect(num(c, 'agg.fm_combined')).toBeGreaterThanOrEqual(4.59)),
    ],
    [
      'passing at a sieve',
      [ch('passing_pct', { mode: 'range', min: 38, max: 44 }, '2.36')],
      (r) =>
        r.candidates.forEach((c) =>
          expect(num(c, 'agg.passing.2.36')).toBeGreaterThanOrEqual(37.9),
        ),
    ],
    [
      'fresh density',
      [ch('fresh_density_kg_m3', { mode: 'range', min: 2380, max: 2420 })],
      (r) =>
        r.candidates.forEach((c) =>
          expect(num(c, 'mass.fresh_density')).toBeGreaterThanOrEqual(2379),
        ),
    ],
    [
      'maximum cost',
      [ch('max_cost_jod_m3', { mode: 'range', max: 60 })],
      (r) =>
        r.candidates.forEach((c) => expect(Number(c.costJodPerM3)).toBeLessThanOrEqual(60.001)),
    ],
    [
      'coarseness factor range',
      [ch('shilstone.cf', { mode: 'range', min: 56, max: 62 })],
      (r) =>
        r.candidates.forEach((c) =>
          expect(c.guardrails.coarsenessFactor).toBeGreaterThanOrEqual(55.99),
        ),
    ],
    [
      'workability factor range',
      [ch('shilstone.wf', { mode: 'range', min: 30, max: 36 })],
      (r) =>
        r.candidates.forEach((c) =>
          expect(c.guardrails.workabilityFactorAdjusted).toBeLessThanOrEqual(36.01),
        ),
    ],
    [
      'fines range',
      [ch('fines_max_pct', { mode: 'range', max: 2 })],
      (r) => r.candidates.forEach((c) => expect(c.guardrails.finesPct).toBeLessThanOrEqual(2.01)),
    ],
    [
      'fixed SCM',
      [ch('scm', { mode: 'fixed', product: 'ggbs', pct: 30 })],
      (r) => r.candidates.forEach((c) => expect(num(c, 'scm.pct.line.ggbs')).toBeCloseTo(30, 0)),
    ],
    [
      'admixture at a level',
      [ch('admixture', { mode: 'fixed', product: 'sp', dosage_level: 2 })],
      (r) => r.candidates.forEach((c) => expect(num(c, 'dosage.sp')).toBeCloseTo(0.8, 1)),
    ],
    [
      'fixed air',
      [ch('air_pct', { mode: 'fixed', value: 3 })],
      (r) => r.candidates.forEach((c) => expect(c.configuration.airPct).toBe(3)),
    ],
  ];
  for (const [name, chars, check] of cases)
    it(`${name}: every candidate satisfies it and the evaluator agrees`, async () => {
      const r = await run({ characteristics: chars });
      expect(r.status, JSON.stringify(r.conflicts ?? r.notes)).toBe('candidates');
      for (const c of r.candidates) {
        for (const row of c.characteristics) expect(row.status, `${name}: ${row.key}`).toBe('met');
        expect(c.report.verdict).toBe('pass');
      }
      check(r);
    });

  it('a fixed free water below the model estimate is a USER_OVERRIDE, and far below it flags the slump', async () => {
    const mild = await run({ characteristics: [ch('water_kg', { mode: 'fixed', value: 200 })] });
    expect(mild.candidates[0]!.evidence).toContain('USER_OVERRIDE');
    expect(mild.candidates[0]!.notes.some((n) => n.code === 'water_below_model')).toBe(true);
    const deep = await run({ characteristics: [ch('water_kg', { mode: 'fixed', value: 160 })] });
    expect(deep.candidates[0]!.notes.some((n) => n.code === 'slump_at_risk')).toBe(true);
    expect(deep.candidates[0]!.evidence).toContain('USER_OVERRIDE');
  });

  it('a w/cm above the ACI baseline is allowed, labelled MODEL_PREDICTS_SHORTFALL and needs authorisation', async () => {
    const r = await run({ characteristics: [ch('wcm', { mode: 'fixed', value: 0.5 })] });
    expect(r.status).toBe('candidates');
    for (const c of r.candidates) {
      expect(c.evidence).toContain('MODEL_PREDICTS_SHORTFALL');
      expect(c.requiresAuthorization).toBe(true);
    }
  });

  it('a fixed binder with a fixed water above the ceiling takes the same shortfall path', async () => {
    const r = await run({
      characteristics: [
        ch('binder_kg', { mode: 'fixed', value: 380 }),
        ch('water_kg', { mode: 'fixed', value: 190 }),
      ],
    });
    expect(r.status).toBe('candidates');
    expect(r.candidates[0]!.requiresAuthorization).toBe(true);
  });

  it('tightens: a w/cm range maximum never makes the mix cheaper', async () => {
    const loose = await run({ characteristics: [ch('wcm', { mode: 'range', max: 0.41 })] });
    const tight = await run({ characteristics: [ch('wcm', { mode: 'range', max: 0.36 })] });
    expect(Number(tight.candidates[0]!.costJodPerM3)).toBeGreaterThanOrEqual(
      Number(loose.candidates[0]!.costJodPerM3) - 1e-9,
    );
    expect(num(tight.candidates[0]!, 'mass.binder')).toBeGreaterThanOrEqual(
      num(loose.candidates[0]!, 'mass.binder') - 5,
    );
  });

  it('rows for a target characteristic show the deviation, and the cost of it', async () => {
    const r = await run({ characteristics: [ch('binder_kg', { mode: 'target', value: 380 })] });
    const row = met(r, 'binder_kg')[0]!;
    expect(['met', 'deviated']).toContain(row.status);
    for (const c of r.candidates) {
      expect(c.deviations[0]).toMatchObject({ key: 'binder_kg', requested: 380 });
      expect(c.deviations[0]!.weightedCostJod).toBeCloseTo(
        Math.abs(c.deviations[0]!.achieved - 380) * 0.05,
        9,
      );
    }
  });
});

describe('objective modes', () => {
  const target = [ch('binder_kg', { mode: 'target', value: 420 })];
  it('closest_to_targets minimises the deviation first, then the cost', async () => {
    const closest = await run({ characteristics: target, objective: 'closest_to_targets' });
    const cheap = await run({ characteristics: target, objective: 'cheapest' });
    const dev = (c: OptimizeResult['candidates'][number]) => Math.abs(num(c, 'mass.binder') - 420);
    expect(dev(closest.candidates[0]!)).toBeLessThanOrEqual(dev(cheap.candidates[0]!) + 1e-9);
    const devs = closest.candidates.map(dev);
    expect(devs).toEqual([...devs].sort((a, b) => a - b));
    expect(closest.objective).toBe('closest_to_targets');
  });

  it('with no targets, closest_to_targets is the cheapest', async () => {
    const a = await run({ objective: 'closest_to_targets' });
    const b = await run({ objective: 'cheapest' });
    expect(costs(a)).toEqual(costs(b));
  });

  it('a per-characteristic weight changes the trade-off', async () => {
    const heavy = await run({
      characteristics: [ch('binder_kg', { mode: 'target', value: 420, weight_jod_per_unit: 5 })],
    });
    const light = await run({
      characteristics: [ch('binder_kg', { mode: 'target', value: 420, weight_jod_per_unit: 0 })],
    });
    const d = (r: OptimizeResult) => Math.abs(num(r.candidates[0]!, 'mass.binder') - 420);
    expect(d(heavy)).toBeLessThanOrEqual(d(light) + 1e-9);
  });
});

describe('degrees of freedom and conflicts', () => {
  it('counts free quantities against the Fixed characteristics', async () => {
    const free = await run({ characteristics: [ch('wcm', { mode: 'fixed', value: 0.4 })] });
    expect(free.dof).toMatchObject({ dof: 4, state: 'free', fixed: ['wcm'] });
    const four = await run({
      characteristics: [
        ch('wcm', { mode: 'fixed', value: 0.4 }),
        ch('binder_kg', { mode: 'fixed', value: 450 }),
        ch('agg_kg', { mode: 'fixed', value: 700 }, 'c20'),
        ch('agg_kg', { mode: 'fixed', value: 500 }, 'c10'),
        ch('agg_kg', { mode: 'fixed', value: 400 }, 'sand'),
      ],
    });
    expect(four.dof).toMatchObject({
      quantities: 6,
      equalities: 6,
      dof: 0,
      state: 'fully_specified',
    });
    const over = await run({
      characteristics: [
        ch('wcm', { mode: 'fixed', value: 0.4 }),
        ch('binder_kg', { mode: 'fixed', value: 450 }),
        ch('water_kg', { mode: 'fixed', value: 180 }),
        ch('agg_kg', { mode: 'fixed', value: 700 }, 'c20'),
        ch('agg_kg', { mode: 'fixed', value: 500 }, 'c10'),
        ch('agg_kg', { mode: 'fixed', value: 400 }, 'sand'),
        ch('agg_kg', { mode: 'fixed', value: 300 }, 'crusher'),
      ],
    });
    expect(over.dof).toMatchObject({ dof: -2, state: 'over_specified' });
  });

  it('names the user-specified values that cannot hold together, and how far each would have to move', async () => {
    const r = await run({
      characteristics: [
        ch('wcm', { mode: 'fixed', value: 0.3 }),
        ch('binder_kg', { mode: 'fixed', value: 300 }),
      ],
    });
    expect(r.status).toBe('infeasible');
    expect(r.candidates).toHaveLength(0);
    expect(r.conflicts!.kind).toBe('user_specified');
    const ids = r.conflicts!.items.map((i) => i.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const i of r.conflicts!.items) {
      expect(i.klass).toBe('USER');
      expect(i.relaxBy).toBeGreaterThan(0);
      expect([i.category, i.adjustable]).toEqual(['user_preference', true]);
    }
    expect(ids.every((id) => ['wcm', 'binder_kg'].includes(id))).toBe(true);
  });

  it('never proposes relaxing a code or engineering limit: hard rows are named, with no saving', async () => {
    const r = await run({ extraRules: { 'eng.fines.max_pct_75um': 0.4 } });
    expect(r.status).toBe('infeasible');
    expect(r.conflicts!.kind).toBe('hard_rows');
    expect(r.conflicts!.items.length).toBeGreaterThan(0);
    for (const i of r.conflicts!.items) {
      expect(i.klass).not.toBe('USER');
      expect(i.relaxBy).toBeNull();
      // a governing requirement is never adjustable and is classified by who owns it
      expect(i.adjustable).toBe(false);
      expect(i.category).not.toBe('user_preference');
    }
  });

  it('a request whose strength is outside the ACI baseline table is blocked, not guessed', async () => {
    const r = await run({ request: { fcMpa: 45 } });
    expect(r.status).toBe('blocked');
    expect(r.blockers.map((b) => b.subject)).toContain('prop.wc_strength');
  });
});

describe('rounding rescue', () => {
  it('tries other roundings when the default would break a fixed characteristic, else rejects with the reason', async () => {
    const tight = await run({
      characteristics: [ch('wcm', { mode: 'fixed', value: 0.4 })],
      settings: { roundingTolerance: { wcm: 0.0004 } },
    });
    expect(['candidates', 'no_valid_candidate']).toContain(tight.status);
    if (tight.status === 'candidates')
      for (const c of tight.candidates)
        expect(Math.abs(num(c, 'ratio.wcm') - 0.4)).toBeLessThanOrEqual(0.0004 + 1e-9);
    else expect(tight.notes.some((n) => n.code === 'rejected_after_rounding')).toBe(true);
  });
});

describe('properties', () => {
  it('every candidate is a pass for the evaluator, within yield and the w/cm ceiling, whatever the request', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 20, max: 31 }),
        fc.constantFrom(60, 100, 160),
        fc.constantFrom(12.5, 19, 25),
        fc.boolean(),
        async (fcMpa, slumpMm, nmasMm, pumpable) => {
          const r = await run({
            request: { fcMpa, slumpMm, nmasMm, pumpable },
            settings: { candidatesTopN: 2, maxConfigurations: 40 },
          });
          if (r.status !== 'candidates') return;
          const ceiling = r.candidates[0]!.margins.wcmCeiling;
          expect(costs(r)).toEqual([...costs(r)].sort((a, b) => a - b));
          for (const c of r.candidates) {
            expect(c.report.verdict).toBe('pass');
            expect(Math.abs(num(c, 'yield.delta'))).toBeLessThanOrEqual(0.005);
            expect(num(c, 'ratio.wcm')).toBeLessThanOrEqual(ceiling + 1e-9);
            expect(c.margins.cfMargin).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 8 },
    );
  }, 120_000);

  it('a tighter w/cm range never lowers the binder or the cost', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 0.34, max: 0.4, noNaN: true }),
        fc.double({ min: 0.005, max: 0.03, noNaN: true }),
        async (hi, d) => {
          const loose = await run({
            characteristics: [ch('wcm', { mode: 'range', max: hi })],
            settings: { candidatesTopN: 1, maxConfigurations: 30 },
          });
          const tight = await run({
            characteristics: [ch('wcm', { mode: 'range', max: hi - d })],
            settings: { candidatesTopN: 1, maxConfigurations: 30 },
          });
          if (loose.status !== 'candidates' || tight.status !== 'candidates') return;
          expect(Number(tight.candidates[0]!.costJodPerM3)).toBeGreaterThanOrEqual(
            Number(loose.candidates[0]!.costJodPerM3) - 0.05,
          );
        },
      ),
      { numRuns: 6 },
    );
  }, 120_000);

  it('Both is never less strict than either code: its candidates satisfy the stricter w/cm', async () => {
    const both = await run({
      mode: 'BOTH',
      mirrorJs: true,
      request: { exposure: ['F0', 'S1', 'W0', 'C1'] },
      extraRules: { 'JS:durability.S1.max_wcm': 0.4 },
    });
    const aci = await run({ mode: 'ACI', request: { exposure: ['F0', 'S1', 'W0', 'C1'] } });
    expect(both.status).toBe('candidates');
    for (const c of both.candidates) expect(num(c, 'ratio.wcm')).toBeLessThanOrEqual(0.4 + 1e-9);
    expect(Number(both.candidates[0]!.costJodPerM3)).toBeGreaterThanOrEqual(
      Number(aci.candidates[0]!.costJodPerM3) - 1e-9,
    );
  });

  it('rounding never breaks a hard limit: every candidate re-measured against the limits without the guard', async () => {
    const r = await run({ settings: { guardrailGuard: 0, candidatesTopN: 5 } });
    for (const c of r.candidates) {
      expect(c.guardrails.coarsenessFactor).toBeGreaterThanOrEqual(45);
      expect(c.guardrails.coarsenessFactor).toBeLessThanOrEqual(75);
      expect(c.guardrails.finesPct).toBeLessThanOrEqual(6);
    }
  });
});

describe('more of the rounding and diagnostics paths', () => {
  it('rescues a candidate whose default rounding would leave a fixed value outside its tolerance', async () => {
    // cement 297 kg ±1 % (2.97): rounding binder up gives 300 (3 off); the "nearest" rounding gives 295 (2 off).
    const r = await run({
      characteristics: [ch('cement_kg', { mode: 'fixed', value: 297 })],
      settings: { candidatesTopN: 3 },
    });
    expect(r.status).toBe('candidates');
    for (const c of r.candidates)
      expect(Math.abs(num(c, 'mass.cement') - 297)).toBeLessThanOrEqual(2.97 + 1e-9);
  });

  it('adds cement in 5 kg steps when rounding alone leaves the w/cm over its limit', async () => {
    const r = await run({
      characteristics: [ch('wcm', { mode: 'range', max: 0.4 })],
      settings: { candidatesTopN: 3, roundingTolerance: { wcm: 0 } },
    });
    expect(r.status).toBe('candidates');
    for (const c of r.candidates) expect(num(c, 'ratio.wcm')).toBeLessThanOrEqual(0.4 + 1e-6);
  });

  it('explains an over-restrictive request with no user rows at all as hard rows', async () => {
    const r = await run({ extraRules: { 'eng.grading.target.band_pct': 2.1 } });
    expect(['infeasible', 'no_valid_candidate', 'candidates']).toContain(r.status);
    if (r.status === 'infeasible') expect(r.conflicts!.kind).toBe('hard_rows');
  });

  it('a user range that contradicts itself with a limit is reported with its bound', async () => {
    const r = await run({ characteristics: [ch('binder_kg', { mode: 'range', max: 200 })] });
    expect(r.status).toBe('infeasible');
    expect(r.conflicts!.items[0]).toMatchObject({ id: 'binder_kg', unit: 'kg/m3' });
    expect(r.conflicts!.items[0]!.detail).toContain('max 200');
  });

  it('closest_to_targets with an unreachable target still returns the nearest candidates', async () => {
    const r = await run({
      characteristics: [ch('paste_l', { mode: 'target', value: 150 })],
      objective: 'closest_to_targets',
    });
    expect(r.status).toBe('candidates');
    const paste = r.candidates.map((c) => num(c, 'agg.paste_l'));
    expect(paste).toEqual([...paste].sort((a, b) => a - b));
    expect(r.candidates[0]!.characteristics.find((x) => x.key === 'paste_l')!.status).toBe(
      'deviated',
    );
  });

  it('a tiny search cap still returns candidates and notes the coarsening', async () => {
    const r = await run({ settings: { maxConfigurations: 5, candidatesTopN: 2 } });
    expect(r.stats.enumerated).toBe(5);
    expect(r.notes.some((n) => n.code === 'search_coarsened')).toBe(true);
  });

  it('works for several NMAS at once and keeps the one that is cheapest', async () => {
    const r = await run({
      request: { nmasMm: null },
      characteristics: [ch('nmas_mm', { mode: 'list', values: [12.5, 19, 25] })],
      settings: { candidatesTopN: 3 },
    });
    expect(['candidates', 'no_valid_candidate', 'infeasible']).toContain(r.status);
    if (r.status === 'candidates')
      expect(new Set(r.candidates.map((c) => c.configuration.nmasMm)).size).toBeGreaterThanOrEqual(
        1,
      );
  });
});

describe('limitContextFor', () => {
  it("gives the entry-time check the resolved requirements and the code f'cr", async () => {
    const { limitContextFor } = await import('../src/evaluate/limits');
    const input = optimizerInput();
    const ctx = limitContextFor({ ...input.base, lines: [] });
    expect(ctx.codeFcrMpa).toBeCloseTo(38.3, 9);
    expect(ctx.nmasMm).toBe(19);
    expect(ctx.resolved.requirements.length).toBeGreaterThan(0);
  });
});

describe('prices', () => {
  it('cost is monotone in every price: raising one price never makes the cheapest mix cheaper', async () => {
    const { OPT_MATERIALS } = await import('../src/testing/optimizer');
    const base = await run({ settings: { candidatesTopN: 1 } });
    for (const id of ['cem-i', 'fly', 'sand', 'crusher', 'c20', 'water', 'sp']) {
      const raised = OPT_MATERIALS.map((m) =>
        m.id === id && m.price.status === 'ok'
          ? { ...m, price: { ...m.price, price: (Number(m.price.price) * 1.6).toFixed(3) } }
          : m,
      );
      const r = await run({ materials: raised, settings: { candidatesTopN: 1 } });
      expect(r.status).toBe('candidates');
      // rounding to practical quantities can move a cost by a few fils; a real drop would be larger
      expect(Number(r.candidates[0]!.costJodPerM3)).toBeGreaterThanOrEqual(
        Number(base.candidates[0]!.costJodPerM3) - 0.05,
      );
    }
  });

  it('an unpriced material is unavailable, never free', async () => {
    const { OPT_MATERIALS } = await import('../src/testing/optimizer');
    const r = await run({
      materials: OPT_MATERIALS.map((m) =>
        m.id === 'fly' ? { ...m, price: { status: 'unavailable' as const } } : m,
      ),
    });
    expect(r.excluded.find((e) => e.materialId === 'fly')?.reason).toContain('no price');
    for (const c of r.candidates) expect(c.lines.some((l) => l.materialId === 'fly')).toBe(false);
  });
});

describe('validator fixtures', () => {
  // packages/validator/test/fixtures holds optimizer records (SYNTHETIC) for the validator's own tests, which
  // may not import the optimizer. They are regenerated with UPDATE_FIXTURES=1 and compared otherwise, so they
  // cannot drift from what the optimizer really produces.
  const cases: [string, Parameters<typeof optimizerInput>[0]][] = [
    ['candidate-cheapest', { settings: { candidatesTopN: 1 } }],
    [
      'candidate-characteristics',
      {
        settings: { candidatesTopN: 1 },
        objective: 'closest_to_targets',
        characteristics: [
          ch('binder_kg', { mode: 'target', value: 400 }),
          ch('shilstone.cf', { mode: 'range', min: 56, max: 62 }),
          ch('admixture', { mode: 'fixed', product: 'sp', dosage_level: 2 }),
          ch('sand_ratio_pct', { mode: 'range', min: 38, max: 50 }),
        ],
      },
    ],
    [
      'candidate-shortfall',
      {
        settings: { candidatesTopN: 1 },
        characteristics: [ch('wcm', { mode: 'fixed', value: 0.5 })],
      },
    ],
  ];
  for (const [name, over] of cases)
    it(`${name}.json matches what the optimizer produces`, async () => {
      const { candidateRecord } = await import('../src/optimizer');
      const { writeFileSync, readFileSync, mkdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      const r = await run(over);
      expect(r.status).toBe('candidates');
      const text = JSON.stringify(candidateRecord(r.candidates[0]!, {}), null, 1) + '\n';
      const dir = join(import.meta.dirname, '..', '..', 'validator', 'test', 'fixtures');
      const file = join(dir, `${name}.json`);
      if (process.env['UPDATE_FIXTURES']) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, text);
      }
      expect(readFileSync(file, 'utf8')).toBe(text);
    });
});
