// Production conversion (01-domain §6): SSD design → wet batch weights from measured moisture. Pure; every
// intermediate term is returned. Absorption and total moisture are never conflated, and wet mass is never
// called SSD mass. A missing QC limit, a missing reading or an impossible/stale reading BLOCKS and is named.
import type {
  BatchBlocker,
  BatchConfig,
  BatchDesignLine,
  BatchLineResult,
  BatchResult,
  BatchTerm,
  MoistureInput,
} from './types';

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const isAgg = (c: string) => c === 'fine_agg' || c === 'coarse_agg';

export function toBatchWeights(
  design: readonly BatchDesignLine[],
  moisture: readonly MoistureInput[],
  cfg: BatchConfig,
): BatchResult {
  const blockers: BatchBlocker[] = [];
  if (cfg.maxTotalMoisturePct === null)
    blockers.push({
      code: 'parameter_missing',
      subject: 'eng.moisture.max_total_pct',
      detail: 'The largest plausible total moisture is not on file (eng.moisture.max_total_pct)',
    });
  if (cfg.staleHours === null)
    blockers.push({
      code: 'parameter_missing',
      subject: 'eng.moisture.stale_hours',
      detail: 'The maximum age of a moisture reading is not on file (eng.moisture.stale_hours)',
    });
  const water = design.find((l) => l.category === 'water');
  if (!water)
    blockers.push({
      code: 'no_water_line',
      subject: 'water',
      detail: 'The design has no water line',
    });
  const now = Date.parse(cfg.now);
  for (const l of design.filter((x) => isAgg(x.category))) {
    const m = moisture.find((x) => x.materialId === l.materialId);
    if (!m) {
      blockers.push({
        code: 'moisture_missing',
        subject: l.materialId,
        detail: 'No moisture reading was entered for this aggregate',
      });
      continue;
    }
    if (m.absorptionPct === null || !Number.isFinite(m.absorptionPct)) {
      blockers.push({
        code: 'absorption_missing',
        subject: l.materialId,
        detail: 'The aggregate has no absorption on file',
      });
      continue;
    }
    if (!Number.isFinite(m.totalMoisturePct) || m.totalMoisturePct < 0)
      blockers.push({
        code: 'moisture_impossible',
        subject: l.materialId,
        detail: 'Total moisture cannot be negative',
      });
    else if (cfg.maxTotalMoisturePct !== null && m.totalMoisturePct > cfg.maxTotalMoisturePct)
      blockers.push({
        code: 'moisture_impossible',
        subject: l.materialId,
        detail: `Total moisture ${m.totalMoisturePct} % is above the QC limit ${cfg.maxTotalMoisturePct} %`,
      });
    const at = Date.parse(m.measuredAt);
    if (!Number.isFinite(at) || at > now + 60_000)
      blockers.push({
        code: 'moisture_future',
        subject: l.materialId,
        detail: 'The reading time is invalid or in the future',
      });
    else if (cfg.staleHours !== null && (now - at) / 3_600_000 > cfg.staleHours)
      blockers.push({
        code: 'moisture_stale',
        subject: l.materialId,
        detail: `The reading is older than ${cfg.staleHours} hours`,
      });
  }
  if (cfg.admixtureSolutionWater)
    for (const l of design.filter((x) => x.category === 'admixture'))
      if (l.solidsPct === null || l.solidsPct === undefined)
        blockers.push({
          code: 'solids_missing',
          subject: l.materialId,
          detail: 'Admixture solids % is not on file, so its solution water cannot be counted',
        });
  if (blockers.length > 0 || !water) return { ok: false, blockers };

  const trace: BatchTerm[] = [];
  const add = (key: string, value: number, formula: string) =>
    trace.push({ key, value: r3(value), formula });
  const lines: BatchLineResult[] = [];
  let freeSum = 0;
  let solutionSum = 0;
  for (const l of design) {
    if (isAgg(l.category)) {
      const m = moisture.find((x) => x.materialId === l.materialId)!;
      const a = m.absorptionPct! / 100;
      const t = m.totalMoisturePct / 100;
      const od = l.kgSsd / (1 + a);
      const wet = od * (1 + t);
      const free = od * (t - a);
      freeSum += free;
      add(`${l.materialId}.oven_dry`, od, 'M_ssd / (1 + absorption)');
      add(`${l.materialId}.wet`, wet, 'M_od × (1 + total moisture)');
      add(`${l.materialId}.free_water`, free, 'M_od × (total moisture − absorption)');
      lines.push({
        materialId: l.materialId,
        category: l.category,
        kgSsd: l.kgSsd,
        kgOvenDry: r3(od),
        kgBatch: r3(wet),
        freeWaterKg: r3(free),
        solutionWaterKg: null,
      });
    } else if (l.category === 'water') {
      lines.push({
        materialId: l.materialId,
        category: l.category,
        kgSsd: l.kgSsd,
        kgOvenDry: null,
        kgBatch: l.kgSsd, // replaced below once the adjustments are known
        freeWaterKg: null,
        solutionWaterKg: null,
      });
    } else {
      const sol =
        l.category === 'admixture' && cfg.admixtureSolutionWater
          ? l.kgSsd * (1 - (l.solidsPct as number) / 100)
          : null;
      if (sol !== null) {
        solutionSum += sol;
        add(`${l.materialId}.solution_water`, sol, 'mass × (1 − solids)');
      }
      lines.push({
        materialId: l.materialId,
        category: l.category,
        kgSsd: l.kgSsd,
        kgOvenDry: null,
        kgBatch: l.kgSsd,
        freeWaterKg: null,
        solutionWaterKg: sol === null ? null : r3(sol),
      });
    }
  }
  const batchWater = water.kgSsd - freeSum - solutionSum;
  add('water.design', water.kgSsd, 'design free water (SSD basis)');
  add('water.aggregate_free_total', freeSum, 'Σ W_free');
  add('water.solution_subtracted', solutionSum, 'Σ admixture solution water (opt-in)');
  add('water.batch', batchWater, 'design water − Σ W_free − Σ solution water');
  const wl = lines.find((x) => x.materialId === water.materialId)!;
  wl.kgBatch = r3(batchWater);
  const ssdTotal = design.reduce((s, l) => s + l.kgSsd, 0);
  const batchTotal = lines.reduce((s, l) => s + l.kgBatch, 0);
  const expected = -solutionSum;
  return {
    ok: true,
    lines,
    designWaterKg: water.kgSsd,
    freeWaterFromAggregatesKg: r3(freeSum),
    solutionWaterSubtractedKg: r3(solutionSum),
    batchWaterKg: r3(batchWater),
    balance: {
      ssdTotalKg: r3(ssdTotal),
      batchTotalKg: r3(batchTotal),
      expectedDifferenceKg: r3(expected),
      residualKg: r3(batchTotal - ssdTotal - expected),
    },
    trace,
    convention: { admixtureSolutionWater: cfg.admixtureSolutionWater },
  };
}
