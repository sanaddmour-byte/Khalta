// Independent check of a batch plan (docs/calc/batch-moisture.md §5). Own arithmetic in integer micro-kilograms,
// written differently from the plan: every weighed mass must be a whole number of resolution steps and the nearest
// one; the totals and the reconciliation must follow from the lines; every deviation must be inside the tolerance;
// the corrected quantities must be those of the batch conversion it was built from. Imports only the production TYPES.
import type {
  BatchMismatch,
  BatchPlan,
  BatchResult,
  PlanConfig,
  PlanValidation,
} from '@khalta/engine';

export const PLAN_VALIDATOR_VERSION = '1.0.0';
const U = 1_000_000; // micro-kilograms
const TOL_U = 2; // two micro-kilograms: the plan rounds to 1e-6 kg

export function validatePlan(
  conversion: Extract<BatchResult, { ok: true }>,
  cfg: PlanConfig,
  plan: BatchPlan,
): PlanValidation {
  const mismatches: BatchMismatch[] = [];
  const add = (key: string, reported: unknown, recomputed: unknown) =>
    mismatches.push({ key, reported, recomputed });
  const done = (): PlanValidation => ({
    validatorVersion: PLAN_VALIDATOR_VERSION,
    status: mismatches.length === 0 ? 'pass' : 'fail',
    mismatches,
  });
  if (!plan.ok) {
    // a refused plan is right only if something really is missing or out of range
    const missing =
      cfg.maxBatchSizeM3 === null ||
      cfg.maxRoundingDeviationPct === null ||
      !(cfg.batchSizeM3 > 0) ||
      conversion.lines.some((l) => !((cfg.resolutionKg[l.category] ?? 0) > 0)) ||
      cfg.batchSizeM3 > (cfg.maxBatchSizeM3 ?? Infinity);
    if (!missing && plan.blockers.every((b) => !b.code.endsWith('exceeded')))
      add('refused', true, false);
    return done();
  }
  if (plan.batchSizeM3 !== cfg.batchSizeM3) add('batch_size', plan.batchSizeM3, cfg.batchSizeM3);
  if (plan.lines.length !== conversion.lines.length) {
    add('line_count', plan.lines.length, conversion.lines.length);
    return done();
  }
  const sizeU = Math.round(cfg.batchSizeM3 * U);
  let exactSum = 0;
  let roundedSum = 0;
  let designSum = 0;
  let worst = 0;
  conversion.lines.forEach((c, i) => {
    const p = plan.lines[i]!;
    const key = `line${i + 1}`;
    if (p.materialId !== c.materialId) add(`${key}.material`, p.materialId, c.materialId);
    const resU = Math.round(((cfg.resolutionKg[c.category] ?? 0) as number) * U);
    // kg per m³ × m³, in micro-kilograms
    const exactFromU = (Math.round(c.kgBatch * U) * sizeU) / U;
    if (Math.abs(p.exactKg * U - exactFromU) > TOL_U + 1)
      add(`${key}.exact`, p.exactKg, exactFromU / U);
    if (resU > 0) {
      const steps = Math.round(exactFromU / resU);
      const nearestU = steps * resU;
      const roundedU = Math.round(p.roundedKg * U);
      if (Math.abs(roundedU - nearestU) > TOL_U) add(`${key}.rounded`, p.roundedKg, nearestU / U);
      if (Math.abs(roundedU % resU) > TOL_U && Math.abs((roundedU % resU) - resU) > TOL_U)
        add(`${key}.multiple_of_resolution`, p.roundedKg, resolutionNote(resU));
      const dev = exactFromU === 0 ? 0 : (Math.abs(roundedU - exactFromU) / exactFromU) * 100;
      worst = Math.max(worst, dev);
      if (cfg.maxRoundingDeviationPct !== null && dev > cfg.maxRoundingDeviationPct + 1e-6)
        add(`${key}.deviation_within_tolerance`, p.deviationPct, cfg.maxRoundingDeviationPct);
      roundedSum += roundedU;
    }
    exactSum += exactFromU;
    designSum += Math.round(c.kgSsd * U) * (sizeU / U);
    if (p.designKgPerM3 !== c.kgSsd) add(`${key}.design`, p.designKgPerM3, c.kgSsd);
    if (p.correctedKgPerM3 !== c.kgBatch) add(`${key}.corrected`, p.correctedKgPerM3, c.kgBatch);
  });
  const r = plan.reconciliation;
  if (Math.abs(r.roundedTotalKg * U - roundedSum) > TOL_U * plan.lines.length)
    add('rounded_total', r.roundedTotalKg, roundedSum / U);
  if (Math.abs(r.exactTotalKg * U - exactSum) > TOL_U * plan.lines.length)
    add('exact_total', r.exactTotalKg, exactSum / U);
  if (Math.abs(r.designTotalKg * U - designSum) > TOL_U * plan.lines.length)
    add('design_total', r.designTotalKg, designSum / U);
  // the batch conversion's own balance, scaled to the batch: exact − design = expected difference × size
  const expected = conversion.balance.expectedDifferenceKg * cfg.batchSizeM3;
  if (Math.abs(r.exactMinusDesignKg - expected) > 0.01 + 0.001 * cfg.batchSizeM3)
    add('exact_minus_design', r.exactMinusDesignKg, expected);
  if (Math.abs(r.maxLineDeviationPct - worst) > 1e-4)
    add('max_line_deviation', r.maxLineDeviationPct, worst);
  return done();
}

const resolutionNote = (resU: number) => `a multiple of ${resU / U} kg`;
