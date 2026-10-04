// Change-impact classification. A change (a price, a material test, a rule, a project requirement, a strength result)
// touches approved designs; this says, for ONE design, what a person must consider. It never changes a design: the
// approved version stays exactly as approved, and every outcome except `no_action` is a decision for a named person.
// Pure; no engineering values.

export const IMPACT_TRIGGERS = [
  'price_change',
  'test_expiry',
  'material_change',
  'rule_revision',
  'requirements_revision',
  'strength_deterioration',
] as const;
export type ImpactTrigger = (typeof IMPACT_TRIGGERS)[number];

/** In increasing order of seriousness. */
export const IMPACT_CLASSES = [
  'no_action',
  'review',
  'revalidate',
  'requalify',
  'suspend_recommended',
] as const;
export type ImpactClass = (typeof IMPACT_CLASSES)[number];

export const DISPOSITIONS = [
  'revalidation_started',
  'requalification_required',
  'accepted_risk',
  'dismissed',
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export interface ImpactFacts {
  /** Compliance checks that fail now and did not fail at the last evaluation. */
  newFailures?: number;
  /** A material test the design relies on has passed its expiry. */
  testExpired?: boolean;
  /** The material's evidence source or supplier changed (a different source for strength purposes). */
  sourceChanged?: boolean;
  /** The material's test moved beyond the drift tolerance. */
  driftExceeded?: boolean;
  /** The design froze a project-requirements revision that has since been superseded. */
  requirementsSuperseded?: boolean;
  /** The latest strength set is below the required average f′cr. */
  strengthBelowFcr?: boolean;
}

export interface ImpactAssessment {
  class: ImpactClass;
  reasons: string[];
}

const rank = (c: ImpactClass) => IMPACT_CLASSES.indexOf(c);

export function classifyImpact(trigger: ImpactTrigger, f: ImpactFacts): ImpactAssessment {
  const hits: { c: ImpactClass; why: string }[] = [];
  const add = (c: ImpactClass, why: string) => hits.push({ c, why });
  if (f.strengthBelowFcr) add('suspend_recommended', 'strength_below_fcr');
  if (f.sourceChanged) add('requalify', 'source_changed');
  if (f.testExpired) add('revalidate', 'test_expired');
  if ((f.newFailures ?? 0) > 0) add('revalidate', 'new_check_failures');
  if (f.driftExceeded) add('revalidate', 'drift_exceeded');
  if (f.requirementsSuperseded) add('revalidate', 'requirements_superseded');
  if (hits.length === 0) {
    // a change that touches the design but changed nothing it depends on
    return trigger === 'price_change'
      ? { class: 'no_action', reasons: ['cost_only'] }
      : { class: 'review', reasons: [`${trigger}_no_new_finding`] };
  }
  const worst = hits.reduce((a, b) => (rank(b.c) > rank(a.c) ? b : a));
  return { class: worst.c, reasons: [...new Set(hits.map((h) => h.why))] };
}

/** A disposition must fit the class it answers: no one may "dismiss" a suspension recommendation without a reason, etc. */
export function dispositionAllowed(c: ImpactClass, d: Disposition): boolean {
  if (c === 'no_action') return d === 'dismissed';
  if (c === 'requalify') return d !== 'revalidation_started' && d !== 'dismissed';
  if (c === 'suspend_recommended') return d !== 'dismissed';
  return true;
}
