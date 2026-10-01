import { describe, expect, it } from 'vitest';
import { applicability } from '../src/applicability';
import { loadSeeds } from '../src/loader';
import { isTighterOrEqual, mergeValues } from '../src/merge';
import { approvalBlockers, resolve, type ResolveResult } from '../src/resolver';
import type { RuleRecord } from '../src/schema';
import { mk } from './helpers';

const { rules: seeds } = loadSeeds();
const req = (r: ResolveResult, name: string) => r.requirements.find((x) => x.requirement === name)!;
/** Seeds as the resolver sees them, with JS values filled in for the given keys. */
const withJs = (values: Record<string, unknown>, verified = false): RuleRecord[] =>
  seeds.map((r) =>
    r.ruleset === 'JS' && r.key in values
      ? { ...r, value: values[r.key], verified, clause_ref: `JSC-2022 §${r.key}` }
      : r,
  );
const verifiedAll = (rs: RuleRecord[]): RuleRecord[] => rs.map((r) => ({ ...r, verified: true }));

describe('applicability', () => {
  it('matches lists, scalars and numeric ranges, and reports missing context instead of guessing', () => {
    expect(
      applicability({ applies_to: { exposure: ['S2'] } }, { exposure: ['F0', 'S2'] }).applies,
    ).toBe('yes');
    expect(applicability({ applies_to: { exposure: ['S2'] } }, { exposure: ['F0'] }).applies).toBe(
      'no',
    );
    expect(
      applicability({ applies_to: { slump_mm: { gt: 50, lte: 100 } } }, { slump_mm: 50 }).applies,
    ).toBe('no');
    expect(
      applicability({ applies_to: { slump_mm: { gt: 50, lte: 100 } } }, { slump_mm: 100 }).applies,
    ).toBe('yes');
    expect(
      applicability({ applies_to: { air_entrained: false } }, { air_entrained: false }).applies,
    ).toBe('yes');
    expect(applicability({ applies_to: { s3_option: 1 } }, {})).toEqual({
      applies: 'undetermined',
      fields: ['s3_option'],
    });
    expect(applicability({ applies_to: {} }, {}).applies).toBe('yes');
  });
  it('a definite "no" beats a missing field', () => {
    expect(
      applicability({ applies_to: { exposure: ['S3'], s3_option: 1 } }, { exposure: ['F0'] })
        .applies,
    ).toBe('no');
  });
});

describe('mergeValues: one result per kind (02-codes §3)', () => {
  it('limit_max takes the lower, limit_min the higher, tolerance the tighter', () => {
    expect(mergeValues('limit_max', [0.5, 0.45])).toEqual({ ok: true, value: 0.45, winner: 1 });
    expect(mergeValues('limit_min', [28, 31])).toEqual({ ok: true, value: 31, winner: 1 });
    expect(mergeValues('tolerance', [25, 15])).toEqual({ ok: true, value: 15, winner: 1 });
    expect(mergeValues('limit_max', ['1/3', 0.5])).toMatchObject({ value: 1 / 3 });
  });
  it('prohibition is prohibited if either says so', () => {
    expect(mergeValues('prohibition', [false, true])).toMatchObject({ value: true });
    expect(mergeValues('prohibition', [false, false])).toMatchObject({ value: false });
  });
  it('allowed_set intersects and fails loudly when empty', () => {
    expect(mergeValues('allowed_set', [['moderate', 'high'], ['high']])).toMatchObject({
      value: ['high'],
    });
    expect(mergeValues('allowed_set', [['a'], ['b']])).toMatchObject({
      ok: false,
      code: 'empty_intersection',
    });
  });
  it('range intersects per sieve and fails when disjoint', () => {
    expect(
      mergeValues('range', [
        { '19': { min: 90, max: 100 } },
        { '19': { min: 95 }, '9.5': { max: 40 } },
      ]),
    ).toMatchObject({
      value: { '19': { min: 95, max: 100 }, '9.5': { max: 40 } },
    });
    expect(mergeValues('range', [{ '19': { min: 90 } }, { '19': { max: 80 } }])).toMatchObject({
      ok: false,
      code: 'empty_intersection',
    });
  });
  it('value/parameter/table never auto-merge unless identical', () => {
    expect(mergeValues('value', [1, 1])).toMatchObject({ ok: true });
    expect(mergeValues('parameter', [1, 2])).toMatchObject({ ok: false, code: 'conflict' });
    expect(mergeValues('table', [{ a: 1 }, { a: 2 }])).toMatchObject({
      ok: false,
      code: 'conflict',
    });
  });
  it('info is collected, never a constraint', () =>
    expect(mergeValues('info', ['a', 'b'])).toMatchObject({ value: ['a', 'b'] }));
});

