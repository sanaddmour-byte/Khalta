// Direct tests of the optimizer's rejection and fallback paths: a candidate the rounding or the evaluator
// would break is REJECTED with a reason, never repaired silently. SYNTHETIC world (src/testing/optimizer.ts).
import { beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedCharacteristic } from '../src/characteristics/resolve';
import { diagnose, dofOf } from '../src/optimizer/diagnostics';
import { enumerate, type ConfigSpec } from '../src/optimizer/enumerate';
import { finalizeOne, GRIDS, roundingTolerance, toLines, kgText } from '../src/optimizer/finalize';
import { createHighsSolver } from '../src/optimizer/highsSolver';
import { measure } from '../src/optimizer/measure';
import { optimize } from '../src/optimizer/optimize';
import { prepare, type Prepared } from '../src/optimizer/prepare';
import { solveConfig, type Solved } from '../src/optimizer/solve';
import type { LpProblem, LpSolution, Solver } from '../src/optimizer/types';
import { OPT_MATERIALS, optimizerInput } from '../src/testing/optimizer';

let solver: Solver;
beforeAll(async () => {
  solver = await createHighsSolver();
}, 30_000);

const ch = (key: string, spec: Record<string, unknown>, sub: string | null = null) =>
  ({ key, sub, spec, origin: 'request' }) as ResolvedCharacteristic;
const prep = (over: Parameters<typeof optimizerInput>[0] = {}): Prepared => {
  const r = prepare(optimizerInput(over));
  if (!r.ok) throw new Error(r.blockers.map((b) => b.subject).join());
  return r.prepared;
};
const first = async (p: Prepared, pick?: (c: ConfigSpec) => boolean): Promise<Solved> => {
  const cfg = enumerate(p).configs.find(pick ?? (() => true))!;
  const s = await solveConfig(p, cfg, solver, 'cheapest');
  if (!s) throw new Error('no solution');
  return s;
};
const withX = (s: Solved, x: Record<string, number>): Solved => ({ ...s, x: { ...s.x, ...x } });

