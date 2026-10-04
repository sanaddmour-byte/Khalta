import { describe, expect, it } from 'vitest';
import type { BatchConfig, BatchDesignLine, MoistureInput, PlanConfig } from '@khalta/engine';
import { planBatch } from '../../engine/src/production/plan';
import { toBatchWeights } from '../../engine/src/production/batch';
import { validatePlan } from '../src/plan';

// SYNTHETIC inputs (test data only). The production modules are imported here, in the TEST, to build a plan to check;
// the validator itself never imports them (the boundary rule covers src only).
const DESIGN: BatchDesignLine[] = [
  { materialId: 'cem', category: 'cement', kgSsd: 350 },
  { materialId: 'sand', category: 'fine_agg', kgSsd: 800 },
  { materialId: 'w', category: 'water', kgSsd: 175 },
];
const CFG: BatchConfig = {
  admixtureSolutionWater: false,
  maxTotalMoisturePct: 15,
  staleHours: 24,
  now: '2026-10-02T08:00:00Z',
};
const M: MoistureInput[] = [
  {
    materialId: 'sand',
    category: 'fine_agg',
    totalMoisturePct: 5,
    absorptionPct: 1.5,
    measuredAt: '2026-10-02T06:00:00Z',
  },
];
const PLAN: PlanConfig = {
  batchSizeM3: 3,
  resolutionKg: { cement: 5, fine_agg: 10, water: 1 },
  maxRoundingDeviationPct: 1,
  maxBatchSizeM3: 6,
};
const build = () => {
  const c = toBatchWeights(DESIGN, M, CFG);
  if (!c.ok) throw new Error('blocked');
  const p = planBatch(c, PLAN);
  if (!p.ok) throw new Error(JSON.stringify(p.blockers));
  return { c, p };
};

describe('independent batch-plan check', () => {
  it('agrees with a correct plan', () => {
    const { c, p } = build();
    expect(validatePlan(c, PLAN, p)).toMatchObject({ status: 'pass', mismatches: [] });
  });
  it('catches a mass that is not the nearest whole step, one that is not a multiple, and wrong totals', () => {
    const { c, p } = build();
    const wrongStep = structuredClone(p);
    wrongStep.lines[1]!.roundedKg += 10; // a whole step, but not the nearest
    expect(validatePlan(c, PLAN, wrongStep).mismatches.map((m) => m.key)).toContain(
      'line2.rounded',
    );
    const offGrid = structuredClone(p);
    offGrid.lines[1]!.roundedKg += 3;
    expect(validatePlan(c, PLAN, offGrid).status).toBe('fail');
    const wrongTotal = structuredClone(p);
    wrongTotal.reconciliation.roundedTotalKg += 5;
    expect(validatePlan(c, PLAN, wrongTotal).mismatches.map((m) => m.key)).toContain(
      'rounded_total',
    );
  });
  it('catches a plan built for another batch size or from other corrected quantities', () => {
    const { c, p } = build();
    expect(validatePlan(c, { ...PLAN, batchSizeM3: 4 }, p).mismatches.map((m) => m.key)).toContain(
      'batch_size',
    );
    const tampered = structuredClone(p);
    tampered.lines[0]!.correctedKgPerM3 += 1;
    expect(validatePlan(c, PLAN, tampered).mismatches.map((m) => m.key)).toContain(
      'line1.corrected',
    );
  });
  it('accepts a refusal only when something really is missing, and rejects a wrongful refusal', () => {
    const { c } = build();
    const missing = { ...PLAN, maxBatchSizeM3: null };
    const refused = planBatch(c, missing);
    expect(refused.ok).toBe(false);
    expect(validatePlan(c, missing, refused).status).toBe('pass');
    const wrongful = planBatch(c, { ...PLAN, maxBatchSizeM3: null });
    expect(validatePlan(c, PLAN, wrongful).status).toBe('fail'); // PLAN has everything: a refusal is wrong
  });
});