describe('resolving the real ACI seeds', () => {
  const ctx = { exposure: ['F0', 'S2', 'W0', 'C1'], fc_mpa: 30, slump_mm: 125 };
  const r = resolve(seeds, { mode: 'ACI', context: ctx });

  it('takes the strictest limit across exposure classes and names its rule and clause', () => {
    const w = req(r, 'max_wcm');
    expect(w.value).toBe(0.45);
    expect(w.governing).toMatchObject({
      source: 'ACI',
      ruleKey: 'durability.S2.max_wcm',
      clause_ref: 'ACI 318-19 Table 19.3.2.1',
      requirement_class: 'CODE_HARD',
    });
    expect(req(r, 'min_fc').value).toBe(31); // S2 beats F0/W0/C1 (17)
    expect(req(r, 'min_fc').governing?.ruleKey).toBe('durability.S2.min_fc');
  });
  it('resolves chloride, prohibition and cement requirements for the classes present', () => {
    expect(req(r, 'max_cl_nonprestressed').value).toBe(0.3);
    expect(req(r, 'max_cl_prestressed').value).toBe(0.06);
    expect(req(r, 'cacl2_prohibited').value).toBe(true);
    expect(req(r, 'sulfate_cement').value).toEqual(['high']);
  });
  it('does not apply rules for classes the request does not have', () => {
    expect(r.requirements.find((x) => x.requirement === 'air_target_pct')).toBeUndefined();
    expect(req(r, 'max_wcm').contributions.map((c) => c.ruleKey)).toEqual([
      'durability.S2.max_wcm',
    ]);
  });
  it('picks the right slump tolerance band from the request', () => {
    expect(req(r, 'slump_tolerance_mm').value).toBe(40);
    expect(
      req(resolve(seeds, { mode: 'ACI', context: { ...ctx, slump_mm: 75 } }), 'slump_tolerance_mm')
        .value,
    ).toBe(25);
    expect(
      req(resolve(seeds, { mode: 'ACI', context: { ...ctx, slump_mm: 50 } }), 'slump_tolerance_mm')
        .value,
    ).toBe(15);
  });
  it('is resolved but NOT verified, so approval is blocked and lists every unverified rule', () => {
    expect(req(r, 'max_wcm').status).toBe('resolved');
    expect(req(r, 'max_wcm').verified).toBe(false);
    const b = approvalBlockers(r);
    expect(b.approvable).toBe(false);
    expect(b.unverified.map((u) => u.ruleKey)).toContain('durability.S2.max_wcm');
  });
  it('combines two exposure classes of different severity', () => {
    const x = resolve(seeds, { mode: 'ACI', context: { exposure: ['F2', 'S1'] } });
    expect(req(x, 'max_wcm').value).toBe(0.45); // F2 0.45 vs S1 0.50
    expect(req(x, 'max_wcm').governing?.ruleKey).toBe('durability.F2.max_wcm');
    expect(req(x, 'min_fc').value).toBe(31);
  });
});

describe('missing context is a named blocker, never a guess', () => {
  it('S3 without an option cannot be resolved', () => {
    const x = resolve(seeds, { mode: 'ACI', context: { exposure: ['S3'] } });
    const w = req(x, 'max_wcm');
    expect(w.status).toBe('blocked');
    expect(w.value).toBeNull();
    expect(w.issues.map((i) => i.code)).toContain('context_missing');
    expect(w.issues.find((i) => i.code === 'context_missing')?.fields).toEqual(['s3_option']);
    expect(approvalBlockers(x).approvable).toBe(false);
  });
  it('S3 option 1 and 2 give their own limits', () => {
    const o1 = resolve(seeds, { mode: 'ACI', context: { exposure: ['S3'], s3_option: 1 } });
    const o2 = resolve(seeds, { mode: 'ACI', context: { exposure: ['S3'], s3_option: 2 } });
    expect([req(o1, 'max_wcm').value, req(o1, 'min_fc').value]).toEqual([0.45, 31]);
    expect([req(o2, 'max_wcm').value, req(o2, 'min_fc').value]).toEqual([0.4, 35]);
    expect(req(o1, 'scm_required').value).toEqual(['pozzolan', 'slag']);
    expect(req(o2, 'scm_required')).toBeUndefined();
  });
  it('a slump tolerance without a slump is blocked', () => {
    const x = resolve(seeds, { mode: 'ACI', context: { exposure: ['F0'] } });
    expect(req(x, 'slump_tolerance_mm').status).toBe('blocked');
  });
});