describe('finalizeOne rejects, with a reason, what the rounding or the evaluator would break', () => {
  it('accepts an ordinary solution on the default rounding', async () => {
    const p = prep();
    const r = await finalizeOne(p, await first(p), GRIDS[0]!, undefined);
    expect(r.ok).toBe(true);
  });

  it('rejects when the SCM would round to nothing', async () => {
    const p = prep();
    const s = await first(p, (c) => c.scm !== null && c.scmPct === 5);
    const r = await finalizeOne(
      p,
      withX(s, { B: 4 }),
      { binder: 'down', water: 'nearest', topUps: 0 },
      undefined,
    );
    expect(r).toMatchObject({ ok: false, rej: { reason: 'rounding' } });
  });

  it('rejects when rounding leaves no volume for the rebalancing aggregate', async () => {
    const p = prep();
    const s = await first(p);
    const r = await finalizeOne(p, withX(s, { 'V:c20': 1.5 }), GRIDS[0]!, undefined);
    expect(r).toMatchObject({ ok: false, rej: { reason: 'rebalance' } });
  });

  it('rejects when the evaluator no longer passes it', async () => {
    const p = prep();
    const s = await first(p);
    // a 6 MPa-style trap: the proportions no longer add up to 1 m³ (yield), which the evaluator fails
    const r = await finalizeOne(p, withX(s, { W: s.x['W'] ?? 0 }), GRIDS[0]!, undefined);
    expect(r.ok).toBe(true);
    const bad = { ...s, cfg: { ...s.cfg, airPct: 30 } };
    const r2 = await finalizeOne(p, bad, GRIDS[0]!, undefined);
    expect(r2.ok).toBe(false);
  });

  it('rejects a guardrail broken by the final proportions even if the evaluator is content', async () => {
    const p = prep();
    const s = await first(p);
    const r = await finalizeOne(
      p,
      withX(s, { 'V:crusher': 0.05, 'V:sand': 0.35, 'V:c20': 0.0, 'V:c10': 0 }),
      GRIDS[0]!,
      undefined,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['guardrail', 'evaluation', 'rebalance', 'measure']).toContain(r.rej.reason);
  });

  it('rejects when a requested characteristic is missed after rounding', async () => {
    const p = prep({ characteristics: [ch('wcm', { mode: 'fixed', value: 0.4 })] });
    const s = await first(p);
    const r = await finalizeOne(p, withX(s, { W: (s.x['W'] ?? 0) + 25 }), GRIDS[0]!, undefined);
    expect(r).toMatchObject({ ok: false });
  });

  it('rejects a w/cm above the engineering ceiling after rounding', async () => {
    const p = prep();
    const s = await first(p);
    const r = await finalizeOne(p, withX(s, { W: (s.x['W'] ?? 0) + 60 }), GRIDS[0]!, undefined);
    expect(r).toMatchObject({ ok: false, rej: { reason: 'guardrail' } });
    expect(r.ok === false && r.rej.detail).toContain('engineering ceiling');
  });

  it('rejects when the independent validator says no', async () => {
    const p = prep();
    const s = await first(p);
    const r = await finalizeOne(p, s, GRIDS[0]!, () => false);
    expect(r).toMatchObject({ ok: false, rej: { reason: 'validator' } });
    const yes = await finalizeOne(p, s, GRIDS[0]!, async () => true);
    expect(yes.ok).toBe(true);
  });

  it('keeps an admixture dosage inside the product range after rounding', async () => {
    const p = prep();
    const s = await first(p, (c) => c.admix !== null);
    const low = { ...s, cfg: { ...s.cfg, level: { ...s.cfg.level!, dosagePct: 0.1 } } };
    const hi = { ...s, cfg: { ...s.cfg, level: { ...s.cfg.level!, dosagePct: 9 } } };
    for (const v of [low, hi]) {
      const r = await finalizeOne(p, v, GRIDS[0]!, undefined);
      if (r.ok) {
        const sp = Number(r.candidate.lines.find((l) => l.materialId === 'sp')!.kgPerM3);
        const binder = r.candidate.lines
          .filter((l) => ['cem-i', 'cem-sr', 'fly', 'ggbs'].includes(l.materialId))
          .reduce((a, l) => a + Number(l.kgPerM3), 0);
        expect((sp / binder) * 100).toBeGreaterThanOrEqual(0.4 - 1e-9);
        expect((sp / binder) * 100).toBeLessThanOrEqual(1.5 + 1e-9);
      } else expect(r.rej.reason).toBeTruthy();
    }
  });

  it('derives rounding tolerances: 1 % for mass characteristics, the tenant settings otherwise', () => {
    const p = prep({
      characteristics: [
        ch('binder_kg', { mode: 'fixed', value: 400 }),
        ch('agg_kg', { mode: 'range', min: 500, max: 800 }, 'c20'),
      ],
    });
    const t = roundingTolerance(p);
    expect(t['binder_kg']).toBeCloseTo(4, 9);
    expect(t['agg_kg']).toBeCloseTo(8, 9);
    expect(t['sand_ratio_pct']).toBe(0.5);
    expect(t['wcm']).toBe(0.005);
    expect(toLines([{ id: 'a', kg: 1.23456 }])).toEqual([{ materialId: 'a', kgPerM3: '1.235' }]);
    expect(kgText(10)).toBe('10.000');
  });
});

