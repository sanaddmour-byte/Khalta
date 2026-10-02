import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkApprovalGates,
  classifyChange,
  evaluateTrialAcceptance,
  type DesignFacts,
  type GateInput,
  type TrialBatch,
  type TrialCriteria,
} from '../src';

// SYNTHETIC values: labelled test data, not a plant's criteria.
const CRIT: TrialCriteria = {
  slumpToleranceMm: 25,
  airTolerancePct: 1.5,
  densityBandKgM3: 40,
  yieldBandM3: 0.01,
  temperatureMaxC: 32,
};
const TARGET = { slumpMm: 100, airPct: 2, densityKgM3: 2380, fcrMpa: 38 };
const batch = (o: Partial<TrialBatch> = {}): TrialBatch => ({
  id: 'b1',
  batchedOn: '2026-10-01',
  slumpMm: 105,
  airPct: 2.5,
  temperatureC: 28,
  freshDensityKgM3: 2390,
  yieldM3: 1.004,
  strengthMpa: [39, 40, 41],
  ...o,
});

describe('trial acceptance (§14.4)', () => {
  it('passes when every criterion is met', () => {
    const r = evaluateTrialAcceptance(CRIT, TARGET, [batch()]);
    expect(r.ok).toBe(true);
    expect(r.criteria.map((c) => c.status)).toEqual(Array(6).fill('pass'));
  });
  it('names each failed criterion', () => {
    const r = evaluateTrialAcceptance(CRIT, TARGET, [
      batch({ slumpMm: 140, temperatureC: 35, strengthMpa: [30, 31] }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.criteria.filter((c) => c.status === 'fail').map((c) => c.id)).toEqual([
      'slump',
      'temperature',
      'strength',
    ]);
  });
  it('a missing criterion parameter blocks and is named, never defaulted', () => {
    const r = evaluateTrialAcceptance(
      { ...CRIT, slumpToleranceMm: null, temperatureMaxC: null },
      TARGET,
      [batch()],
    );
    expect(r.ok).toBe(false);
    expect(r.criteria.filter((c) => c.status === 'missing').map((c) => c.missing)).toEqual([
      'eng.trial.slump_tolerance_mm',
      'eng.trial.temperature_max_c',
    ]);
  });
  it('no batch means no pass; a missing measurement blocks; no target air is not applicable', () => {
    expect(evaluateTrialAcceptance(CRIT, TARGET, []).ok).toBe(false);
    const m = evaluateTrialAcceptance(CRIT, TARGET, [batch({ yieldM3: null })]);
    expect(m.criteria.find((c) => c.id === 'yield')).toMatchObject({
      status: 'missing',
      missing: 'measurement',
    });
    const n = evaluateTrialAcceptance(CRIT, { ...TARGET, airPct: null }, [batch({ airPct: null })]);
    expect(n.criteria.find((c) => c.id === 'air')?.status).toBe('not_applicable');
    expect(n.ok).toBe(true);
  });
  it('judges the latest batch', () => {
    const old = batch({ id: 'a', batchedOn: '2026-09-01', slumpMm: 300 });
    expect(evaluateTrialAcceptance(CRIT, TARGET, [old, batch()]).ok).toBe(true);
    expect(evaluateTrialAcceptance(CRIT, TARGET, [batch(), old]).ok).toBe(true);
  });
  it('property: a measurement exactly on a limit passes, beyond it fails', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }), (d) => {
        const r = evaluateTrialAcceptance(CRIT, TARGET, [batch({ slumpMm: 100 + d })]);
        expect(r.criteria[0]!.status).toBe(d <= 25 ? 'pass' : 'fail');
      }),
    );
  });
});

const GOOD: GateInput = {
  authorId: 'u1',
  approverId: 'u2',
  status: 'trial_passed',
  evaluation: {
    validatorStatus: 'pass',
    verdict: 'pass',
    provisional: false,
    evidence: ['CODE_VERIFIED'],
    dataQuality: [],
  },
  current: { hasStored: true, rulesMatch: true, testsMatch: true },
  requiresLabSource: true,
  acceptedMaterialIds: [],
  trial: null,
};
const unmet = (i: GateInput) =>
  checkApprovalGates(i)
    .gates.filter((g) => !g.met)
    .map((g) => g.id);

