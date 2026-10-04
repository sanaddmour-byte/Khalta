// Batch preparation (docs/calc/batch-moisture.md §5): turns the moisture-corrected batch weights per m³ into the
// masses to weigh for a given batch size, rounded to the equipment resolution of each category, with a
// reconciliation back to the design. Pure. Nothing is assumed: a missing resolution, tolerance or batch limit BLOCKS
// the plan and is named; a rounding that exceeds the tolerance blocks it too.
import type { BatchPlan, BatchResult, PlanBlocker, PlanConfig, PlanLine } from './types';

export const PLAN_VERSION = '1.0.0';

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Round half up to a multiple of `res`, free of binary floating-point noise. */
export function roundToResolution(x: number, res: number): number {
  return r6(Math.floor(x / res + 0.5 + 1e-9) * res);
}

export function planBatch(result: Extract<BatchResult, { ok: true }>, cfg: PlanConfig): BatchPlan {
  const blockers: PlanBlocker[] = [];
  if (!Number.isFinite(cfg.batchSizeM3) || cfg.batchSizeM3 <= 0)
    blockers.push({
      code: 'batch_size_invalid',
      subject: 'batch_size',
      detail: 'The batch size must be a positive number of cubic metres',
    });
  if (cfg.maxBatchSizeM3 === null)
    blockers.push({
      code: 'parameter_missing',
      subject: 'eng.batch.max_size_m3',
      detail: 'The largest batch the mixer takes is not on file (eng.batch.max_size_m3)',
    });
  else if (cfg.batchSizeM3 > cfg.maxBatchSizeM3)
    blockers.push({
      code: 'batch_size_over_limit',
      subject: 'batch_size',
      detail: `A ${cfg.batchSizeM3} m³ batch is larger than the ${cfg.maxBatchSizeM3} m³ the mixer takes`,
    });
  if (cfg.maxRoundingDeviationPct === null)
    blockers.push({
      code: 'parameter_missing',
      subject: 'eng.batch.max_rounding_deviation_pct',
      detail:
        'The largest permitted rounding deviation is not on file (eng.batch.max_rounding_deviation_pct)',
    });
  const cats = [...new Set(result.lines.map((l) => l.category))];
  for (const c of cats) {
    const res = cfg.resolutionKg[c] ?? null;
    if (res === null || !(res > 0))
      blockers.push({
        code: 'parameter_missing',
        subject: `eng.batch.resolution_kg.${c}`,
        detail: `The weigh-hopper resolution for ${c} is not on file (eng.batch.resolution_kg.${c})`,
      });
  }
  if (blockers.length > 0) return { ok: false, blockers };

  const tol = cfg.maxRoundingDeviationPct as number;
  const lines: PlanLine[] = result.lines.map((l) => {
    const res = cfg.resolutionKg[l.category] as number;
    const exactKg = r6(l.kgBatch * cfg.batchSizeM3);
    const roundedKg = roundToResolution(exactKg, res);
    const errorKg = r6(roundedKg - exactKg);
    return {
      materialId: l.materialId,
      category: l.category,
      designKgPerM3: l.kgSsd,
      correctedKgPerM3: l.kgBatch,
      exactKg,
      resolutionKg: res,
      roundedKg,
      errorKg,
      deviationPct: exactKg === 0 ? 0 : r6((Math.abs(errorKg) / exactKg) * 100),
    };
  });
  for (const l of lines)
    if (l.deviationPct > tol)
      blockers.push({
        code: 'rounding_deviation_exceeded',
        subject: l.materialId,
        detail: `Rounding ${l.exactKg} kg to ${l.roundedKg} kg is a ${r3(l.deviationPct)} % deviation, above the permitted ${tol} %; use a smaller batch or a finer hopper`,
      });
  const designTotalKg = r6(lines.reduce((s, l) => s + l.designKgPerM3, 0) * cfg.batchSizeM3);
  const exactTotalKg = r6(lines.reduce((s, l) => s + l.exactKg, 0));
  const roundedTotalKg = r6(lines.reduce((s, l) => s + l.roundedKg, 0));
  const totalsDeviation =
    exactTotalKg === 0 ? 0 : (Math.abs(roundedTotalKg - exactTotalKg) / exactTotalKg) * 100;
  if (totalsDeviation > tol)
    blockers.push({
      code: 'totals_deviation_exceeded',
      subject: 'totals',
      detail: `The rounded total ${roundedTotalKg} kg differs from the exact total ${exactTotalKg} kg by ${r3(totalsDeviation)} %, above the permitted ${tol} %`,
    });
  if (blockers.length > 0) return { ok: false, blockers };
  return {
    ok: true,
    batchSizeM3: cfg.batchSizeM3,
    lines,
    reconciliation: {
      designTotalKg,
      exactTotalKg,
      roundedTotalKg,
      roundedMinusExactKg: r6(roundedTotalKg - exactTotalKg),
      exactMinusDesignKg: r6(exactTotalKg - designTotalKg),
      maxLineDeviationPct: Math.max(0, ...lines.map((l) => l.deviationPct)),
    },
    limits: { maxRoundingDeviationPct: tol, maxBatchSizeM3: cfg.maxBatchSizeM3 as number },
  };
}
