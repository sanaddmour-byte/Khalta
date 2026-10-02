// Design lifecycle (01-domain §14.1). Pure: the server asks `canTransition` before it moves a design,
// and every move stores the named evidence it was allowed on. Edges that belong to later milestones are
// in the graph (so the rest of the map is visible and tested) but disabled until their milestone.

export const DESIGN_STATES = [
  'draft',
  'evaluated',
  'trial_candidate',
  'trial_in_progress',
  'trial_passed',
  'approved',
  'in_production',
  'suspended',
  'superseded',
  'retired',
] as const;
export type DesignState = (typeof DESIGN_STATES)[number];

export const EVIDENCE_KINDS = [
  'evaluation_verified', // evaluator ran on current inputs and the independent validator agreed
  'edit', // proportions or requirements changed
  'validated_candidate', // validator pass after rounding
  'trial_batch', // at least one trial batch logged
  'trial_review', // trial criteria met, QC manager sign-off
  'four_eyes_approval', // approver is not the author; rules verified; evidence current
  'legacy_attestation', // approved outside Khalta, attested with an e-signature note
  'release', // QC manager, or plant manager for their own plant
  'suspension_decision', // §14.3 trigger plus QC decision
  'reinstatement_decision', // QC decision
  'new_version_approved',
  'qc_decision',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface Edge {
  from: DesignState;
  to: DesignState;
  /** All of these must accompany the transition. */
  evidence: readonly EvidenceKind[];
  /** The milestone that turns this edge on; it is rejected with a clear reason before that. */
  availableFrom: string;
}

const e = (
  from: DesignState,
  to: DesignState,
  evidence: EvidenceKind[],
  availableFrom: string,
): Edge => ({ from, to, evidence, availableFrom });

export const EDGES: readonly Edge[] = [
  e('draft', 'evaluated', ['evaluation_verified'], 'M2.1'),
  e('evaluated', 'draft', ['edit'], 'M2.2'),
  e('evaluated', 'evaluated', ['evaluation_verified'], 'M2.1'), // re-evaluation keeps the state
  e('evaluated', 'trial_candidate', ['validated_candidate'], 'M3.1'),
  e('draft', 'trial_candidate', ['validated_candidate'], 'M3.1'),
  e('trial_candidate', 'trial_in_progress', ['trial_batch'], 'M4.1'),
  e('trial_in_progress', 'trial_passed', ['trial_review'], 'M4.1'),
  e('trial_passed', 'approved', ['four_eyes_approval'], 'M4.1'),
  // Legacy attestation: the one path to approved without a Khalta trial (CLAUDE.md, §14.1)
  e('draft', 'approved', ['legacy_attestation'], 'M1.3'),
  e('evaluated', 'approved', ['legacy_attestation'], 'M1.3'),
  e('approved', 'in_production', ['release'], 'M1.3'),
  e('approved', 'suspended', ['suspension_decision'], 'M5.1'),
  e('in_production', 'suspended', ['suspension_decision'], 'M5.1'),
  e('suspended', 'approved', ['reinstatement_decision'], 'M5.1'),
  e('suspended', 'in_production', ['reinstatement_decision'], 'M5.1'),
  e('approved', 'superseded', ['new_version_approved'], 'M4.1'),
  e('in_production', 'superseded', ['new_version_approved'], 'M4.1'),
  e('suspended', 'superseded', ['new_version_approved'], 'M4.1'),
  ...(['draft', 'evaluated', 'trial_candidate', 'trial_in_progress', 'trial_passed'] as const).map(
    (s) => e(s, 'retired', ['qc_decision'], 'M4.1'),
  ),
  e('approved', 'retired', ['qc_decision'], 'M4.1'),
  e('in_production', 'retired', ['qc_decision'], 'M4.1'),
  e('suspended', 'retired', ['qc_decision'], 'M4.1'),
];

/** Milestones are compared by their order in this list. */
export const MILESTONE_ORDER = [
  'M1.3',
  'M2.1',
  'M2.2',
  'M3.1',
  'M3.2',
  'M3.3',
  'M4.1',
  'M4.2',
  'M5.1',
] as const;
/** The latest milestone whose lifecycle edges this build turns on. */
export const ACTIVE_MILESTONE = 'M3.1';

export type TransitionVerdict =
  | { ok: true; edge: Edge }
  | {
      ok: false;
      code: 'unknown_state' | 'no_such_transition' | 'not_yet_available' | 'evidence_missing';
      reason: string;
      missing?: EvidenceKind[];
      availableFrom?: string;
    };

/** Unknown milestones never count as reached: an edge's own unknown milestone is +∞, the active one −∞. */
const rank = (m: string, unknown: number) => {
  const i = (MILESTONE_ORDER as readonly string[]).indexOf(m);
  return i < 0 ? unknown : i;
};

export function canTransition(
  from: string,
  to: string,
  evidence: readonly string[] = [],
  active: string = ACTIVE_MILESTONE,
): TransitionVerdict {
  const states = DESIGN_STATES as readonly string[];
  if (!states.includes(from) || !states.includes(to))
    return {
      ok: false,
      code: 'unknown_state',
      reason: `unknown design state "${from}" or "${to}"`,
    };
  const edge = EDGES.find((x) => x.from === from && x.to === to);
  if (!edge)
    return {
      ok: false,
      code: 'no_such_transition',
      reason: `a design cannot move from ${from} to ${to}`,
    };
  if (rank(edge.availableFrom, Number.POSITIVE_INFINITY) > rank(active, Number.NEGATIVE_INFINITY))
    return {
      ok: false,
      code: 'not_yet_available',
      reason: `${from} → ${to} is available from ${edge.availableFrom}`,
      availableFrom: edge.availableFrom,
    };
  const missing = edge.evidence.filter((k) => !evidence.includes(k));
  if (missing.length > 0)
    return {
      ok: false,
      code: 'evidence_missing',
      reason: `${from} → ${to} needs: ${missing.join(', ')}`,
      missing,
    };
  return { ok: true, edge };
}

/** Terminal states: immutable history. */
export const isTerminal = (s: DesignState) => s === 'superseded' || s === 'retired';
