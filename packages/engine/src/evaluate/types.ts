// Evaluation snapshot and report: the contract between the evaluator, the independent validator, the
// database and the UI. Types and constants only; no calculation lives here (the validator imports this file).
import type { Mode, ProjectOverride, RuleRecord } from '@khalta/rules';
import type { StrengthBasis } from '../legacy/parse';
import type { Category, Properties, Source } from '../materials/properties';
import type { ResolvedCharacteristic } from '../characteristics/resolve';

export const EVALUATOR_VERSION = '1.1.0';

export const EVIDENCE_STATUSES = [
  'CODE_VERIFIED',
  'PROJECT_VERIFIED',
  'RULE_UNVERIFIED',
  'MODEL_IN_DOMAIN',
  'MODEL_BASELINE',
  'MODEL_EXTRAPOLATED',
  'INPUT_STALE',
  'INPUT_MISSING',
  'TRIAL_REQUIRED',
  'USER_OVERRIDE',
  'INPUT_USER_DECLARED',
  'MODEL_PREDICTS_SHORTFALL',
] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export interface DesignRequestInput {
  fcMpa: number | null;
  basis: StrengthBasis | null;
  testAgeDays: number | null;
  exposure: string[];
  /** Sulfate option for S3 (1: pozzolan/slag route, 2: w/cm 0.40 route); null when not stated. */
  s3Option: 1 | 2 | null;
  slumpMm: number | null;
  nmasMm: number | null;
  pumpable: boolean | null;
  /** Air content (% by volume) of the design, when the design states one. */
  airPct: number | null;
}

export type SnapshotPrice =
  | {
      status: 'ok';
      priceId: string;
      /** Decimal string, in `unit`. */
      price: string;
      unit: 'JOD/ton' | 'JOD/m3' | 'JOD/kg' | 'JOD/L';
      supplierId: string;
      includesDelivery: boolean;
      effectiveFrom: string;
      staleness: 'fresh' | 'stale' | 'not_configured';
      ageDays: number;
    }
  | { status: 'unavailable' }
  | { status: 'ambiguous'; supplierIds: string[] };

export interface SnapshotTest {
  id: string;
  version: number;
  source: Source;
  fieldSources: Record<string, Source>;
  testedAt: string;
  validUntil: string | null;
  freshness: 'fresh' | 'expired' | 'not_configured';
  properties: Properties;
}

export interface SnapshotMaterial {
  id: string;
  category: Category;
  nameEn: string;
  nameAr: string | null;
  test: SnapshotTest | null;
  price: SnapshotPrice;
}

export interface SnapshotLine {
  materialId: string;
  /** kg per m³, SSD, decimal string (numeric(12,3) from the database). */
  kgPerM3: string;
}

export interface EvaluationSettings {
  /** Null = not configured: no near-limit warnings. */
  nearLimitPct: number | null;
  /** Null = not configured: margin 0, stated in the report. */
  safetyMarginMpa: number | null;
  /** m³ either side of 1.000. */
  yieldTolerance: number;
  /** Per characteristic key; null/absent = exact. */
  roundingTolerance: Record<string, number>;
}

/** Strength-test history for the statistical f'cr branch (reachable once strength results exist, M4.2). */
export interface StrengthRecordSummary {
  n: number;
  /** Sample standard deviation (MPa). */
  sdMpa: number;
  /** Mean f'c of the mixes the tests come from, for the ±window check (MPa). */
  fcMpa: number;
}

export interface EvaluationSnapshot {
  schema: 1;
  design: { id: string; code: string; name: string; plantId: string };
  mode: Mode;
  /** `YYYY-MM-DD` (Asia/Amman): the date prices and freshness are judged on. */
  evaluationDate: string;
  priceBasis: { kind: 'live' | 'snapshot'; date: string; snapshotId: string | null };
  request: DesignRequestInput;
  projectOverrides: ProjectOverride[];
  tablePolicy: Record<string, 'ACI' | 'JS'>;
  /** Every rule that applies to this request, as stored (ids and versions are the reproducibility record). */
  rules: RuleRecord[];
  lines: SnapshotLine[];
  materials: SnapshotMaterial[];
  settings: EvaluationSettings;
  /** Layered, normalized and already checked against the hard limits (empty when none were given). */
  characteristics: ResolvedCharacteristic[];
  strengthRecords: StrengthRecordSummary | null;
  /** M5.2: an approved valid model for this design's group (absent = the ACI 211.1 baseline). */
  strengthModel?: StrengthModelInput | null;
}

// ---------------------------------------------------------------- report

export type Tri = 'pass' | 'fail' | 'not_evaluated';

export interface TraceEntry {
  key: string;
  value: number | string | null;
  unit: string;
  formula: string;
  /** The numbers that went into `value`, by name. */
  inputs: Record<string, number | string | null>;
  ruleKey?: string;
  clause?: string;
  evidence: EvidenceStatus[];
}