describe('nothing on file', () => {
  it('JS mode on the empty skeleton resolves nothing and says why', () => {
    const x = resolve(seeds, { mode: 'JS', context: { exposure: ['S2'] } });
    const w = req(x, 'max_wcm');
    expect(w.status).toBe('blocked');
    expect(w.issues.map((i) => i.code)).toEqual(['value_missing']);
    expect(w.contributions.every((c) => c.value === null)).toBe(true);
  });
  it('Both mode runs PROVISIONALLY on ACI when JS is empty ("missing is never evidence the other side suffices")', () => {
    const x = resolve(seeds, { mode: 'BOTH', context: { exposure: ['S2'] } });
    const w = req(x, 'max_wcm');
    expect(w.status).toBe('provisional');
    expect(w.value).toBe(0.45);
    expect(w.issues.map((i) => i.code)).toContain('other_side_missing');
    expect(approvalBlockers(x).missing.map((m) => m.source)).toContain('JS');
  });
  it('air-entrained design aids that are not on file stay missing', () => {
    const x = resolve(seeds, { mode: 'ACI', context: { exposure: ['F0'], air_entrained: true } });
    expect(req(x, 'prop.water.ae').status).toBe('blocked');
  });
});

describe('Both mode with Jordanian values', () => {
  it('lower of the two limits governs, with the winning code and clause named', () => {
    const rs = withJs({ 'durability.S2.max_wcm': 0.4, 'durability.S2.min_fc': 25 });
    const x = resolve(rs, { mode: 'BOTH', context: { exposure: ['S2'] } });
    expect(req(x, 'max_wcm')).toMatchObject({ value: 0.4, status: 'resolved' });
    expect(req(x, 'max_wcm').governing).toMatchObject({
      source: 'JS',
      clause_ref: 'JSC-2022 §durability.S2.max_wcm',
    });
    expect(req(x, 'min_fc').value).toBe(31); // ACI 31 > JS 25: the higher governs
    expect(req(x, 'min_fc').governing?.source).toBe('ACI');
  });
  it('is never less strict than either code alone', () => {
    const rs = withJs({ 'durability.S2.max_wcm': 0.5 });
    const both = req(resolve(rs, { mode: 'BOTH', context: { exposure: ['S2'] } }), 'max_wcm')
      .value as number;
    const aci = req(resolve(rs, { mode: 'ACI', context: { exposure: ['S2'] } }), 'max_wcm')
      .value as number;
    const js = req(resolve(rs, { mode: 'JS', context: { exposure: ['S2'] } }), 'max_wcm')
      .value as number;
    expect(both).toBeLessThanOrEqual(Math.min(aci, js));
  });
  it('JS may inherit an ACI value by reference; verification stays separate', () => {
    const rs = seeds.map((r) =>
      r.id === 'JS:durability.S2.max_wcm'
        ? { ...r, inherits: 'ACI:durability.S2.max_wcm', verified: false }
        : r.id === 'ACI:durability.S2.max_wcm'
          ? { ...r, verified: true }
          : r,
    );
    const x = resolve(rs, { mode: 'JS', context: { exposure: ['S2'] } });
    expect(req(x, 'max_wcm').value).toBe(0.45);
    expect(req(x, 'max_wcm').verified).toBe(false); // the JS row itself is unverified
  });
  it('an empty cement-class intersection is infeasible with a reason', () => {
    const rs = withJs({ 'durability.S2.sulfate_cement': ['none'] });
    const x = resolve(rs, { mode: 'BOTH', context: { exposure: ['S2'] } });
    const c = req(x, 'sulfate_cement');
    expect(c.status).toBe('blocked');
    expect(c.issues.map((i) => i.code)).toContain('empty_intersection');
  });
  it('prohibition: prohibited if either code prohibits', () => {
    const rs = [
      mk({ key: 'a', ruleset: 'ACI', kind: 'prohibition', requirement: 'x', value: false }),
      mk({ key: 'j', ruleset: 'JS', kind: 'prohibition', requirement: 'x', value: true }),
    ];
    expect(req(resolve(rs, { mode: 'BOTH', context: {} }), 'x').value).toBe(true);
  });
  it('tables defined by both codes are never merged: a policy is required, then honoured', () => {
    const t = (v: number) => ({
      cols: { name: 'n', values: [1, 2] },
      data: [[v, v]],
      interpolation: 'linear' as const,
    });
    const rs = [
      mk({
        key: 'a',
        ruleset: 'ACI',
        kind: 'table',
        requirement: 't',
        definition: t(1),
        requirement_class: 'DESIGN_AID',
      }),
      mk({
        key: 'j',
        ruleset: 'JS',
        kind: 'table',
        requirement: 't',
        definition: t(2),
        requirement_class: 'DESIGN_AID',
      }),
    ];
    const blocked = req(resolve(rs, { mode: 'BOTH', context: {} }), 't');
    expect(blocked.status).toBe('blocked');
    expect(blocked.issues.map((i) => i.code)).toEqual(['table_policy_required']);
    const chosen = req(resolve(rs, { mode: 'BOTH', context: {}, tablePolicy: { t: 'JS' } }), 't');
    expect(chosen.status).toBe('resolved');
    expect(chosen.governing?.source).toBe('JS');
  });
  it('a design aid defined by only one code needs no policy', () => {
    const x = resolve(seeds, {
      mode: 'BOTH',
      context: { exposure: ['F0'], air_entrained: false, slump_mm: 100 },
    });
    expect(req(x, 'prop.water.non_ae').status).toBe('resolved');
    expect(req(x, 'prop.water.non_ae').governing?.requirement_class).toBe('DESIGN_AID');
  });
});

