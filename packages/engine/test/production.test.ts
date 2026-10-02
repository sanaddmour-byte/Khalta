import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toBatchWeights } from '../src/production/batch';
import type { BatchConfig, BatchDesignLine, MoistureInput } from '../src/production/types';

// SYNTHETIC design, hand-computed below. Values are invented test data.
const DESIGN: BatchDesignLine[] = [
  { materialId: 'cem', category: 'cement', kgSsd: 350 },
  { materialId: 'sand', category: 'fine_agg', kgSsd: 800 },
  { materialId: 'c20', category: 'coarse_agg', kgSsd: 1000 },
  { materialId: 'sp', category: 'admixture', kgSsd: 3.5, solidsPct: 40 },
  { materialId: 'w', category: 'water', kgSsd: 175 },
];
const NOW = '2026-10-02T08:00:00Z';
const CFG: BatchConfig = {
  admixtureSolutionWater: false,
  maxTotalMoisturePct: 15,
  staleHours: 24,
  now: NOW,
};
const M = (over: Partial<MoistureInput>[] = []): MoistureInput[] => [
  {
    materialId: 'sand',
    category: 'fine_agg',
    totalMoisturePct: 5,
    absorptionPct: 1.5,
    measuredAt: '2026-10-02T06:00:00Z',
    ...over[0],
  },
  {
    materialId: 'c20',
    category: 'coarse_agg',
    totalMoisturePct: 0.5,
    absorptionPct: 1,
    measuredAt: '2026-10-02T06:00:00Z',
    ...over[1],
  },
];

describe('toBatchWeights (hand-computed)', () => {
  it('converts SSD to wet weights and adjusts the water', () => {
    const r = toBatchWeights(DESIGN, M(), CFG);
    if (!r.ok) throw new Error('blocked');
    // sand: od = 800/1.015 = 788.177; wet = 788.177×1.05 = 827.586; free = 788.177×0.035 = 27.586
    const sand = r.lines.find((l) => l.materialId === 'sand')!;
    expect(sand.kgOvenDry).toBeCloseTo(788.177, 3);
    expect(sand.kgBatch).toBeCloseTo(827.586, 3);
    expect(sand.freeWaterKg).toBeCloseTo(27.586, 3);
    // c20: od = 1000/1.01 = 990.099; wet = ×1.005 = 995.050; free = ×(0.005−0.01) = −4.950 (drier than SSD)
    const c20 = r.lines.find((l) => l.materialId === 'c20')!;
    expect(c20.kgBatch).toBeCloseTo(995.05, 3);
    expect(c20.freeWaterKg).toBeCloseTo(-4.95, 3);
    // water to add = 175 − (27.586 − 4.950) = 152.364
    expect(r.batchWaterKg).toBeCloseTo(152.364, 3);
    // the batch weighs what the SSD design weighs (no solution water counted)
    expect(r.balance.batchTotalKg).toBeCloseTo(r.balance.ssdTotalKg, 2);
    expect(Math.abs(r.balance.residualKg)).toBeLessThan(0.005);
  });

  it('counts admixture solution water only with the opt-in', () => {
    const on = toBatchWeights(DESIGN, M(), { ...CFG, admixtureSolutionWater: true });
    if (!on.ok) throw new Error('blocked');
    // 3.5 × (1 − 0.40) = 2.1 kg
    expect(on.solutionWaterSubtractedKg).toBeCloseTo(2.1, 3);
    expect(on.batchWaterKg).toBeCloseTo(152.364 - 2.1, 3);
    expect(on.balance.expectedDifferenceKg).toBeCloseTo(-2.1, 3);
    expect(Math.abs(on.balance.residualKg)).toBeLessThan(0.005);
    expect(on.convention.admixtureSolutionWater).toBe(true);
  });

  it('SSD aggregate (total = absorption) changes nothing', () => {
    const r = toBatchWeights(DESIGN, M([{ totalMoisturePct: 1.5 }, { totalMoisturePct: 1 }]), CFG);
    if (!r.ok) throw new Error('blocked');
    expect(r.batchWaterKg).toBeCloseTo(175, 2);
    expect(r.lines.find((l) => l.materialId === 'sand')!.kgBatch).toBeCloseTo(800, 2);
  });
});

