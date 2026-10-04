// Controlled optimizer: inputs, the solver contract and the candidate/diagnostic shapes (M3.1).
// A solver result is never an approved mix: every candidate is re-evaluated and re-validated from scratch.
import type {
  Band,
  CandidateGuardrails,
  CandidateConfiguration as Configuration,
  CharacteristicRow,
  EvaluationReport,
  EvaluationSnapshot,
  EvidenceStatus,
  SnapshotLine,
} from '../evaluate/types';

export type { Band, CandidateGuardrails, Configuration };

export type Objective = 'cheapest' | 'closest_to_targets';

/** Tenant-tunable search and rounding settings (all have stated defaults, none is a code value). */
export interface OptimizerSettings {
  /** SCM replacement is searched in steps of this many percentage points. */
  scmStepPct: number;
  /** Fixed water this far (%) below the model estimate is flagged "slump at risk". */
  waterOverrideWarnPct: number;
  /** Cap on enumerated (cement × SCM × % × admixture × dosage × NMAS) configurations. */
  maxConfigurations: number;
  candidatesTopN: number;
  /** JOD/m³ charged per unit of deviation from a `target` characteristic (overridable per characteristic). */
  targetWeightJodPerUnit: number;
  /** Highest SCM % searched when no governing SCM maximum is on file. */
  scmSearchCapPct: number;
  /** Wall-clock budget for the whole request. */
  timeBudgetMs: number;
  /** Points of safety kept inside every guardrail bound so rounding cannot push a candidate over it. */
  guardrailGuard: number;
  /** Guard against degenerate all-paste solutions: least aggregate volume per m³ (not an engineering recommendation). */
  minAggregateVolume: number;
  /** Absolute tolerance used when a configuration's rounded quantities are compared with the model. */
  roundingTolerance: Record<string, number>;
}

export const DEFAULT_OPTIMIZER_SETTINGS: OptimizerSettings = {
  scmStepPct: 5,
  waterOverrideWarnPct: 5,
  maxConfigurations: 200,
  candidatesTopN: 5,
  targetWeightJodPerUnit: 0.05,
  scmSearchCapPct: 40,
  timeBudgetMs: 20_000,
  guardrailGuard: 0.25,
  minAggregateVolume: 0.45,
  roundingTolerance: { sand_ratio_pct: 0.5, wcm: 0.005 },
};

/** Default tolerance for mass characteristics (±1 %), expressed as a relative fraction. */
export const MASS_TOLERANCE_REL = 0.01;

export interface OptimizerInput {
  /** Everything an evaluation needs except the proportions (design id/lines are filled per candidate). */
  base: Omit<EvaluationSnapshot, 'lines'>;
  objective: Objective;
  materials?: { include?: string[]; exclude?: string[]; prefer?: string[] };
  settings: OptimizerSettings;
}

// ---------------------------------------------------------------- the solver contract

export interface LpVar {
  name: string;
  lb: number;
  ub: number;
  cost: number;
}
export interface LpRow {
  name: string;
  terms: [string, number][];
  lb: number | null;
  ub: number | null;
}
export interface LpProblem {
  vars: LpVar[];
  rows: LpRow[];
}
export interface LpSolution {
  status: 'optimal' | 'infeasible' | 'unbounded' | 'error';
  objective: number;
  x: Record<string, number>;
  /** Row dual values (shadow prices, JOD per unit of the row's bound). */
  duals: Record<string, number>;
  /** Row activity (left-hand side at the solution). */
  activity: Record<string, number>;
}
export interface Solver {
  solve(problem: LpProblem): Promise<LpSolution>;
}

// ---------------------------------------------------------------- blockers and parameters

export interface OptimizerBlocker {
  code:
    | 'parameter_missing'
    | 'rule_not_on_file'
    | 'input_missing'
    | 'out_of_domain'
    | 'not_supported'
    | 'request_infeasible'
    | 'no_materials';
  /** The rule key, material or request field that is missing. */
  subject: string;
  detail: string;
}

/** Engineering parameters the optimizer needs, read once from the snapshot's rules. */
export interface Guardrails {
  gradingExponent: number;
  gradingBandPct: number;
  gradingMarginPts: number;
  cfMin: number;
  cfMax: number;
  wfAdjustPoints: number;
  wfAdjustPerKg: number;
  wfAdjustAboveKg: number;
  finesMaxPct: number;
  pumpableMin03Pct: number | null;
  /** Sieve series (mm) used for FM and combined gradation. */
  fmSieves: number[];
  caVolumeSanityBandPct: number;
  wcmMargin: number;
  /** Individual aggregate acceptance, per category; each entry is a sieve with its min/max % passing. */
  fineLimits: { sieve_mm: number; min_pct: number; max_pct: number }[];
  coarseLimits: { sieve_mm: number; min_pct: number; max_pct: number }[];
}

// ---------------------------------------------------------------- candidates

export interface CandidateMargins {
  /** w/cm headroom to the ceiling after rounding (≥ 0). */
  wcmHeadroom: number;
  wcmCeiling: number;
  /** Per guardrail: distance to the nearest limit (positive = inside). */
  cfMargin: number;
  wfMargin: number;
  finesMargin: number;
  gradingMarginPts: number;
}

export interface BindingRow {
  id: string;
  /** JOD per m³ saved per unit the limit is relaxed (a shadow price from the LP). */
  shadowPrice: number;
  klass: 'CODE' | 'ENGINEERING' | 'USER' | 'PHYSICAL';
}