describe('PROJECT layer: tighten only', () => {
  const ctx = { exposure: ['S2'] };
  it('accepts a tighter project limit and makes PROJECT the governing source', () => {
    const x = resolve(seeds, {
      mode: 'ACI',
      context: ctx,
      projectOverrides: [{ requirement: 'max_wcm', value: 0.4, clause_ref: 'Spec 03300 §2.4' }],
    });
    expect(req(x, 'max_wcm')).toMatchObject({ value: 0.4 });
    expect(req(x, 'max_wcm').governing).toMatchObject({
      source: 'PROJECT',
      clause_ref: 'Spec 03300 §2.4',
      requirement_class: 'PROJECT_HARD',
    });
    expect(x.rejectedOverrides).toEqual([]);
  });
  it('REJECTS a looser project limit, naming the code limit, its source and clause', () => {
    const x = resolve(seeds, {
      mode: 'ACI',
      context: ctx,
      projectOverrides: [{ requirement: 'max_wcm', value: 0.5 }],
    });
    expect(req(x, 'max_wcm').value).toBe(0.45); // unchanged
    expect(x.rejectedOverrides).toHaveLength(1);
    expect(x.rejectedOverrides[0]).toMatchObject({
      requirement: 'max_wcm',
      code: 'override_loosens',
      proposed: 0.5,
      allowed: 0.45,
    });
    expect(x.rejectedOverrides[0]!.governing).toMatchObject({
      source: 'ACI',
      clause_ref: 'ACI 318-19 Table 19.3.2.1',
    });
    expect(approvalBlockers(x).approvable).toBe(false);
  });
  it('an equal override is accepted without changing the governing code', () => {
    const x = resolve(seeds, {
      mode: 'ACI',
      context: ctx,
      projectOverrides: [{ requirement: 'max_wcm', value: 0.45 }],
    });
    expect(req(x, 'max_wcm').governing?.source).toBe('ACI');
    expect(x.rejectedOverrides).toEqual([]);
  });
  it('tightening works per kind: min, prohibition, set, tolerance', () => {
    const x = resolve(seeds, {
      mode: 'ACI',
      context: { exposure: ['S1'], slump_mm: 125 },
      projectOverrides: [
        { requirement: 'min_fc', value: 35 },
        { requirement: 'sulfate_cement', value: ['high'] },
        { requirement: 'cacl2_prohibited', value: true, kind: 'prohibition' },
        { requirement: 'slump_tolerance_mm', value: 25 },
      ],
    });
    expect(x.rejectedOverrides).toEqual([]);
    expect(req(x, 'min_fc').value).toBe(35);
    expect(req(x, 'sulfate_cement').value).toEqual(['high']);
    expect(req(x, 'cacl2_prohibited').value).toBe(true); // a project may prohibit even where the code allows
    expect(req(x, 'slump_tolerance_mm').value).toBe(25);
    const bad = resolve(seeds, {
      mode: 'ACI',
      context: { exposure: ['S1'], slump_mm: 125 },
      projectOverrides: [
        { requirement: 'min_fc', value: 20 },
        { requirement: 'sulfate_cement', value: ['moderate', 'high', 'none'] },
        { requirement: 'slump_tolerance_mm', value: 50 },
      ],
    });
    expect(bad.rejectedOverrides.map((r) => r.requirement)).toEqual([
      'min_fc',
      'sulfate_cement',
      'slump_tolerance_mm',
    ]);
  });
  it('a project-only requirement (not in the codes) is added as PROJECT_HARD', () => {
    const x = resolve(seeds, {
      mode: 'ACI',
      context: ctx,
      projectOverrides: [
        {
          requirement: 'max_placing_temp_c',
          value: 32,
          kind: 'limit_max',
          units: 'degC',
          clause_ref: 'Spec §1.9',
        },
      ],
    });
    expect(req(x, 'max_placing_temp_c')).toMatchObject({
      value: 32,
      status: 'resolved',
      verified: true,
    });
    expect(req(x, 'max_placing_temp_c').governing?.requirement_class).toBe('PROJECT_HARD');
  });
  it('hot weather: a project may lower 35 °C to 32 °C but not raise it', () => {
    const ok = resolve(seeds, {
      mode: 'ACI',
      context: ctx,
      projectOverrides: [{ requirement: 'hot.max_concrete_temp_c', value: 32 }],
    });
    expect(req(ok, 'hot.max_concrete_temp_c').value).toBe(32);
    const no = resolve(seeds, {
      mode: 'ACI',
      context: ctx,
      projectOverrides: [{ requirement: 'hot.max_concrete_temp_c', value: 38 }],
    });
    expect(no.rejectedOverrides[0]?.code).toBe('override_loosens');
  });
  it('tables, parameters and kind mismatches cannot be overridden', () => {
    const x = resolve(seeds, {
      mode: 'ACI',
      context: { exposure: ['F0'], fc_mpa: 30 },
      projectOverrides: [
        { requirement: 'fcr.statistical.min_tests', value: 10 }, // a parameter
        { requirement: 'prop.wc_strength.non_ae', value: 1, kind: 'limit_max' },
      ],
    });
    expect(x.rejectedOverrides.map((r) => r.code)).toEqual([
      'override_not_allowed',
      'override_not_allowed',
    ]);
    const mismatch = resolve(seeds, {
      mode: 'ACI',
      context: ctx,
      projectOverrides: [{ requirement: 'max_wcm', value: 0.4, kind: 'limit_min' }],
    });
    expect(mismatch.rejectedOverrides[0]?.code).toBe('override_kind_mismatch');
  });
  it('against an empty code value the project value stands but the result stays provisional', () => {
    const x = resolve(seeds, {
      mode: 'JS',
      context: ctx,
      projectOverrides: [{ requirement: 'max_wcm', value: 0.4 }],
    });
    expect(req(x, 'max_wcm')).toMatchObject({ value: 0.4, status: 'provisional' });
  });
});

