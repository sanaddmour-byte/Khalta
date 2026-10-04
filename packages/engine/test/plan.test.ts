import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { planBatch, roundToResolution } from '../src/production/plan';
import { toBatchWeights } from '../src/production/batch';
import type {
  BatchConfig,
  BatchDesignLine,
  MoistureInput,
  PlanConfig,
} from '../src/production/types';

// SYNTHETIC design and SYNTHETIC equipment parameters: invented test data, not a plant's values.
const DESIGN: BatchDesignLine[] = [
  { materialId: 'cem', category: 'cement', kgSsd: 350 },
  { materialId: 'sand', category: 'fine_agg', kgSsd: 800 },
  { materialId: 'c20', category: 'coarse_agg', kgSsd: 1000 },
  { materialId: 'sp', category: 'admixture', kgSsd: 3.5, solidsPct: 40 },
  { materialId: 'w', category: 'water', kgSsd: 175 },
];
const CFG: BatchConfig = {
  admixtureSolutionWater: false,
  maxTotalMoisturePct: 15,
  staleHours: 24,
  now: '2026-10-02T08:00:00Z',
};
const MOISTURE: MoistureInput[] = [
  {
    materialId: 'sand',
    category: 'fine_agg',
    totalMoisturePct: 5,
    absorptionPct: 1.5,
    measuredAt: '2026-10-02T06:00:00Z',
  },
  {
    materialId: 'c20',
    category: 'coarse_agg',
    totalMoisturePct: 0.5,
    absorptionPct: 1,
    measuredAt: '2026-10-02T06:00:00Z',
  },
];
const conversion = () => {
  const r = toBatchWeights(DESIGN, MOISTURE, CFG);
  if (!r.ok) throw new Error('blocked');
  return r;
};
const PLAN: PlanConfig = {
  batchSizeM3: 2.5,
  resolutionKg: { cement: 5, fine_agg: 10, coarse_agg: 10, water: 1, admixture: 0.1 },
  maxRoundingDeviationPct: 1,
  maxBatchSizeM3: 6,
};

describe('roundToResolution', () => {
  it('rounds half up to a multiple, without float noise', () => {
    expect(roundToResolution(8.75, 0.1)).toBe(8.8);
    expect(roundToResolution(2068.965, 10)).toBe(2070);
    expect(roundToResolution(0.3, 0.1)).toBe(0.3);
    expect(roundToResolution(1.005, 0.001)).toBe(1.005);
  });
  it('property: the result is a whole number of steps and within half a step of the input', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 5000, noNaN: true }),
        fc.constantFrom(0.01, 0.1, 0.5, 1, 2, 5, 10, 25),
        (x, res) => {
          const y = roundToResolution(x, res);
          expect(Math.abs(y - x)).toBeLessThanOrEqual(res / 2 + 1e-6);
          const steps = y / res;
          expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6);
        },
      ),
    );
  });
});

describe('planBatch (hand-computed)', () => {
  it('weighs the corrected quantities for the batch size, rounded to each hopper, and reconciles to the design', () => {
    // corrected per m³ (from the conversion): sand 827.586, c20 995.050, water 152.364, cement 350, admixture 3.5
    const p = planBatch(conversion(), PLAN);
    if (!p.ok) throw new Error(JSON.stringify(p.blockers));
    const by = (id: string) => p.lines.find((l) => l.materialId === id)!;
    expect(by('sand')).toMatchObject({
      designKgPerM3: 800,
      correctedKgPerM3: 827.586,
      resolutionKg: 10,
      roundedKg: 2070,
    });
    expect(by('sand').exactKg).toBeCloseTo(2068.965, 3);
    expect(by('c20').roundedKg).toBe(2490); // 2487.625 → nearest 10
    expect(by('cem')).toMatchObject({ exactKg: 875, roundedKg: 875, errorKg: 0 });
    expect(by('w').roundedKg).toBe(381); // 380.91
    expect(by('sp').roundedKg).toBe(8.8); // 8.75 → half up
    // the reference design and the corrected batch weigh the same (no solution water counted)
    expect(p.reconciliation.designTotalKg).toBeCloseTo((350 + 800 + 1000 + 3.5 + 175) * 2.5, 3);
    expect(p.reconciliation.exactMinusDesignKg).toBeCloseTo(0, 2);
    expect(p.reconciliation.roundedMinusExactKg).toBeCloseTo(
      p.lines.reduce((s, l) => s + l.errorKg, 0),
      5,
    );
    expect(p.reconciliation.maxLineDeviationPct).toBeCloseTo(0.571, 2); // the admixture
  });

  it('blocks, naming each, when an equipment parameter is not on file', () => {
    const p = planBatch(conversion(), {
      ...PLAN,
      resolutionKg: { cement: 5, fine_agg: null, coarse_agg: 10, water: 1 },
      maxRoundingDeviationPct: null,
      maxBatchSizeM3: null,
    });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.blockers.map((b) => b.subject).sort()).toEqual(
      [
        'eng.batch.max_rounding_deviation_pct',
        'eng.batch.max_size_m3',
        'eng.batch.resolution_kg.admixture',
        'eng.batch.resolution_kg.fine_agg',
      ].sort(),
    );
    expect(p.blockers.every((b) => b.code === 'parameter_missing')).toBe(true);
  });

  it('refuses a batch larger than the mixer, a non-positive size, and a rounding beyond the tolerance', () => {
    const big = planBatch(conversion(), { ...PLAN, batchSizeM3: 7 });
    expect(!big.ok && big.blockers[0]!.code).toBe('batch_size_over_limit');
    for (const size of [0, -1, Number.NaN]) {
      const bad = planBatch(conversion(), { ...PLAN, batchSizeM3: size });
      expect(!bad.ok && bad.blockers[0]!.code).toBe('batch_size_invalid');
    }
    const tight = planBatch(conversion(), { ...PLAN, maxRoundingDeviationPct: 0.5 });
    expect(tight.ok).toBe(false);
    if (!tight.ok) {
      const dev = tight.blockers.find((b) => b.code === 'rounding_deviation_exceeded')!;
      expect(dev.subject).toBe('sp');
      expect(dev.detail).toMatch(/smaller batch or a finer hopper/);
    }
  });

  it('property: every rounded mass is a whole number of steps within half a step, and totals follow from the lines', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.5, max: 6, noNaN: true }), (size) => {
        const p = planBatch(conversion(), {
          ...PLAN,
          batchSizeM3: size,
          maxRoundingDeviationPct: 100,
        });
        if (!p.ok) throw new Error('unexpected block');
        for (const l of p.lines) {
          expect(Math.abs(l.errorKg)).toBeLessThanOrEqual(l.resolutionKg / 2 + 1e-6);
          const steps = l.roundedKg / l.resolutionKg;
          expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6);
        }
        expect(p.reconciliation.roundedTotalKg).toBeCloseTo(
          p.lines.reduce((s, l) => s + l.roundedKg, 0),
          4,
        );
      }),
    );
  });
});
