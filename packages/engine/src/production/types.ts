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