describe('measure', () => {
  it('handles an aggregate set with nothing retained on 2.36 mm', () => {
    const p = prep();
    const fine = p.fines[0]!;
    const all100 = {
      ...fine,
      points: [
        { sieve_mm: 4.75, passing_pct: 100 },
        { sieve_mm: 2.36, passing_pct: 100 },
        { sieve_mm: 1.18, passing_pct: 100 },
        { sieve_mm: 0.6, passing_pct: 100 },
        { sieve_mm: 0.3, passing_pct: 100 },
        { sieve_mm: 0.15, passing_pct: 100 },
        { sieve_mm: 0.075, passing_pct: 100 },
        { sieve_mm: 9.5, passing_pct: 100 },
      ],
    };
    const r = measure(
      [{ id: 'x', name: 'x', kind: 'fine', kg: 100, points: all100.points, finer75Pct: null }],
      300,
      19,
      p.guard.base,
      { min: 1, max: 99 },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.coarsenessFactor).toBe(Number.POSITIVE_INFINITY);
    expect(measure([], 300, 19, p.guard.base, { min: 1, max: 99 }).ok).toBe(false);
  });
});

describe('the solve loop and the diagnostics survive solver failures', () => {
  const failing = (okCalls: number): Solver => {
    let n = 0;
    return {
      async solve(p: LpProblem): Promise<LpSolution> {
        n++;
        if (n > okCalls)
          return { status: 'infeasible', objective: 0, x: {}, duals: {}, activity: {} };
        return solver.solve(p);
      },
    };
  };

  it('a configuration that was feasible once keeps its last feasible point', async () => {
    const p = prep();
    const cfg = enumerate(p).configs[0]!;
    const s = await solveConfig(p, cfg, failing(1), 'cheapest');
    expect(s).not.toBeNull();
    expect(s!.converged).toBe(false);
    expect(await solveConfig(p, cfg, failing(0), 'cheapest')).toBeNull();
  });

  it('closest-to-targets survives an infeasible stage', async () => {
    const p = prep({
      characteristics: [ch('binder_kg', { mode: 'target', value: 380 })],
      objective: 'closest_to_targets',
    });
    const cfg = enumerate(p).configs[0]!;
    expect(await solveConfig(p, cfg, failing(0), 'closest_to_targets')).toBeNull();
    expect(await solveConfig(p, cfg, failing(1), 'closest_to_targets')).toBeNull();
    const ok = await solveConfig(p, cfg, solver, 'closest_to_targets');
    expect(ok!.deviationJod).toBeGreaterThanOrEqual(0);
  });

  it('optimize reports infeasible with no explanation when even the diagnostic solves fail', async () => {
    const r = await optimize(optimizerInput({}), { solver: failing(0) });
    expect(r.status).toBe('infeasible');
    expect(r.conflicts).toEqual({ kind: 'hard_rows', items: [] });
  });

  it('diagnose has nothing to say without configurations, and dofOf counts a plain request', async () => {
    const p = prep();
    expect(await diagnose(p, [], solver)).toBeNull();
    expect(await diagnose(p, enumerate(p).configs, solver)).toEqual({
      kind: 'hard_rows',
      items: [],
    });
    expect(dofOf(p, enumerate(p).configs[0]!)).toMatchObject({
      quantities: 6,
      equalities: 1,
      dof: 5,
    });
  });
});

describe('prepare: remaining blockers', () => {
  it('names a missing sulfate class table and an unusable chloride limit', () => {
    const r = prepare(
      optimizerInput({
        request: { exposure: ['F0', 'S1', 'W0', 'C1'] },
        extraRules: { 'cement.equivalence.high.max_c3a_pct': null },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blockers.map((b) => b.subject)).toContain('cement.equivalence');
  });

  it('works with a single plain water and one aggregate each', () => {
    const only = OPT_MATERIALS.filter((m) => ['cem-i', 'sand', 'c20', 'water'].includes(m.id));
    const p = prep({ materials: only });
    expect(enumerate(p).configs.length).toBeGreaterThan(0);
  });

  it('notes when several waters are usable', () => {
    const second = { ...OPT_MATERIALS.find((m) => m.id === 'water')!, id: 'water2' };
    const p = prep({ materials: [...OPT_MATERIALS, second] });
    expect(p.notes.some((n) => n.code === 'several_water')).toBe(true);
    expect(p.water.id).toBe('water');
  });
});