export interface GoverningRef {
  source: string;
  ruleKey: string;
  clause: string;
  requirementClass: string;
  verified: boolean;
}

/** A stable key + parameters for an English explanation, so the UI can translate it. */
export interface Reason {
  key: string;
  params: Record<string, string>;
}

export interface EvalBlocker {
  code:
    | 'rule_not_on_file'
    | 'rule_blocked'
    | 'input_missing'
    | 'context_missing'
    | 'out_of_domain'
    | 'not_applicable_here'
    | 'needs_trial';
  detail: string;
  reason?: Reason;
}

export interface CheckResult {
  /** Stable id used for tests and UI labels, e.g. `max_wcm`, `cl.nonprestressed`, `sulfate_cement`. */
  id: string;
  requirement: string;
  status: Tri;
  value: number | string | null;
  /** The limit compared against (a number, a set, or `true` for a prohibition). */
  limit: number | string[] | boolean | null;
  op: '<=' | '>=' | 'in' | 'abs<=' | 'is' | null;
  units: string;
  governing: GoverningRef | null;
  /** Whether the governing requirement is complete (both codes known) and its rules verified. */
  provisional: boolean;
  evidence: EvidenceStatus[];
  blocker: EvalBlocker | null;
  /** `near_limit` when within the configured percentage of the limit and passing. */
  warning: 'near_limit' | null;
  traceKey: string | null;
  note?: string;
  noteReason?: Reason;
}

export interface RequirementRow {
  requirement: string;
  kind: string;
  units: string;
  value: unknown;
  status: 'resolved' | 'provisional' | 'blocked';
  governing: GoverningRef | null;
  verified: boolean;
  issues: string[];
  /** Whether a design-stage check exists for it, or why not. */
  checked: boolean;
  skippedReason?: string;
}

export interface CostLine {
  materialId: string;
  kgPerM3: string;
  /** JOD per kg after unit conversion (decimal string, 9 places) or null if it cannot be priced. */
  jodPerKg: string | null;
  /** JOD per m³ rounded to 3 places, or null. */
  jod: string | null;
  state: 'priced' | 'unavailable' | 'ambiguous' | 'not_convertible' | 'no_price_needed';
  detail?: string;
  reason?: Reason;
  stale: boolean;
}

export interface CostBlock {
  /** `complete`: every priced line present; `incomplete`: named lines missing; never zero for a gap. */
  state: 'complete' | 'incomplete';
  totalJodPerM3: string | null;
  /** Σ of the priced lines only; shown beside an incomplete total, never as the cost. */
  subtotalJodPerM3: string;
  lines: CostLine[];
  missing: { materialId: string; reason: string }[];
  basis: { kind: 'live' | 'snapshot'; date: string; snapshotId: string | null };
}

/** An APPROVED, valid plant strength model (M5.2). The caller attaches it only for the model's own group. */
export interface StrengthModelInput {
  id: string;
  /** ln f = a − b·(w/cm) */
  a: number;
  b: number;
  wcmMin: number;
  wcmMax: number;
  ageDays: number;
  basis: 'cylinder' | 'cube';
  groupKey: string;
  sMpa: number;
}

export interface StrengthAdequacy {
  /** Never compliance: a published heuristic or a plant fit, not a guarantee. */
  label: 'not_a_compliance_result';
  model: 'none' | 'plant';
  /** Present only when a plant model was supplied. */
  modelId?: string;
  modelWc?: number | null;
  /** The strength-governed w/cm: the model's inside its domain, else the ACI baseline. */
  governingWc?: number | null;
  modelUse?: 'used' | 'out_of_domain' | 'age_or_basis_differs';
  fcrMpa: number | null;
  baselineWc: number | null;
  designWcm: number | null;
  comparison: 'design_above_baseline' | 'design_at_or_below_baseline' | null;
  evidence: EvidenceStatus[];
  blocker: EvalBlocker | null;
  clause: string | null;
}

export interface WaterBaseline {
  label: 'does_not_predict_plant_water_demand';
  baseWaterKg: number | null;
  admixtureReductionPct: number | null;
  baselineWaterKg: number | null;
  designWaterKg: number | null;
  evidence: EvidenceStatus[];
  blocker: EvalBlocker | null;
  clause: string | null;
}

export interface FcrBranch {
  ruleset: string;
  value: number | null;
  branch: 'no_data' | 'statistical' | null;
  blocker: EvalBlocker | null;
  clause: string | null;
}

export interface StrengthBlock {
  specifiedMpa: number | null;
  basis: StrengthBasis | null;
  cylinderMpa: number | null;
  /** Per ruleset; the higher governs. */
  branches: FcrBranch[];
  safetyMarginMpa: number;
  marginConfigured: boolean;
  /** Governing average strength including the margin, or null when no ruleset could compute it. */
  fcrMpa: number | null;
  governingRuleset: string | null;
  blocker: EvalBlocker | null;
}

