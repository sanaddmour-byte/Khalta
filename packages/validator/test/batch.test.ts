import { describe, expect, it } from 'vitest';
import type { BatchConfig, BatchDesignLine, BatchResult, MoistureInput } from '@khalta/engine';
import { validateBatch } from '../src/batch';

// SYNTHETIC. The reported result is written out by hand (not produced by the conversion code), so the validator is
// checked against numbers worked on paper: sand wet 827.586, free 27.586; c20 wet 995.050, free −4.950; water 152.364.
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
const MOIST: MoistureInput[] = [
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
const good = (): Extract<BatchResult, { ok: true }> => ({
  ok: true,
  lines: [
    {
      materialId: 'cem',
      category: 'cement',
      kgSsd: 350,
      kgOvenDry: null,
      kgBatch: 350,
      freeWaterKg: null,
      solutionWaterKg: null,
    },
    {
      materialId: 'sand',
      category: 'fine_agg',
      kgSsd: 800,
      kgOvenDry: 788.177,
      kgBatch: 827.586,
      freeWaterKg: 27.586,
      solutionWaterKg: null,
    },
    {
      materialId: 'c20',
      category: 'coarse_agg',
      kgSsd: 1000,
      kgOvenDry: 990.099,
      kgBatch: 995.05,
      freeWaterKg: -4.95,
      solutionWaterKg: null,
    },
    {
      materialId: 'sp',
      category: 'admixture',
      kgSsd: 3.5,
      kgOvenDry: null,
      kgBatch: 3.5,
      freeWaterKg: null,
      solutionWaterKg: null,
    },
    {
      materialId: 'w',
      category: 'water',
      kgSsd: 175,
      kgOvenDry: null,
      kgBatch: 152.364,
      freeWaterKg: null,
      solutionWaterKg: null,
    },
  ],
  designWaterKg: 175,
  freeWaterFromAggregatesKg: 22.636,
  solutionWaterSubtractedKg: 0,
  batchWaterKg: 152.364,
  balance: { ssdTotalKg: 2328.5, batchTotalKg: 2328.5, expectedDifferenceKg: 0, residualKg: 0 },
  trace: [],
  convention: { admixtureSolutionWater: false },
});
const keys = (r: BatchResult, cfg = CFG, m = MOIST) =>
  validateBatch(DESIGN, m, cfg, r).mismatches.map((x) => x.key);

describe('validateBatch', () => {
  it('agrees with a correct conversion', () => {
    expect(validateBatch(DESIGN, MOIST, CFG, good()).status).toBe('pass');
  });
  it('detects a wrong wet mass, a wrong water, a sign error and a broken balance', () => {
    const a = good();
    a.lines[1]!.kgBatch = 800; // forgot the moisture
    expect(keys(a)).toContain('sand.kgBatch');
    const b = good();
    b.batchWaterKg = 175;
    b.lines[4]!.kgBatch = 175; // forgot to deduct aggregate water
    expect(keys(b)).toEqual(expect.arrayContaining(['batchWaterKg', 'water.kgBatch']));
    const c = good();
    c.lines[2]!.freeWaterKg = 4.95; // sign flipped for the drier-than-SSD aggregate
    expect(keys(c)).toContain('c20.freeWaterKg');
    const d = good();
    d.balance.residualKg = 3;
    expect(keys(d)).toContain('balance.residualKg');
  });
  it('conflates wet and SSD mass? it notices', () => {
    const a = good();
    a.lines[1]!.kgSsd = 827.586; // wet mass reported as the SSD quantity
    expect(keys(a)).toContain('sand.kgSsd');
  });
  it('agrees when the solution-water convention is on and applied', () => {
    const r = good();
    r.solutionWaterSubtractedKg = 2.1;
    r.batchWaterKg = 150.264;
    r.lines[4]!.kgBatch = 150.264;
    r.balance = {
      ssdTotalKg: 2328.5,
      batchTotalKg: 2326.4,
      expectedDifferenceKg: -2.1,
      residualKg: 0,
    };
    r.convention = { admixtureSolutionWater: true };
    expect(validateBatch(DESIGN, MOIST, { ...CFG, admixtureSolutionWater: true }, r).status).toBe(
      'pass',
    );
    // the same numbers under the other convention are a mismatch
    expect(keys(r)).toContain('convention');
  });
  it('refuses weights that should have been blocked, and blocks only for a reason', () => {
    expect(keys(good(), { ...CFG, staleHours: null })).toContain('should_have_blocked');
    const stale = MOIST.map((m) => ({ ...m, measuredAt: '2026-09-29T06:00:00Z' }));
    expect(keys(good(), CFG, stale)).toContain('should_have_blocked');
    const blocked: BatchResult = {
      ok: false,
      blockers: [{ code: 'parameter_missing', subject: 'x', detail: '' }],
    };
    expect(validateBatch(DESIGN, MOIST, { ...CFG, staleHours: null }, blocked).status).toBe('pass');
    expect(keys(blocked)).toContain('blocked_without_reason');
  });
});
