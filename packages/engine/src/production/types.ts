// Production conversion types (01-domain §6). Types only: the independent batch validator reads these and nothing
// from the conversion module itself.

export type MoistureCategory = 'fine_agg' | 'coarse_agg';

/** A measured total moisture for one aggregate (percent of oven-dry mass) with the absorption from its test. */
export interface MoistureInput {
  materialId: string;
  category: MoistureCategory;
  totalMoisturePct: number;
  absorptionPct: number | null;
  /** ISO timestamp the reading was taken. */
  measuredAt: string;
  /** Where the reading came from (recorded, never judged): a lab test, a probe, the batching desk. */
  source?: string;
}

export interface BatchDesignLine {
  materialId: string;
  category: string;
  /** SSD design quantity, kg per m³. */
  kgSsd: number;
  /** Admixture only: solids % from the material test (null when not on file). */
  solidsPct?: number | null;
}

export interface BatchConfig {
  /** Tenant opt-in: subtract admixture solution water from the batch water (default off). */
  admixtureSolutionWater: boolean;
  /** QC parameters; null = not configured (blocks the conversion, named). */
  maxTotalMoisturePct: number | null;
  staleHours: number | null;
  /** ISO timestamp "now" the readings are judged against. */
  now: string;
}

export interface BatchBlocker {
  code:
    | 'parameter_missing'
    | 'moisture_missing'
    | 'absorption_missing'
    | 'moisture_impossible'
    | 'moisture_stale'
    | 'moisture_future'
    | 'no_water_line'
    | 'solids_missing';
  subject: string;
  detail: string;
}

export interface BatchLineResult {
  materialId: string;
  category: string;
  kgSsd: number;
  /** Aggregates only. */
  kgOvenDry: number | null;
  /** The mass to weigh (kg per m³). Equals `kgSsd` for non-aggregates and for the water line before adjustment. */
  kgBatch: number;
  /** Aggregates: M_od × (total − absorption); negative when drier than SSD. */
  freeWaterKg: number | null;
  /** Admixtures: mass × (1 − solids), counted only with the opt-in. */
  solutionWaterKg: number | null;
}

export interface BatchTerm {
  key: string;
  value: number;
  formula: string;
}

export interface BatchBalance {
  ssdTotalKg: number;
  batchTotalKg: number;
  /** Mass the batch is expected to differ by (admixture solution water subtracted, else 0). */
  expectedDifferenceKg: number;
  residualKg: number;
}

export type BatchResult =
  | {
      ok: true;
      lines: BatchLineResult[];
      designWaterKg: number;
      freeWaterFromAggregatesKg: number;
      solutionWaterSubtractedKg: number;
      batchWaterKg: number;
      balance: BatchBalance;
      trace: BatchTerm[];
      convention: { admixtureSolutionWater: boolean };
    }
  | { ok: false; blockers: BatchBlocker[] };

export interface BatchMismatch {
  key: string;
  reported: unknown;
  recomputed: unknown;
}
export interface BatchValidation {
  validatorVersion: string;
  status: 'pass' | 'fail';
  mismatches: BatchMismatch[];
}

// ---- batch preparation (batch size, equipment resolution, rounding, reconciliation) -----------------------------

export const PLAN_CATEGORIES = [
  'cement',
  'scm',
  'fine_agg',
  'coarse_agg',
  'water',
  'admixture',
  'fiber',
  'pigment',
] as const;

/** Engineering parameters of a batch plan. Every one ships empty: null blocks the plan and is named. */
export interface PlanConfig {
  batchSizeM3: number;
  /** The weigh-hopper resolution in kg for each category (rules `eng.batch.resolution_kg.<category>`). */
  resolutionKg: Readonly<Record<string, number | null>>;
  /** Largest permitted rounding deviation of a line, % of its exact mass (`eng.batch.max_rounding_deviation_pct`). */
  maxRoundingDeviationPct: number | null;
  /** Largest batch the mixer takes, m³ (`eng.batch.max_size_m3`). */
  maxBatchSizeM3: number | null;
}

export interface PlanBlocker {
  code:
    | 'batch_size_invalid'
    | 'parameter_missing'
    | 'batch_size_over_limit'
    | 'rounding_deviation_exceeded'
    | 'totals_deviation_exceeded';
  subject: string;
  detail: string;
}

export interface PlanLine {
  materialId: string;
  category: string;
  /** The reference design quantity (SSD basis), kg per m³. */
  designKgPerM3: number;
  /** The moisture-corrected quantity to weigh, kg per m³ (from the batch conversion). */
  correctedKgPerM3: number;
  /** corrected × batch size. */
  exactKg: number;
  resolutionKg: number;
  /** The mass to weigh, rounded to the equipment resolution. */
  roundedKg: number;
  /** rounded − exact. */
  errorKg: number;
  /** |error| as a percentage of the exact mass. */
  deviationPct: number;
}

export type BatchPlan =
  | {
      ok: true;
      batchSizeM3: number;
      lines: PlanLine[];
      reconciliation: {
        /** Σ design (SSD) quantities × batch size. */
        designTotalKg: number;
        /** Σ exact corrected masses. */
        exactTotalKg: number;
        /** Σ rounded masses (what the batcher will weigh). */
        roundedTotalKg: number;
        /** rounded total − exact total. */
        roundedMinusExactKg: number;
        /** exact total − design total (the admixture solution water counted, if the plant opted in). */
        exactMinusDesignKg: number;
        maxLineDeviationPct: number;
      };
      limits: { maxRoundingDeviationPct: number; maxBatchSizeM3: number };
    }
  | { ok: false; blockers: PlanBlocker[] };

export interface PlanValidation {
  validatorVersion: string;
  status: 'pass' | 'fail';
  mismatches: BatchMismatch[];
}