describe('isTighterOrEqual', () => {
  it('compares by kind', () => {
    expect(isTighterOrEqual('limit_max', 0.45, 0.45)).toBe(true);
    expect(isTighterOrEqual('limit_max', 0.45, 0.46)).toBe(false);
    expect(isTighterOrEqual('limit_min', 28, 31)).toBe(true);
    expect(isTighterOrEqual('prohibition', true, false)).toBe(false);
    expect(isTighterOrEqual('allowed_set', ['a', 'b'], ['a'])).toBe(true);
    expect(isTighterOrEqual('allowed_set', ['a'], [])).toBe(false);
    expect(
      isTighterOrEqual('range', { '19': { min: 90, max: 100 } }, { '19': { min: 95, max: 99 } }),
    ).toBe(true);
    expect(isTighterOrEqual('range', { '19': { min: 90 } }, {})).toBe(false);
    expect(isTighterOrEqual('table', 1, 1)).toBe(false);
  });
});

describe('informational rows', () => {
  it('C2 minimum cover is listed but is never a gap or a constraint', () => {
    const x = resolve(seeds, { mode: 'ACI', context: { exposure: ['C2'] } });
    const cover = req(x, 'min_cover');
    expect(cover).toMatchObject({ kind: 'info', status: 'resolved', value: null });
    const b = approvalBlockers(x);
    expect(b.missing.map((m) => m.ruleKey)).not.toContain('durability.C2.min_cover');
    expect(b.unverified.map((m) => m.ruleKey)).not.toContain('durability.C2.min_cover');
  });
  it('W2 states that ASR mitigation is required, as information', () => {
    expect(
      req(resolve(seeds, { mode: 'ACI', context: { exposure: ['W2'] } }), 'asr_mitigation').value,
    ).toEqual(['required']);
  });
});

