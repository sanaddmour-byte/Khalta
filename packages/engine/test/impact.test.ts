import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  classifyImpact,
  dispositionAllowed,
  DISPOSITIONS,
  IMPACT_CLASSES,
  IMPACT_TRIGGERS,
  type ImpactFacts,
} from '../src';

describe('change-impact classification', () => {
  it('a price change alone needs no action', () => {
    expect(classifyImpact('price_change', {})).toEqual({
      class: 'no_action',
      reasons: ['cost_only'],
    });
  });
  it('a touching change with no new finding is a review, never silent', () => {
    expect(classifyImpact('rule_revision', {}).class).toBe('review');
  });
  it('each finding maps to its class and the most serious wins', () => {
    expect(classifyImpact('test_expiry', { testExpired: true }).class).toBe('revalidate');
    expect(classifyImpact('material_change', { sourceChanged: true }).class).toBe('requalify');
    expect(classifyImpact('requirements_revision', { requirementsSuperseded: true }).class).toBe(
      'revalidate',
    );
    expect(classifyImpact('strength_deterioration', { strengthBelowFcr: true }).class).toBe(
      'suspend_recommended',
    );
    const all = classifyImpact('material_change', {
      sourceChanged: true,
      newFailures: 2,
      strengthBelowFcr: true,
    });
    expect(all.class).toBe('suspend_recommended');
    expect(all.reasons).toEqual(['strength_below_fcr', 'source_changed', 'new_check_failures']);
  });
  it('property: adding a finding never lowers the class, and a price change with findings is never "no action"', () => {
    const facts = fc.record({
      newFailures: fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }),
      testExpired: fc.option(fc.boolean(), { nil: undefined }),
      sourceChanged: fc.option(fc.boolean(), { nil: undefined }),
      driftExceeded: fc.option(fc.boolean(), { nil: undefined }),
      requirementsSuperseded: fc.option(fc.boolean(), { nil: undefined }),
      strengthBelowFcr: fc.option(fc.boolean(), { nil: undefined }),
    }) as fc.Arbitrary<ImpactFacts>;
    fc.assert(
      fc.property(fc.constantFrom(...IMPACT_TRIGGERS), facts, (t, f) => {
        const base = classifyImpact(t, f);
        const more = classifyImpact(t, { ...f, strengthBelowFcr: true });
        expect(IMPACT_CLASSES.indexOf(more.class)).toBeGreaterThanOrEqual(
          IMPACT_CLASSES.indexOf(base.class),
        );
        if (
          (f.newFailures ?? 0) > 0 ||
          f.testExpired ||
          f.sourceChanged ||
          f.driftExceeded ||
          f.requirementsSuperseded ||
          f.strengthBelowFcr
        )
          expect(base.class).not.toBe('no_action');
      }),
    );
  });
  it('dispositions must fit the class: a suspension recommendation cannot be waved away', () => {
    expect(dispositionAllowed('suspend_recommended', 'dismissed')).toBe(false);
    expect(dispositionAllowed('suspend_recommended', 'accepted_risk')).toBe(true);
    expect(dispositionAllowed('requalify', 'revalidation_started')).toBe(false);
    expect(dispositionAllowed('requalify', 'requalification_required')).toBe(true);
    expect(dispositionAllowed('no_action', 'accepted_risk')).toBe(false);
    expect(dispositionAllowed('revalidate', 'revalidation_started')).toBe(true);
    expect(DISPOSITIONS).toHaveLength(4);
  });
});
