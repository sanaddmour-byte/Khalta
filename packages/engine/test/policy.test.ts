import { describe, expect, it } from 'vitest';
import {
  EDGES,
  EVIDENCE_STATES,
  OUTCOMES,
  TRANSITION_POLICY,
  evidenceBreakdown,
  outcomesOf,
  policyFor,
} from '../src';

describe('transition policy', () => {
  it('covers every target state the graph can reach (except the draft re-edit), with the same evidence the graph demands', () => {
    const targets = new Set(
      EDGES.map((e) => e.to).filter((t) => t !== 'draft' && t !== 'approved'),
    );
    for (const t of targets) expect(policyFor(t), t).not.toBeNull();
    // `approved` has two doors (Khalta approval and legacy attestation); the Khalta one is the policy
    expect(policyFor('approved')?.evidence).toEqual(['four_eyes_approval']);
    for (const p of Object.values(TRANSITION_POLICY)) {
      const edges = EDGES.filter((e) => e.to === p.to);
      expect(
        edges.some((e) => p.evidence.every((k) => e.evidence.includes(k))),
        `${p.to} evidence matches an edge`,
      ).toBe(true);
    }
  });

  it('keeps the four outcomes distinct and attached to different moves', () => {
    expect(new Set(OUTCOMES).size).toBe(4);
    const byOutcome = Object.values(TRANSITION_POLICY)
      .filter((p) => p.outcome)
      .map((p) => [p.outcome, p.to]);
    expect(byOutcome).toEqual(
      expect.arrayContaining([
        ['calculation_checks_passed', 'evaluated'],
        ['trial_accepted', 'trial_passed'],
        ['design_approved', 'approved'],
        ['production_released', 'in_production'],
      ]),
    );
  });

  it('never lets an engineering sign-off rest on an assumption without a signed acceptance, and never on a missing input', () => {
    for (const to of ['trial_passed', 'approved']) {
      const p = policyFor(to)!;
      expect(p.mayRelyOn).not.toContain('assumed');
      expect(p.mayRelyOn).not.toContain('missing');
      expect([...p.needsAcceptance, ...p.blocks]).toContain('assumed');
      expect(p.blocks).toContain('missing');
    }
    for (const p of Object.values(TRANSITION_POLICY))
      for (const s of [...p.mayRelyOn, ...p.needsAcceptance, ...p.blocks])
        expect(EVIDENCE_STATES).toContain(s);
  });

  it('requires a signature and separation of duties exactly where the contract says', () => {
    expect(policyFor('approved')).toMatchObject({ separation: 'author', signature: 'approved' });
    expect(policyFor('in_production')).toMatchObject({ signature: 'released' });
    expect(policyFor('trial_passed')).toMatchObject({ signature: 'trial_reviewed' });
    expect(policyFor('evaluated')?.signature).toBeNull();
  });
});

describe('evidence breakdown', () => {
  it('lists assumptions, declarations, missing and predicted inputs separately', () => {
    const b = evidenceBreakdown({
      assumptions: ['Water specific gravity was taken as 1.000'],
      evidence: ['MODEL_BASELINE', 'TRIAL_REQUIRED', 'INPUT_STALE', 'RULE_UNVERIFIED'],
      dataQuality: [
        { code: 'declared_values', materialId: 'm1' },
        { code: 'declared_values', materialId: 'm1' },
        { code: 'tests_expired', materialId: 'm2' },
      ],
    });
    expect(b.assumed).toHaveLength(1);
    expect(b.conventions).toEqual([]);
    expect(b.declared).toEqual(['m1']);
    expect(b.missing).toEqual(
      expect.arrayContaining(['input_stale', 'rule_unverified', 'tests_expired']),
    );
    expect(b.modelPredicted).toEqual(['MODEL_BASELINE', 'TRIAL_REQUIRED']);
  });
});

describe('assumptions: substitutions vs conventions', () => {
  it('a value standing in for a missing input needs acceptance; a published-table convention does not', () => {
    const b = evidenceBreakdown({
      assumptions: [
        'Air content 2 % is the ACI 211.1 value',
        'Water specific gravity taken as 1.000',
      ],
      assumptionReasons: [{ key: 'air_baseline_used' }, { key: 'water_sg_assumed' }],
      evidence: [],
      dataQuality: [],
    });
    expect(b.assumed).toEqual(['Water specific gravity taken as 1.000']);
    expect(b.conventions).toEqual(['Air content 2 % is the ACI 211.1 value']);
  });
  it('without reasons, every assumption is treated as a substitution (the safe reading)', () => {
    const b = evidenceBreakdown({ assumptions: ['x'], evidence: [], dataQuality: [] });
    expect(b.assumed).toEqual(['x']);
  });
});

describe('outcomes', () => {
  const ok = { validatorStatus: 'pass', verdict: 'pass' } as const;
  it('a passed calculation is not an accepted trial, an approval or a release', () => {
    expect(outcomesOf({ status: 'evaluated', evaluation: ok, current: true })).toEqual({
      calculationChecks: 'passed',
      trialAccepted: false,
      approved: false,
      released: false,
    });
  });
  it('marks calculation checks stale when inputs changed, failed when the validator disagrees', () => {
    expect(outcomesOf({ status: 'draft', evaluation: ok, current: false }).calculationChecks).toBe(
      'stale',
    );
    expect(
      outcomesOf({
        status: 'draft',
        evaluation: { validatorStatus: 'fail', verdict: 'pass' },
        current: true,
      }).calculationChecks,
    ).toBe('failed');
    expect(
      outcomesOf({
        status: 'draft',
        evaluation: { validatorStatus: 'pass', verdict: 'incomplete' },
        current: true,
      }).calculationChecks,
    ).toBe('incomplete');
    expect(outcomesOf({ status: 'draft', evaluation: null, current: true }).calculationChecks).toBe(
      'none',
    );
  });
  it('walks the four outcomes along the lifecycle', () => {
    const at = (status: string) => outcomesOf({ status, evaluation: ok, current: true });
    expect(at('trial_passed')).toMatchObject({
      trialAccepted: true,
      approved: false,
      released: false,
    });
    expect(at('approved')).toMatchObject({ trialAccepted: true, approved: true, released: false });
    expect(at('in_production')).toMatchObject({ approved: true, released: true });
  });
});