export interface Candidate {
  rank: number;
  configuration: Configuration;
  lines: SnapshotLine[];
  /** The exact snapshot the evaluator and the validator judged (rounded proportions). */
  snapshot: EvaluationSnapshot;
  report: EvaluationReport;
  guardrails: CandidateGuardrails;
  margins: CandidateMargins;
  binding: BindingRow[];
  /** JOD/m³ from the evaluator (exact decimal); null when a line cannot be priced. */
  costJodPerM3: string | null;
  /** Objective value the candidate was ranked on. */
  objectiveValue: number;
  deviations: { key: string; requested: number; achieved: number; weightedCostJod: number }[];
  /** Requested vs achieved for every characteristic, including those only the candidate layer can judge. */
  characteristics: CharacteristicRow[];
  evidence: EvidenceStatus[];
  /** Always MODEL_BASELINE + TRIAL_REQUIRED; MODEL_PREDICTS_SHORTFALL needs QC-manager authorisation. */
  requiresAuthorization: boolean;
  notes: { code: string; detail: string }[];
  /** How this candidate came out of the solver: set by `optimize` (see `CandidateSolve`). */
  solve?: CandidateSolve;
}

/**
 * What the solver did for one candidate. `lpCostJod` is the LP optimum of its configuration BEFORE rounding to
 * practical quantities; `roundingGapJod` is what rounding added (never negative in exact arithmetic). The candidate is
 * not proven globally cheapest: the search is one LP per discrete configuration (ADR 0009).
 */
export interface CandidateSolve {
  lpCostJod: number;
  roundingGapJod: number | null;
  fixedPointIterations: number;
  fixedPointConverged: boolean;
}

export interface DofReport {
  /** Free design quantities (binder, water, one volume per aggregate), before any equality. */
  quantities: number;
  /** Equality rows: the volume balance plus every Fixed characteristic. */
  equalities: number;
  /** quantities − equalities: > 0 free, 0 fully specified, < 0 over-specified. */
  dof: number;
  state: 'free' | 'fully_specified' | 'over_specified';
  fixed: string[];
}

import type { InfeasibilityClass } from '../requirements/project';

export interface ConflictItem {
  /** The characteristic or limit that cannot all be met. */
  id: string;
  klass: 'USER' | 'CODE' | 'ENGINEERING' | 'PHYSICAL';
  /** How far the user's value would have to move for the rest to be feasible (user rows only). */
  relaxBy: number | null;
  unit: string;
  detail: string;
  /** Who owns the limit (code, project, approved internal, user preference, material availability). */
  category: InfeasibilityClass;
  /** True ONLY for a user preference: every governing requirement has no relax control. */
  adjustable: boolean;
}

export interface ConflictReport {
  kind: 'user_specified' | 'hard_rows';
  items: ConflictItem[];
}

export type OptimizeStatus = 'candidates' | 'blocked' | 'infeasible' | 'no_valid_candidate';

/**
 * Why the search ended, in words a person can act on. `status` says what came out; this says how complete it is.
 * - optimal_within_search: every enumerated configuration was solved; the best is the lowest-cost found among them
 * - feasible_unproven: candidates exist but the search was cut short (time budget, solver errors, enumeration cap)
 * - timed_out: the time budget ended the search before ANY configuration was solved (this is not infeasibility)
 * - infeasible: every configuration was proven infeasible for the stated hard rows
 * - invalid_input: the request cannot be formulated (a parameter, rule or material is missing)
 * - solver_failure: the solver itself failed on every configuration it tried
 * - no_valid_candidate: solutions were found but none survived rounding and the independent validator
 * - cancelled: the caller stopped the search (never stored)
 */
export const TERMINATION_KINDS = [
  'optimal_within_search',
  'feasible_unproven',
  'timed_out',
  'infeasible',
  'invalid_input',
  'solver_failure',
  'no_valid_candidate',
  'cancelled',
] as const;
export type TerminationKind = (typeof TERMINATION_KINDS)[number];

export interface Termination {
  kind: TerminationKind;
  /** True only when every enumerated configuration was attempted and none was lost to a solver error or the budget. */
  searchComplete: boolean;
  configurations: {
    enumerated: number;
    solved: number;
    infeasible: number;
    solverErrors: number;
    /** Not attempted because the time budget (or the enumeration cap) ended the search. */
    notAttempted: number;
  };
  /** The objective in plain terms. The wording never claims a proven global optimum. */
  objective: { name: Objective; statement: 'lowest_cost_found' | 'closest_to_targets_found' };
  /** Rows of the first solved configuration by owner (code, engineering, user, physical). */
  constraints: Record<string, number>;
  /** The largest amount rounding added over the LP optimum among the returned candidates, JOD/m³. */
  maxRoundingGapJod: number | null;
  /** The independent validator at the candidate stage. */
  validator: { checked: number; accepted: number; rejected: number };
}

export class OptimizeCancelled extends Error {
  constructor() {
    super('The optimization was cancelled');
    this.name = 'OptimizeCancelled';
  }
}

export interface OptimizeResult {
  status: OptimizeStatus;
  objective: Objective;
  candidates: Candidate[];
  blockers: OptimizerBlocker[];
  conflicts: ConflictReport | null;
  dof: DofReport | null;
  /** Configurations enumerated / solved / rejected after rounding. */
  stats: {
    enumerated: number;
    solved: number;
    infeasible: number;
    solverErrors: number;
    rejectedAfterRounding: number;
    truncated: boolean;
    elapsedMs: number;
  };
  /** Materials excluded from the search and why (never silent). */
  excluded: { materialId: string; reason: string }[];
  notes: { code: string; detail: string }[];
  termination: Termination;
  optimizerVersion: string;
}

export const OPTIMIZER_VERSION = '1.1.0';
