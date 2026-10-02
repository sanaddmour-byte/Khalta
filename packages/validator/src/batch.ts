// Independent check of a production conversion (01-domain §6): its own arithmetic, written differently from the
// conversion (wet mass as M_ssd × (1+total)/(1+absorption), free water as wet − SSD), compared with what was
// reported. Imports only the production TYPES; never the conversion module.
import type {
  BatchConfig,
  BatchDesignLine,
  BatchMismatch,
  BatchResult,
  BatchValidation,
  MoistureInput,
} from '@khalta/engine';

export const BATCH_VALIDATOR_VERSION = '1.0.0';
/** Reported masses are rounded to 0.001 kg per line; a balance over a whole batch may drift by a few grams. */
const LINE_TOL = 0.0011;
const SUM_TOL = 0.01;
const AGG = ['fine_agg', 'coarse_agg'];

export function validateBatch(
  design: readonly BatchDesignLine[],
  moisture: readonly MoistureInput[],
  cfg: BatchConfig,
  result: BatchResult,
): BatchValidation {
  const mismatches: BatchMismatch[] = [];
  const add = (key: string, reported: unknown, recomputed: unknown) =>
    mismatches.push({ key, reported, recomputed });
  const done = (): BatchValidation => ({
    validatorVersion: BATCH_VALIDATOR_VERSION,
    status: mismatches.length === 0 ? 'pass' : 'fail',
    mismatches,
  });

  // Would any input be refused? (independent restatement of the operational limits)
  const now = Date.parse(cfg.now);
  const refused: string[] = [];
  if (cfg.maxTotalMoisturePct === null || cfg.staleHours === null) refused.push('limits');
  for (const l of design.filter((x) => AGG.includes(x.category))) {
    const m = moisture.find((x) => x.materialId === l.materialId);
    if (!m || m.absorptionPct === null) {
      refused.push(`${l.materialId}:input`);
      continue;
    }
    if (m.totalMoisturePct < 0) refused.push(`${l.materialId}:negative`);
    if (cfg.maxTotalMoisturePct !== null && m.totalMoisturePct > cfg.maxTotalMoisturePct)
      refused.push(`${l.materialId}:too_wet`);
    const age = (now - Date.parse(m.measuredAt)) / 3_600_000;
    if (!(age >= -1 / 60)) refused.push(`${l.materialId}:future`);
    if (cfg.staleHours !== null && age > cfg.staleHours) refused.push(`${l.materialId}:stale`);
  }
  if (!design.some((l) => l.category === 'water')) refused.push('water');
  if (!result.ok) {
    if (refused.length === 0)
      add('blocked_without_reason', 'blocked', 'nothing in the inputs blocks');
    return done();
  }
  if (refused.length > 0) {
    add('should_have_blocked', 'weights offered', refused);
    return done();
  }

  let freeTotal = 0;
  let solutionTotal = 0;
  let batchTotal = 0;
  const water = design.find((l) => l.category === 'water')!;
  for (const l of design) {
    const got = result.lines.find((x) => x.materialId === l.materialId);
    if (!got) {
      add(`${l.materialId}.line`, null, 'present');
      continue;
    }
    if (got.kgSsd !== l.kgSsd) add(`${l.materialId}.kgSsd`, got.kgSsd, l.kgSsd);
    if (AGG.includes(l.category)) {
      const m = moisture.find((x) => x.materialId === l.materialId)!;
      const wet = (l.kgSsd * (1 + m.totalMoisturePct / 100)) / (1 + m.absorptionPct! / 100);
      const free = wet - l.kgSsd;
      freeTotal += free;
      batchTotal += wet;
      if (Math.abs(got.kgBatch - wet) > LINE_TOL) add(`${l.materialId}.kgBatch`, got.kgBatch, wet);
      if (got.freeWaterKg === null || Math.abs(got.freeWaterKg - free) > LINE_TOL)
        add(`${l.materialId}.freeWaterKg`, got.freeWaterKg, free);
      // sign: drier than SSD gives negative free water, wetter gives positive
      const drier = m.totalMoisturePct < m.absorptionPct!;
      if (drier && !(got.freeWaterKg !== null && got.freeWaterKg <= 0))
        add(`${l.materialId}.sign`, got.freeWaterKg, 'negative or zero (drier than SSD)');
    } else if (l.category !== 'water') {
      batchTotal += l.kgSsd;
      if (Math.abs(got.kgBatch - l.kgSsd) > LINE_TOL)
        add(`${l.materialId}.kgBatch`, got.kgBatch, l.kgSsd);
      if (l.category === 'admixture' && cfg.admixtureSolutionWater)
        solutionTotal += l.kgSsd * (1 - (l.solidsPct ?? 0) / 100);
    }
  }
  const batchWater = water.kgSsd - freeTotal - solutionTotal;
  batchTotal += batchWater;
  if (Math.abs(result.batchWaterKg - batchWater) > SUM_TOL)
    add('batchWaterKg', result.batchWaterKg, batchWater);
  const wl = result.lines.find((x) => x.materialId === water.materialId);
  if (!wl || Math.abs(wl.kgBatch - batchWater) > LINE_TOL)
    add('water.kgBatch', wl?.kgBatch ?? null, batchWater);
  if (batchWater < 0) add('batchWaterKg.negative', result.batchWaterKg, 'cannot be negative');

  // mass balance: the batch weighs what the SSD design weighs, less any admixture solution water counted
  const ssdTotal = design.reduce((s, l) => s + l.kgSsd, 0);
  const expected = -solutionTotal;
  if (Math.abs(batchTotal - (ssdTotal + expected)) > SUM_TOL)
    add('balance.recomputed', batchTotal, ssdTotal + expected);
  if (Math.abs(result.balance.batchTotalKg - batchTotal) > SUM_TOL)
    add('balance.batchTotalKg', result.balance.batchTotalKg, batchTotal);
  if (Math.abs(result.balance.residualKg) > SUM_TOL)
    add('balance.residualKg', result.balance.residualKg, 0);
  if (result.convention.admixtureSolutionWater !== cfg.admixtureSolutionWater)
    add('convention', result.convention.admixtureSolutionWater, cfg.admixtureSolutionWater);
  return done();
}