export type QualitySeverity = 'info' | 'warning' | 'blocker';
export interface QualityItem {
  code: string;
  severity: QualitySeverity;
  materialId?: string;
  detail: string;
  reason?: Reason;
  evidence?: EvidenceStatus[];
}

export type CharacteristicStatus = 'met' | 'deviated' | 'not_evaluated';
export interface CharacteristicRow {
  key: string;
  requested: string;
  achieved: number | string | null;
  unit: string;
  delta: number | null;
  status: CharacteristicStatus;
  origin: string;
  klass: 'USER_SPECIFIED';
  blocker: EvalBlocker | null;
  evidence: EvidenceStatus[];
}

export interface Rejection {
  key: string;
  code: 'override_loosens' | 'infeasible_with_limit' | 'invalid_value' | 'outside_product_range';
  message: string;
  proposed: unknown;
  allowed: unknown;
  rule: string | null;
  clause: string | null;
  source: string | null;
}

export interface Figures {
  [key: string]: number | string | null;
}

export type Verdict = 'fail' | 'incomplete' | 'pass';

export interface EvaluationReport {
  schema: 1;
  evaluatorVersion: string;
  mode: Mode;
  evaluationDate: string;
  figures: Figures;
  trace: TraceEntry[];
  strength: StrengthBlock;
  checks: CheckResult[];
  requirements: RequirementRow[];
  /** `fail` if any check fails; `incomplete` if none fails but one was not evaluated; else `pass`. */
  verdict: Verdict;
  /** True while any governing rule is unverified or any requirement is provisional/blocked. */
  provisional: boolean;
  strengthAdequacy: StrengthAdequacy;
  waterBaseline: WaterBaseline;
  cost: CostBlock;
  dataQuality: QualityItem[];
  characteristics: { rows: CharacteristicRow[] };
  evidence: EvidenceStatus[];
  assumptions: string[];
  /** Same order as `assumptions`. */
  assumptionReasons?: Reason[];
  /** SG (or other minimum data) missing for a line: the design cannot be called `evaluated`. */
  minimumData: { ok: boolean; missing: { materialId: string; field: string }[] };
}

export interface ValidatorMismatch {
  key: string;
  kind:
    | 'figure_mismatch'
    | 'missing_figure'
    | 'unexpected_figure'
    | 'missing_trace'
    | 'trace_mismatch'
    | 'check_mismatch'
    | 'missing_check'
    | 'unexpected_check'
    | 'verdict_mismatch'
    | 'cost_mismatch'
    | 'strength_mismatch'
    | 'characteristic_mismatch'
    | 'snapshot_invalid'
    | 'metadata_mismatch';
  reported: unknown;
  recomputed: unknown;
  detail?: string;
}

export interface ValidatorResult {
  validatorVersion: string;
  /** `pass` only when every recomputed number and status agrees with the report. */
  status: 'pass' | 'fail';
  mismatches: ValidatorMismatch[];
  checked: { figures: number; checks: number; trace: number };
}

// ---------------------------------------------------------------- optimizer candidates (M3.1)

export interface Band {
  min: number | null;
  max: number | null;
}

export interface CandidateGuardrails {
  dmaxMm: number;
  gradingSieves: { sieve_mm: number; passing_pct: number; target_pct: number; band_pct: number }[];
  coarsenessFactor: number;
  workabilityFactor: number;
  workabilityFactorAdjusted: number;
  finesPct: number;
  passing03Pct: number | null;
  fmCombined: number;
  limits: { cf: Band; wf: Band; finesMax: number; pumpableMin: number | null };
}

export interface CandidateConfiguration {
  cementId: string;
  scmId: string | null;
  scmPct: number;
  admixtureId: string | null;
  /** Dosage, % of cementitious mass. */
  dosagePct: number;
  nmasMm: number;
  airPct: number;
}

/**
 * Everything the independent candidate validator needs, as plain data: the snapshot and report the
 * evaluator produced for the ROUNDED proportions, the configuration, and the guardrail figures the
 * optimizer claims. The validator recomputes all of it and never sees optimizer code.
 */
export interface CandidateRecord {
  schema: 1;
  snapshot: EvaluationSnapshot;
  report: EvaluationReport;
  configuration: CandidateConfiguration;
  guardrails: CandidateGuardrails;
  characteristics: CharacteristicRow[];
  costJodPerM3: string | null;
  evidence: EvidenceStatus[];
  requiresAuthorization: boolean;
  /** The request's include/exclude lists, for the availability check. */
  materials: { include?: string[]; exclude?: string[] };
}

export interface CandidateMismatch {
  key: string;
  kind:
    | 'evaluation'
    | 'availability'
    | 'rounding'
    | 'guardrail'
    | 'characteristic'
    | 'cost'
    | 'evidence'
    | 'configuration'
    | 'parameter_missing';
  reported: unknown;
  recomputed: unknown;
  detail?: string;
}

export interface CandidateValidatorResult {
  validatorVersion: string;
  status: 'pass' | 'fail';
  mismatches: CandidateMismatch[];
  evaluation: ValidatorResult;
}