describe('approval gates (§14.1, 07 §2.5)', () => {
  it('all met', () => expect(checkApprovalGates(GOOD)).toMatchObject({ ok: true }));
  it('lists EVERY unmet gate, not just the first', () => {
    const r = unmet({
      ...GOOD,
      status: 'evaluated',
      approverId: 'u1',
      evaluation: { ...GOOD.evaluation!, validatorStatus: 'fail', verdict: 'fail' },
      current: { hasStored: true, rulesMatch: false, testsMatch: false },
    });
    expect(r).toEqual(['trial_passed', 'four_eyes', 'validator', 'compliance', 'evidence_current']);
  });
  it('unverified rules and provisional results block', () => {
    expect(
      unmet({ ...GOOD, evaluation: { ...GOOD.evaluation!, evidence: ['RULE_UNVERIFIED'] } }),
    ).toEqual(['rules_verified']);
    expect(unmet({ ...GOOD, evaluation: { ...GOOD.evaluation!, provisional: true } })).toEqual([
      'rules_verified',
    ]);
    expect(unmet({ ...GOOD, evaluation: null })).toContain('rules_verified');
  });
  it('an unknown author blocks (four-eyes)', () => {
    expect(unmet({ ...GOOD, authorId: null })).toEqual(['four_eyes']);
  });
  it('declared values need acceptance when lab source is required', () => {
    const declared = {
      ...GOOD,
      evaluation: {
        ...GOOD.evaluation!,
        dataQuality: [{ code: 'declared_values', materialId: 'm1' }],
      },
    };
    expect(unmet(declared)).toEqual(['declared_values']);
    expect(unmet({ ...declared, acceptedMaterialIds: ['m1'] })).toEqual([]);
    expect(unmet({ ...declared, requiresLabSource: false })).toEqual([]);
  });
  it('property: ok iff every gate is met; same-person approver is always refused', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (id) => {
        const r = checkApprovalGates({ ...GOOD, authorId: id, approverId: id });
        expect(r.ok).toBe(false);
        expect(r.ok).toBe(r.gates.every((g) => g.met));
      }),
    );
  });
});

const D = (o: Partial<DesignFacts> = {}): DesignFacts => ({
  lines: [
    { materialId: 'c', kg: 350, category: 'cement' },
    { materialId: 'w', kg: 170, category: 'water' },
    { materialId: 'a', kg: 2.1, category: 'admixture' },
  ],
  requirements: { fcMpa: 30 },
  ruleVersions: { r1: 1 },
  testVersions: { c: 1 },
  priceBasis: 'live',
  ...o,
});

describe('change classes (§14.3)', () => {
  it('identical is none; price only is information', () => {
    expect(classifyChange(D(), D()).classes).toEqual(['none']);
    const p = classifyChange(D(), D({ priceBasis: 'snap' }));
    expect(p.classes).toEqual(['price_only']);
    expect(p.requiresTrial).toBe(false);
  });
  it('a proportion change requires a trial; the policy "none" has no exemption', () => {
    const c = classifyChange(
      D(),
      D({
        lines: [
          { materialId: 'c', kg: 340, category: 'cement' },
          { materialId: 'w', kg: 170, category: 'water' },
          { materialId: 'a', kg: 2.1, category: 'admixture' },
        ],
      }),
    );
    expect(c.classes).toEqual(['proportion_change']);
    expect(c.requiresTrial).toBe(true);
    expect(c.deltas).toEqual([{ materialId: 'c', fromKg: 350, toKg: 340 }]);
  });
  it('a different admixture product requires a trial', () => {
    const c = classifyChange(
      D(),
      D({
        lines: [
          { materialId: 'c', kg: 350, category: 'cement' },
          { materialId: 'w', kg: 170, category: 'water' },
          { materialId: 'b', kg: 2.1, category: 'admixture' },
        ],
      }),
    );
    expect(c.classes).toContain('admixture_change');
    expect(c.requiresTrial).toBe(true);
  });
  it('rule and test changes are classes but need no automatic trial', () => {
    const c = classifyChange(D(), D({ ruleVersions: { r1: 2 }, testVersions: { c: 2 } }));
    expect(c.classes).toEqual(['rule_change', 'test_change']);
    expect(c.requiresTrial).toBe(false);
  });
});
