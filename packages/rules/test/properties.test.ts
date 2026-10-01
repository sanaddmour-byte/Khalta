import fc from 'fast-check';
import { describe, it } from 'vitest';
import { isTighterOrEqual, mergeValues } from '../src/merge';
import { resolve, type Mode } from '../src/resolver';
import type { RuleKind, RuleRecord } from '../src/schema';
import { mk } from './helpers';

const RUNS = { numRuns: 400 };
const val = fc.option(
  fc.integer({ min: 1, max: 100 }).map((n) => n / 100),
  { nil: null },
);
const vals = fc.array(val, { minLength: 1, maxLength: 3 });

function build(kind: RuleKind, aci: unknown[], js: unknown[]): RuleRecord[] {
  const make = (ruleset: string, list: unknown[]) =>
    list.map((value, i) =>
      mk({
        key: `${ruleset}.${i}`,
        ruleset,
        kind,
        requirement: 'x',
        value,
        units: 'ratio',
        applies_to: {},
      }),
    );
  return [...make('ACI', aci), ...make('JS', js)];
}
const out = (
  rules: RuleRecord[],
  mode: Mode,
  overrides: { requirement: string; value: unknown }[] = [],
) =>
  resolve(rules, { mode, context: {}, projectOverrides: overrides }).requirements.find(
    (r) => r.requirement === 'x',
  )!;
const known = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);

describe('Both mode is never less strict than either code (property tests)', () => {
  it('limit_max: the result is the minimum of every known value, whatever is missing', () => {
    fc.assert(
      fc.property(vals, vals, (a, j) => {
        const r = out(build('limit_max', a, j), 'BOTH');
        const k = known([...a, ...j]);
        if (k.length === 0) return r.status === 'blocked' && r.value === null;
        return r.value === Math.min(...k) && k.every((v) => (r.value as number) <= v);
      }),
      RUNS,
    );
  });

  it('limit_min: the result is the maximum of every known value', () => {
    fc.assert(
      fc.property(vals, vals, (a, j) => {
        const r = out(build('limit_min', a, j), 'BOTH');
        const k = known([...a, ...j]);
        if (k.length === 0) return r.status === 'blocked';
        return r.value === Math.max(...k) && k.every((v) => (r.value as number) >= v);
      }),
      RUNS,
    );
  });

  it('limit_max: Both ≤ ACI-only and ≤ JS-only whenever those are known', () => {
    fc.assert(
      fc.property(vals, vals, (a, j) => {
        const rules = build('limit_max', a, j);
        const both = out(rules, 'BOTH').value as number | null;
        const aci = out(rules, 'ACI').value as number | null;
        const js = out(rules, 'JS').value as number | null;
        if (both === null) return aci === null && js === null;
        return (aci === null || both <= aci) && (js === null || both <= js);
      }),
      RUNS,
    );
  });

  it('is provisional exactly when something applicable has no value, and resolved otherwise', () => {
    fc.assert(
      fc.property(vals, vals, (a, j) => {
        const r = out(build('limit_max', a, j), 'BOTH');
        const anyMissing = [...a, ...j].some((v) => v === null);
        const anyKnown = [...a, ...j].some((v) => v !== null);
        if (!anyKnown) return r.status === 'blocked';
        return anyMissing ? r.status === 'provisional' : r.status === 'resolved';
      }),
      RUNS,
    );
  });

  it('result does not depend on rule order', () => {
    fc.assert(
      fc.property(vals, vals, fc.infiniteStream(fc.nat()), (a, j, _s) => {
        const rules = build('limit_max', a, j);
        const shuffled = [...rules].sort((x, y) => (x.key < y.key ? 1 : -1));
        const r1 = out(rules, 'BOTH');
        const r2 = out(shuffled, 'BOTH');
        return r1.value === r2.value && r1.status === r2.status;
      }),
      RUNS,
    );
  });

  it('allowed_set: the result is a subset of every source that has a value, or blocked when empty', () => {
    const set = fc.subarray(['moderate', 'high', 'none'], { minLength: 1 });
    fc.assert(
      fc.property(set, set, (a, j) => {
        const r = out(build('allowed_set', [a], [j]), 'BOTH');
        const inter = a.filter((x) => j.includes(x));
        if (inter.length === 0)
          return r.status === 'blocked' && r.issues.some((i) => i.code === 'empty_intersection');
        return JSON.stringify(r.value) === JSON.stringify(inter);
      }),
      RUNS,
    );
  });

  it('prohibition: prohibited iff any source prohibits', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        (a, j) => out(build('prohibition', [a], [j]), 'BOTH').value === (a || j),
      ),
      RUNS,
    );
  });

  it('range: the result is inside both ranges, or blocked when they do not overlap', () => {
    const range = fc
      .tuple(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }))
      .map(([x, y]) => ({ '19': { min: Math.min(x, y), max: Math.max(x, y) } }));
    fc.assert(
      fc.property(range, range, (a, j) => {
        const r = out(build('range', [a], [j]), 'BOTH');
        const lo = Math.max(a['19'].min, j['19'].min);
        const hi = Math.min(a['19'].max, j['19'].max);
        if (lo > hi) return r.status === 'blocked';
        const v = (r.value as Record<string, { min: number; max: number }>)['19']!;
        return (
          v.min === lo &&
          v.max === hi &&
          isTighterOrEqual('range', a, r.value) &&
          isTighterOrEqual('range', j, r.value)
        );
      }),
      RUNS,
    );
  });
});

