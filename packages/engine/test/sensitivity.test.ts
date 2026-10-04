import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { priceSensitivity, type SensitivityCandidate } from '../src/optimizer';

const cand = (id: string, rank: number, cement: number, scm: number): SensitivityCandidate => ({
  id,
  rank,
  lines: [
    { materialId: 'cement', jod: cement },
    { materialId: 'scm', jod: scm },
    { materialId: 'agg', jod: 10 },
  ],
});
// A is cheapest (50+5+10 = 65); B leans on SCM (40+20+10 = 70); C is dearest (60+10+10 = 80)
const SET = [cand('A', 1, 50, 5), cand('B', 2, 40, 20), cand('C', 3, 60, 10)];

describe('price sensitivity', () => {
  it('never re-solves and reports the baseline ranking', () => {
    const r = priceSensitivity(SET, [0.1]);
    expect(r.reSolved).toBe(false);
    expect(r.baseline.ranking).toEqual(['A', 'B', 'C']);
    expect(r.baseline.costs).toEqual({ A: 65, B: 70, C: 80 });
  });

  it('re-prices each candidate for a one-material change and says when the top changes', () => {
    const r = priceSensitivity(SET, [-0.5, 0.5]);
    const cementUp = r.scenarios.find((s) => s.materialId === 'cement' && s.change === 0.5)!;
    // cement +50 %: A = 90, B = 90, C = 110 → tie broken by rank, A stays first
    expect(cementUp.costs).toEqual({ A: 90, B: 90, C: 110 });
    expect(cementUp.topChanged).toBe(false);
    const scmUp = r.scenarios.find((s) => s.materialId === 'scm' && s.change === 0.5)!;
    expect(scmUp.costs.B).toBe(80);
    const cementDown = r.scenarios.find((s) => s.materialId === 'cement' && s.change === -0.5)!;
    expect(cementDown.ranking[0]).toBe('A'); // A = 25 + 5 + 10 = 40, B = 20 + 20 + 10 = 50
  });

  it('the break-even is exact: the ranking flips just beyond it and not before', () => {
    const r = priceSensitivity(SET, [0]);
    const be = r.breakeven.find((b) => b.materialId === 'cement')!;
    // A(δ) = 65 + 50δ ; B(δ) = 70 + 40δ → equal at δ = 0.5
    expect(be.change).toBeCloseTo(0.5, 3);
    expect(be.overtakenBy).toBe('B');
    const before = priceSensitivity(SET, [be.change! - 0.01]).scenarios.find(
      (s) => s.materialId === 'cement',
    )!;
    const after = priceSensitivity(SET, [be.change! + 0.01]).scenarios.find(
      (s) => s.materialId === 'cement',
    )!;
    expect(before.topChanged).toBe(false);
    expect(after.topChanged).toBe(true);
  });

  it('a material every candidate uses equally can never change the ranking', () => {
    const be = priceSensitivity(SET, [0]).breakeven.find((b) => b.materialId === 'agg')!;
    expect(be.change).toBeNull();
  });

  it('property: break-even flips the winner exactly where the algebra says, for random candidate sets', () => {
    const arb = fc
      .array(fc.tuple(fc.integer({ min: 20, max: 90 }), fc.integer({ min: 1, max: 40 })), {
        minLength: 2,
        maxLength: 6,
      })
      .map((xs) => xs.map(([c, s], i) => cand(`K${i}`, i + 1, c, s)));
    fc.assert(
      fc.property(arb, (cs) => {
        const r = priceSensitivity(cs, [0]);
        const totals = Object.values(r.baseline.costs);
        fc.pre(new Set(totals).size === totals.length); // a baseline tie is decided by rank, not by price
        for (const b of r.breakeven) {
          if (b.change === null) continue;
          const eps = Math.max(0.002, Math.abs(b.change) * 0.002);
          const below = priceSensitivity(cs, [b.change - Math.sign(b.change) * eps]).scenarios.find(
            (s) => s.materialId === b.materialId,
          )!;
          const above = priceSensitivity(cs, [b.change + Math.sign(b.change) * eps]).scenarios.find(
            (s) => s.materialId === b.materialId,
          )!;
          // the cheapest candidate at the baseline is not the cheapest at the far side of the crossing
          expect(above.ranking[0] !== r.baseline.ranking[0] || above.topChanged).toBe(true);
          expect(below.ranking[0]).toBe(r.baseline.ranking[0]);
        }
      }),
      { numRuns: 200 },
    );
  });
});
