// The approval gate (01-domain §14.1, 07 §2.5). Pure: a plain snapshot of the facts in, every gate out. A blocked
// approval lists ALL unmet gates (never just the first). The server computes the facts; this decides.
import type { TrialAcceptance } from './trial';

export type GateId =
  | 'trial_batch'
  | `criterion_${'slump' | 'air' | 'density' | 'yield' | 'temperature' | 'strength'}`
  | 'trial_passed'
  | 'four_eyes'
  | 'validator'
  | 'compliance'
  | 'rules_verified'
  | 'evidence_current'
  | 'declared_values'
  | 'assumptions_accepted'
  | 'project_requirements';

export interface GateInput {
  /** The design's author (created_by) and the person asking to approve. */
  authorId: string | null;
  approverId: string | null;
  status: string;
  /** A fresh evaluation on current inputs. */
  evaluation: {
    validatorStatus: 'pass' | 'fail';
    verdict: 'pass' | 'fail' | 'incomplete';
    provisional: boolean;
    evidence: readonly string[];
    dataQuality: readonly { code: string; materialId?: string | null }[];
  } | null;
  /** Rule / test versions the latest stored evaluation used vs the ones current now. */
  current: { hasStored: boolean; rulesMatch: boolean; testsMatch: boolean };
  /** Tenant setting `approval_requires_lab_source`. */
  requiresLabSource: boolean;
  /** Statements the evaluator made without data ("water SG taken as 1.000"), and the ones a QC manager accepted with a signature. */
  assumptions?: readonly string[];
  acceptedAssumptions?: readonly string[];
  /** Material ids whose declared values a QC manager accepted (with an e-signature) for this design. */
  acceptedMaterialIds: readonly string[];
  trial: TrialAcceptance | null;
  /** The project-requirements revision frozen into the design, if any, and the tenant's policy about it. */
  projectRequirements?: ProjectRequirementsFacts;
}

export interface ProjectRequirementsFacts {
  /** The tenant setting `requireProjectRequirements`. */
  required: boolean;
  /** The revision the design froze (null: none recorded, e.g. a legacy design). */
  frozen: {
    projectRef: string;
    revision: number;
    status: 'draft' | 'verified' | 'superseded';
  } | null;
}

/** Whether the project requirements a design froze are still the project's current, verified ones. */
export function projectRequirementsGate(f: ProjectRequirementsFacts | undefined): Gate {
  const frozen = f?.frozen ?? null;
  if (!frozen)
    return {
      id: 'project_requirements',
      met: !f?.required,
      code: f?.required ? 'requirements_not_recorded' : 'none_recorded',
    };
  if (frozen.status === 'verified')
    return {
      id: 'project_requirements',
      met: true,
      code: 'ok',
      detail: [`${frozen.projectRef} r${frozen.revision}`],
    };
  return {
    id: 'project_requirements',
    met: false,
    code: frozen.status === 'superseded' ? 'requirements_superseded' : 'requirements_not_verified',
    detail: [`${frozen.projectRef} r${frozen.revision}`],
  };
}

export interface Gate {
  id: GateId;
  met: boolean;
  /** A stable code the UI translates; details name the thing that is unmet. */
  code: string;
  detail?: string[];
}
export interface GateResult {
  ok: boolean;
  gates: Gate[];
}

export function checkApprovalGates(i: GateInput): GateResult {
  const gates: Gate[] = [];
  const ev = i.evaluation;

  gates.push({
    id: 'trial_passed',
    met: i.status === 'trial_passed',
    code: i.status === 'trial_passed' ? 'ok' : 'not_trial_passed',
    detail: i.status === 'trial_passed' ? [] : [i.status],
  });
  const fourEyes = !!i.authorId && !!i.approverId && i.authorId !== i.approverId;
  gates.push({ id: 'four_eyes', met: fourEyes, code: fourEyes ? 'ok' : 'author_cannot_approve' });

  gates.push({
    id: 'validator',
    met: ev?.validatorStatus === 'pass',
    code: !ev ? 'no_evaluation' : ev.validatorStatus === 'pass' ? 'ok' : 'validator_disagrees',
  });
  gates.push({
    id: 'compliance',
    met: ev?.verdict === 'pass',
    code: !ev ? 'no_evaluation' : ev.verdict === 'pass' ? 'ok' : `verdict_${ev.verdict}`,
  });
  const unverified =
    !!ev &&
    (ev.evidence.includes('RULE_UNVERIFIED') ||
      ev.provisional ||
      ev.dataQuality.some((q) => q.code === 'rules_unverified'));
  gates.push({
    id: 'rules_verified',
    met: !!ev && !unverified,
    code: !ev ? 'no_evaluation' : unverified ? 'rules_unverified' : 'ok',
  });
  const stale = !i.current.hasStored
    ? ['no_stored_evaluation']
    : [
        ...(i.current.rulesMatch ? [] : ['rules_changed']),
        ...(i.current.testsMatch ? [] : ['tests_changed']),
      ];
  gates.push({
    id: 'evidence_current',
    met: stale.length === 0,
    code: stale.length === 0 ? 'ok' : 'evidence_stale',
    detail: stale,
  });

  const declared = [
    ...new Set(
      (ev?.dataQuality ?? [])
        .filter((q) => q.code === 'declared_values' && q.materialId)
        .map((q) => q.materialId as string),
    ),
  ];
  const unaccepted = i.requiresLabSource
    ? declared.filter((m) => !i.acceptedMaterialIds.includes(m))
    : [];
  gates.push({
    id: 'declared_values',
    met: unaccepted.length === 0,
    code: unaccepted.length === 0 ? (declared.length ? 'accepted' : 'ok') : 'declared_not_accepted',
    detail: unaccepted,
  });

  // An assumption never silently satisfies mandatory evidence: it must be listed AND accepted with a signature.
  const unacceptedAssumptions = (i.assumptions ?? []).filter(
    (a) => !(i.acceptedAssumptions ?? []).includes(a),
  );
  gates.push({
    id: 'assumptions_accepted',
    met: unacceptedAssumptions.length === 0,
    code:
      unacceptedAssumptions.length === 0
        ? (i.assumptions ?? []).length
          ? 'accepted'
          : 'ok'
        : 'assumptions_not_accepted',
    detail: unacceptedAssumptions,
  });

  gates.push(projectRequirementsGate(i.projectRequirements));

  return { ok: gates.every((g) => g.met), gates };
}