describe('the PROJECT layer can only tighten (property tests)', () => {
  const base = fc.integer({ min: 1, max: 100 }).map((n) => n / 100);
  const prop = fc.integer({ min: 1, max: 150 }).map((n) => n / 100);

  it('limit_max: accepted iff not looser, and the final value is never above the code value', () => {
    fc.assert(
      fc.property(base, prop, (b, p) => {
        const rules = build('limit_max', [b], []);
        const r = resolve(rules, {
          mode: 'ACI',
          context: {},
          projectOverrides: [{ requirement: 'x', value: p }],
        });
        const x = r.requirements[0]!;
        const accepted = r.rejectedOverrides.length === 0;
        return (
          accepted === p <= b &&
          (x.value as number) <= b &&
          (accepted ? x.value === Math.min(b, p) : x.value === b)
        );
      }),
      RUNS,
    );
  });

  it('limit_min: accepted iff not looser, and the final value is never below the code value', () => {
    fc.assert(
      fc.property(base, prop, (b, p) => {
        const rules = build('limit_min', [b], []);
        const r = resolve(rules, {
          mode: 'ACI',
          context: {},
          projectOverrides: [{ requirement: 'x', value: p }],
        });
        const x = r.requirements[0]!;
        const accepted = r.rejectedOverrides.length === 0;
        return accepted === p >= b && (x.value as number) >= b;
      }),
      RUNS,
    );
  });

  it('works through Both mode too: the final value is never looser than the stricter code', () => {
    fc.assert(
      fc.property(vals, vals, prop, (a, j, p) => {
        const rules = build('limit_max', a, j);
        const baseVal = out(rules, 'BOTH').value as number | null;
        const x = out(rules, 'BOTH', [{ requirement: 'x', value: p }]);
        if (baseVal === null) return true;
        return (x.value as number) <= baseVal;
      }),
      RUNS,
    );
  });
});

describe('mergeValues algebra', () => {
  it('is commutative and idempotent for limit kinds', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<RuleKind>('limit_max', 'limit_min', 'tolerance'),
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 1, max: 99 }),
        (kind, a, b) => {
          const ab = mergeValues(kind, [a, b]);
          const ba = mergeValues(kind, [b, a]);
          const aa = mergeValues(kind, [a, a]);
          return ab.ok && ba.ok && aa.ok && ab.value === ba.value && aa.value === a;
        },
      ),
      RUNS,
    );
  });
});