describe('rejections are named, never defaulted', () => {
  const codes = (r: ReturnType<typeof toBatchWeights>) =>
    r.ok ? [] : r.blockers.map((b) => `${b.code}:${b.subject}`);
  it('missing QC limits', () => {
    const r = toBatchWeights(DESIGN, M(), { ...CFG, maxTotalMoisturePct: null, staleHours: null });
    expect(codes(r)).toEqual([
      'parameter_missing:eng.moisture.max_total_pct',
      'parameter_missing:eng.moisture.stale_hours',
    ]);
  });
  it('missing reading, impossible, stale, future, missing absorption', () => {
    expect(codes(toBatchWeights(DESIGN, [M()[0]!], CFG))).toEqual(['moisture_missing:c20']);
    expect(codes(toBatchWeights(DESIGN, M([{ totalMoisturePct: 40 }]), CFG))).toEqual([
      'moisture_impossible:sand',
    ]);
    expect(codes(toBatchWeights(DESIGN, M([{ totalMoisturePct: -1 }]), CFG))).toEqual([
      'moisture_impossible:sand',
    ]);
    expect(codes(toBatchWeights(DESIGN, M([{ measuredAt: '2026-09-30T06:00:00Z' }]), CFG))).toEqual(
      ['moisture_stale:sand'],
    );
    expect(codes(toBatchWeights(DESIGN, M([{ measuredAt: '2026-10-03T06:00:00Z' }]), CFG))).toEqual(
      ['moisture_future:sand'],
    );
    expect(codes(toBatchWeights(DESIGN, M([{ absorptionPct: null }]), CFG))).toEqual([
      'absorption_missing:sand',
    ]);
  });
  it('the opt-in needs admixture solids', () => {
    const d = DESIGN.map((l) => (l.category === 'admixture' ? { ...l, solidsPct: null } : l));
    expect(codes(toBatchWeights(d, M(), { ...CFG, admixtureSolutionWater: true }))).toEqual([
      'solids_missing:sp',
    ]);
  });
});

describe('properties', () => {
  const arb = fc.record({
    sand: fc.double({ min: 0, max: 14, noNaN: true }),
    c20: fc.double({ min: 0, max: 14, noNaN: true }),
    absS: fc.double({ min: 0, max: 5, noNaN: true }),
    absC: fc.double({ min: 0, max: 5, noNaN: true }),
    opt: fc.boolean(),
  });
  const run = (
    v: fc.GeneratorValue extends never
      ? never
      : { sand: number; c20: number; absS: number; absC: number; opt: boolean },
  ) =>
    toBatchWeights(
      DESIGN,
      M([
        { totalMoisturePct: v.sand, absorptionPct: v.absS },
        { totalMoisturePct: v.c20, absorptionPct: v.absC },
      ]),
      { ...CFG, admixtureSolutionWater: v.opt },
    );
  it('the mass balance closes for any inputs', () => {
    fc.assert(
      fc.property(arb, (v) => {
        const r = run(v);
        if (!r.ok) return true;
        return Math.abs(r.balance.residualKg) < 0.01;
      }),
    );
  });
  it('drier than SSD gives negative free water; wetter gives positive', () => {
    fc.assert(
      fc.property(arb, (v) => {
        const r = run(v);
        if (!r.ok) return true;
        const s = r.lines.find((l) => l.materialId === 'sand')!.freeWaterKg!;
        return v.sand < v.absS ? s <= 0 : v.sand > v.absS ? s >= 0 : Math.abs(s) < 1e-3;
      }),
    );
  });
  it('batch water falls as moisture rises', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 7, noNaN: true }),
        fc.double({ min: 0.01, max: 7, noNaN: true }),
        (m, d) => {
          const lo = toBatchWeights(DESIGN, M([{ totalMoisturePct: m }]), CFG);
          const hi = toBatchWeights(DESIGN, M([{ totalMoisturePct: m + d }]), CFG);
          return !lo.ok || !hi.ok || hi.batchWaterKg <= lo.batchWaterKg + 1e-9;
        },
      ),
    );
  });
  it('round trip: batch → remove free moisture → SSD', () => {
    fc.assert(
      fc.property(arb, (v) => {
        const r = run(v);
        if (!r.ok) return true;
        return r.lines
          .filter((l) => l.freeWaterKg !== null)
          .every((l) => Math.abs(l.kgBatch - l.freeWaterKg! - l.kgSsd) < 0.002);
      }),
    );
  });
});