describe('approval gate', () => {
  const full = { exposure: ['F0', 'S2'], slump_mm: 100, fc_mpa: 30, air_entrained: false };
  const notNull = (r: RuleRecord) =>
    r.value !== null || (r.definition !== null && r.definition !== undefined);
  it('passes only when every contributing rule has a verified value and nothing is incomplete', () => {
    const complete = verifiedAll(seeds).filter(
      (r) => r.ruleset === 'ACI' && (notNull(r) || r.kind === 'info'),
    );
    expect(approvalBlockers(resolve(complete, { mode: 'ACI', context: full }))).toMatchObject({
      unverified: [],
      missing: [],
      incomplete: [],
      approvable: true,
    });
  });
  it('the real seeds can never pass yet: grading limits are not on file, and everything is unverified', () => {
    const b = approvalBlockers(resolve(seeds, { mode: 'ACI', context: full }));
    expect(b.approvable).toBe(false);
    expect(b.missing.map((m) => m.ruleKey)).toEqual(
      expect.arrayContaining(['grading.fine.limits', 'grading.coarse.limits']),
    );
    expect(b.unverified.length).toBeGreaterThan(10);
  });
  it('Both mode stays blocked while the Jordanian side is empty, even if ACI is fully verified', () => {
    expect(
      approvalBlockers(resolve(verifiedAll(seeds), { mode: 'BOTH', context: full })).approvable,
    ).toBe(false);
  });
  it('is blocked by one unverified rule, naming it', () => {
    const rs = verifiedAll(seeds).map((r) =>
      r.id === 'ACI:durability.S2.max_wcm' ? { ...r, verified: false } : r,
    );
    const b = approvalBlockers(resolve(rs, { mode: 'ACI', context: { exposure: ['S2'] } }));
    expect(b.approvable).toBe(false);
    expect(b.unverified).toEqual([
      { requirement: 'max_wcm', ruleKey: 'durability.S2.max_wcm', source: 'ACI' },
    ]);
  });
  it('is blocked when Both mode has a verified ACI value and a verified JS value only on one side', () => {
    const rs = verifiedAll(withJs({ 'durability.S2.max_wcm': 0.45 }));
    const b = approvalBlockers(resolve(rs, { mode: 'BOTH', context: { exposure: ['S2'] } }));
    expect(b.missing.some((m) => m.source === 'JS')).toBe(true);
  });
});

describe('determinism', () => {
  it('rule order does not change the result', () => {
    const ctx = { exposure: ['F2', 'S2', 'C1'], fc_mpa: 40, slump_mm: 80 };
    const a = resolve(seeds, { mode: 'BOTH', context: ctx });
    const b = resolve([...seeds].reverse(), { mode: 'BOTH', context: ctx });
    const strip = (r: ResolveResult) =>
      r.requirements.map((x) => [x.requirement, x.value, x.status]);
    expect(strip(b)).toEqual(strip(a));
  });
});
