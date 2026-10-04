import { describe, expect, it } from 'vitest';
import {
  classifyInfeasibility,
  canonicalJson,
  projectRequirementsSchema,
  resolveGoverningLimits,
  toProjectOverrides,
  type GoverningLimit,
  type ProjectRequirementsContent,
} from '../src';

const basis = { specimen: 'cylinder', ageDays: 28, method: null } as const;
const lim = (over: Partial<GoverningLimit>): GoverningLimit => ({
  key: 'max_wcm',
  bound: 'max',
  value: 0.45,
  unit: 'ratio',
  basis,
  source: 'project',
  sourceRef: 'Spec §3.2',
  ...over,
});
const CONTENT: ProjectRequirementsContent = {
  standards: [
    { ruleset: 'JS', name: 'Jordanian Standard (SYNTHETIC reference)', edition: 'SYNTHETIC' },
  ],
  specification: { reference: 'SYNTHETIC-SPEC-1', revision: 'A' },
  strength: {
    designation: 'C30/37',
    basis: 'cylinder',
    specifiedMpa: 30,
    testAgeDays: 28,
    acceptanceMethod: 'SYNTHETIC acceptance method',
  },
  exposure: ['S2'],
  materialRestrictions: [],
  permittedSubstitutions: [],
  governingLimits: [lim({})],
};

describe('project requirements content', () => {
  it('accepts a complete record and rejects unknown fields and missing parts', () => {
    expect(projectRequirementsSchema.safeParse(CONTENT).success).toBe(true);
    expect(projectRequirementsSchema.safeParse({ ...CONTENT, surprise: 1 }).success).toBe(false);
    const { specification: _s, ...noSpec } = CONTENT;
    expect(projectRequirementsSchema.safeParse(noSpec).success).toBe(false);
    expect(projectRequirementsSchema.safeParse({ ...CONTENT, standards: [] }).success).toBe(false);
  });
  it('has one canonical text: key order does not matter, any value change does', () => {
    const reverse = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverse)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>)
                .reverse()
                .map(([k, x]) => [k, reverse(x)]),
            )
          : v;
    const reordered = reverse(CONTENT);
    expect(canonicalJson(CONTENT)).toBe(canonicalJson(projectRequirementsSchema.parse(reordered)));
    const changed = { ...CONTENT, strength: { ...CONTENT.strength, specifiedMpa: 35 } };
    expect(canonicalJson(changed)).not.toBe(canonicalJson(CONTENT));
  });
});

describe('comparable limits only', () => {
  it('chooses the stricter of comparable limits, and keeps the looser one visible as set aside', () => {
    const r = resolveGoverningLimits([
      lim({ value: 0.5, source: 'code', sourceRef: 'JS 7.3' }),
      lim({ value: 0.45 }),
    ]);
    expect(r.incompatible).toEqual([]);
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0]).toMatchObject({ value: 0.45, bound: 'max' });
    expect(r.resolved[0]!.governing.source).toBe('project');
    expect(r.resolved[0]!.setAsideLooser.map((l) => l.value)).toEqual([0.5]);
  });
  it('a min bound is stricter when larger', () => {
    const r = resolveGoverningLimits([
      lim({ key: 'min_cement', bound: 'min', value: 300, unit: 'kg/m3' }),
      lim({
        key: 'min_cement',
        bound: 'min',
        value: 320,
        unit: 'kg/m3',
        source: 'approved_internal',
      }),
    ]);
    expect(r.resolved[0]).toMatchObject({ value: 320 });
  });
  it.each([
    ['unit', { unit: 'percent' }],
    ['specimen', { basis: { specimen: 'cube', ageDays: 28, method: null } }],
    ['age', { basis: { specimen: 'cylinder', ageDays: 7, method: null } }],
    ['method', { basis: { specimen: 'cylinder', ageDays: 28, method: 'ASTM C39' } }],
  ] as const)(
    'does NOT pick a stricter value across a different %s: it reports the limits as incompatible',
    (reason, over) => {
      const r = resolveGoverningLimits([
        lim({ value: 0.5, source: 'code' }),
        lim({ value: 0.4, ...over }),
      ]);
      expect(r.resolved).toEqual([]);
      expect(r.incompatible).toHaveLength(1);
      expect(r.incompatible[0]!.reasons).toContain(reason);
      expect(r.incompatible[0]!.limits).toHaveLength(2);
    },
  );
  it('different keys or directions never interact', () => {
    const r = resolveGoverningLimits([
      lim({}),
      lim({ key: 'min_fc', bound: 'min', value: 30, unit: 'MPa' }),
    ]);
    expect(r.resolved).toHaveLength(2);
    expect(r.incompatible).toEqual([]);
  });
  it('only PROJECT limits become overrides for the rules resolver (which itself refuses any that loosen a code limit)', () => {
    const r = resolveGoverningLimits([
      lim({ value: 0.5, source: 'code', sourceRef: 'JS 7.3' }),
      lim({ value: 0.45 }),
      lim({
        key: 'min_cement',
        bound: 'min',
        value: 300,
        unit: 'kg/m3',
        source: 'approved_internal',
      }),
    ]);
    expect(toProjectOverrides(CONTENT, r)).toEqual([
      { requirement: 'max_wcm', value: 0.45, units: 'ratio', clause_ref: 'Spec §3.2' },
    ]);
  });
});

describe('why a requirement cannot be met', () => {
  it('names six classes and allows relaxing only a user preference', () => {
    const cases = [
      [{ klass: 'CODE' }, 'code_requirement', false],
      [{ source: 'project' as const }, 'project_requirement', false],
      [{ klass: 'ENGINEERING' }, 'approved_internal_requirement', false],
      [{ source: 'approved_internal' as const }, 'approved_internal_requirement', false],
      [{ klass: 'USER' }, 'user_preference', true],
      [{ klass: 'PHYSICAL' }, 'material_availability', false],
      [{ code: 'material_unusable' }, 'material_availability', false],
      [{ code: 'rule_not_on_file' }, 'missing_evidence', false],
      [{ code: 'parameter_missing' }, 'missing_evidence', false],
    ] as const;
    for (const [row, cls, adjustable] of cases)
      expect(classifyInfeasibility(row), JSON.stringify(row)).toEqual({ class: cls, adjustable });
    const adjustable = cases.filter(([, , a]) => a).map(([, c]) => c);
    expect(new Set(adjustable)).toEqual(new Set(['user_preference']));
  });
});
