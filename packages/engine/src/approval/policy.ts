// The transition policy: ONE table that says, for every move a design can make, what the server demands. The
// routes read it (capability, signature, separation of duties) and the gate results quote it, so a rule cannot be
// stated in one place and enforced differently in another. Pure data plus two pure functions; it contains no
// engineering values.
//
// Four distinct outcomes are never conflated (an "accepted trial" is not an "approval", and neither is a
// "release"). They are named here and used by the API, the UI and the exports.
import type { DesignState, EvidenceKind } from '../lifecycle';

export const OUTCOMES = [
  'calculation_checks_passed', // the evaluator ran on current inputs and the independent validator agreed
  'trial_accepted', // trial criteria met and a QC manager signed the review
  'design_approved', // approved by a person who is not the author, on current verified evidence
  'production_released', // released at a plant by an authorised person
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type SignatureMeaning =
  | 'trial_reviewed'
  | 'approved'
  | 'released'
  | 'retired'
  | 'suspended'
  | 'reinstated'
  | 'declared_values_accepted'
  | 'assumptions_accepted'
  | 'requirements_verified';

/** What a value's provenance is. Only `tested` (and `declared`, once accepted) can satisfy mandatory evidence. */
export const EVIDENCE_STATES = [
  'tested',
  'declared',
  'assumed',
  'missing',
  'model_predicted',
] as const;
export type EvidenceState = (typeof EVIDENCE_STATES)[number];

export interface TransitionPolicy {
  to: DesignState;
  /** The outcome this move records, or null when it records none of the four. */
  outcome: Outcome | null;
  /** The rbac capability the caller must hold (enforced by the route). */
  capability: string;
  /** `plant`: the design's plant must be inside the caller's scope. `tenant`: any plant of the tenant. */
  scope: 'plant' | 'tenant';
  /** `author`: the design's author cannot make this move on their own design. */
  separation: 'author' | 'none';
  /** The e-signature meaning that must be stored, or null when none is required. */
  signature: SignatureMeaning | null;
  /** Evidence kinds the engine graph demands (`canTransition`). */
  evidence: readonly EvidenceKind[];
  /** Named freshness conditions the gates check. */
  freshness: readonly string[];
  /** Evidence states that may satisfy the mandatory requirements of this move. */
  mayRelyOn: readonly EvidenceState[];
  /** Evidence states that block it unless a person accepted them with a signature. */
  needsAcceptance: readonly EvidenceState[];
  /** Evidence states that always block it. */
  blocks: readonly EvidenceState[];
}

const NONE: readonly never[] = [];

export const TRANSITION_POLICY: Readonly<Record<string, TransitionPolicy>> = {
  evaluated: {
    to: 'evaluated',
    outcome: 'calculation_checks_passed',
    capability: 'design.write',
    scope: 'plant',
    separation: 'none',
    signature: null,
    evidence: ['evaluation_verified'],
    freshness: [],
    mayRelyOn: ['tested', 'declared', 'assumed', 'model_predicted'],
    needsAcceptance: NONE,
    blocks: ['missing'],
  },
  trial_candidate: {
    to: 'trial_candidate',
    outcome: null,
    capability: 'trial.request',
    scope: 'plant',
    separation: 'none',
    signature: null,
    evidence: ['validated_candidate'],
    freshness: [],
    mayRelyOn: ['tested', 'declared', 'assumed', 'model_predicted'],
    needsAcceptance: NONE,
    blocks: ['missing'],
  },
  trial_in_progress: {
    to: 'trial_in_progress',
    outcome: null,
    capability: 'trial.request',
    scope: 'plant',
    separation: 'none',
    signature: null,
    evidence: ['trial_batch'],
    freshness: [],
    mayRelyOn: ['tested', 'declared', 'assumed', 'model_predicted'],
    needsAcceptance: NONE,
    blocks: NONE,
  },
  trial_passed: {
    to: 'trial_passed',
    outcome: 'trial_accepted',
    capability: 'trial.pass',
    scope: 'plant',
    separation: 'none',
    signature: 'trial_reviewed',
    evidence: ['trial_review'],
    freshness: ['trial_criteria_configured'],
    mayRelyOn: ['tested'],
    needsAcceptance: ['declared'],
    blocks: ['missing', 'assumed'],
  },
  approved: {
    to: 'approved',
    outcome: 'design_approved',
    capability: 'design.approve',
    scope: 'plant',
    separation: 'author',
    signature: 'approved',
    evidence: ['four_eyes_approval'],
    freshness: ['evaluation_matches_current_rules', 'evaluation_matches_current_tests'],
    // model predictions were confirmed by the accepted trial; assumptions and declarations need a signed acceptance
    mayRelyOn: ['tested', 'model_predicted'],
    needsAcceptance: ['declared', 'assumed'],
    blocks: ['missing'],
  },
  in_production: {
    to: 'in_production',
    outcome: 'production_released',
    capability: 'production.release',
    scope: 'plant',
    separation: 'none',
    signature: 'released',
    evidence: ['release'],
    freshness: ['design_version_approved'],
    mayRelyOn: ['tested'],
    needsAcceptance: NONE,
    blocks: ['missing'],
  },
  suspended: {
    to: 'suspended',
    outcome: null,
    capability: 'design.approve',
    scope: 'plant',
    separation: 'none',
    signature: 'suspended',
    evidence: ['suspension_decision'],
    freshness: [],
    mayRelyOn: ['tested', 'declared', 'assumed', 'model_predicted'],
    needsAcceptance: NONE,
    blocks: NONE,
  },
  retired: {
    to: 'retired',
    outcome: null,
    capability: 'design.approve',
    scope: 'plant',
    separation: 'none',
    signature: 'retired',
    evidence: ['qc_decision'],
    freshness: [],
    mayRelyOn: ['tested', 'declared', 'assumed', 'model_predicted'],
    needsAcceptance: NONE,
    blocks: NONE,
  },
  superseded: {
    to: 'superseded',
    outcome: null,
    capability: 'design.approve',
    scope: 'tenant',
    separation: 'none',
    signature: null,
    evidence: ['new_version_approved'],
    freshness: [],
    mayRelyOn: ['tested'],
    needsAcceptance: NONE,
    blocks: NONE,
  },
};

export function policyFor(to: string): TransitionPolicy | null {
  return TRANSITION_POLICY[to] ?? null;
}

/**
 * Assumptions that STAND IN for a missing or ambiguous input (a value the evaluator had to supply because nobody
 * recorded it). These need a signed acceptance before an engineering sign-off. The other assumptions the evaluator
 * lists are modelling conventions (the published ACI 211.1 entrapped-air value, the slump table band): they are shown
 * as such, and the trial's measured values supersede them.
 */
export const SUBSTITUTING_ASSUMPTION_KEYS = [
  'water_sg_assumed',
  'water_sg_defaulted',
  'strength_age_assumed',
  'b_grade_ambiguous',
] as const;

/** What a report contributes to each evidence state, derived (never stored) from the evaluator's own output. */
export interface EvidenceBreakdown {
  /** Statements the evaluator made in place of a missing input ("water SG taken as 1.000"): need acceptance. */
  assumed: string[];
  /** Modelling conventions the evaluator states (published table values); informational, replaced by trial data. */
  conventions: string[];
  /** Materials whose key values a person declared (not tested). */
  declared: string[];
  /** Inputs that are absent, stale or unverified. */
  missing: string[];
  /** Properties predicted by a model or a baseline rather than measured. */
  modelPredicted: string[];
}

export interface BreakdownInput {
  assumptions: readonly string[];
  /** Same order as `assumptions`; when absent every assumption counts as a substitution (the safe reading). */
  assumptionReasons?: readonly { key: string }[] | undefined;
  evidence: readonly string[];
  dataQuality: readonly { code: string; materialId?: string | null; detail?: unknown }[];
}

/**
 * Derives the evidence breakdown. Assumptions and declarations are listed, not hidden; none of them can satisfy a
 * requirement a policy marks as `tested`-only. Pure.
 */
export function evidenceBreakdown(r: BreakdownInput): EvidenceBreakdown {
  const missing: string[] = [];
  if (r.evidence.includes('INPUT_MISSING')) missing.push('input_missing');
  if (r.evidence.includes('INPUT_STALE')) missing.push('input_stale');
  if (r.evidence.includes('RULE_UNVERIFIED')) missing.push('rule_unverified');
  for (const q of r.dataQuality)
    if (['rules_unverified', 'tests_expired', 'tests_stale', 'price_stale'].includes(q.code))
      missing.push(q.code);
  const substituting = (i: number) =>
    !r.assumptionReasons ||
    !r.assumptionReasons[i] ||
    (SUBSTITUTING_ASSUMPTION_KEYS as readonly string[]).includes(r.assumptionReasons[i]!.key);
  return {
    assumed: r.assumptions.filter((_, i) => substituting(i)),
    conventions: r.assumptions.filter((_, i) => !substituting(i)),
    declared: [
      ...new Set(
        r.dataQuality
          .filter((q) => q.code === 'declared_values' && q.materialId)
          .map((q) => String(q.materialId)),
      ),
    ],
    missing: [...new Set(missing)],
    modelPredicted: r.evidence.filter((e) => e.startsWith('MODEL_') || e === 'TRIAL_REQUIRED'),
  };
}

/** The four outcomes of a design, derived from its state and its latest evaluation. */
export interface OutcomeStatus {
  calculationChecks: 'none' | 'passed' | 'failed' | 'incomplete' | 'stale';
  trialAccepted: boolean;
  approved: boolean;
  released: boolean;
}

export function outcomesOf(i: {
  status: string;
  evaluation: { validatorStatus: 'pass' | 'fail'; verdict: 'pass' | 'fail' | 'incomplete' } | null;
  current: boolean;
}): OutcomeStatus {
  const ev = i.evaluation;
  const calc: OutcomeStatus['calculationChecks'] = !ev
    ? 'none'
    : !i.current
      ? 'stale'
      : ev.validatorStatus !== 'pass' || ev.verdict === 'fail'
        ? 'failed'
        : ev.verdict === 'incomplete'
          ? 'incomplete'
          : 'passed';
  const afterTrial = ['trial_passed', 'approved', 'in_production', 'suspended', 'superseded'];
  return {
    calculationChecks: calc,
    trialAccepted: afterTrial.includes(i.status),
    approved: ['approved', 'in_production', 'suspended', 'superseded'].includes(i.status),
    released: i.status === 'in_production',
  };
}
