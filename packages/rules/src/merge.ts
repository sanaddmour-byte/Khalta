import { numericValue, type RuleKind } from './schema';

export type RangeValue = Record<string, { min?: number; max?: number }>;

export type MergeResult =
  | { ok: true; value: unknown; winner: number }
  | { ok: false; code: 'empty_intersection' | 'conflict'; message: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function extreme(values: unknown[], pick: (a: number, b: number) => boolean): MergeResult {
  const nums = values.map(numericValue);
  if (nums.some((n) => n === null))
    return { ok: false, code: 'conflict', message: 'non-numeric value in a numeric limit' };
  let w = 0;
  for (let i = 1; i < nums.length; i++) if (pick(nums[i]!, nums[w]!)) w = i;
  return { ok: true, value: nums[w], winner: w };
}

/**
 * Merges several applicable values of ONE requirement into the strictest result (02-codes §3).
 * Used both across exposure classes within a code and across codes in Both mode.
 */
export function mergeValues(kind: RuleKind, values: unknown[]): MergeResult {
  if (values.length === 0) throw new Error('mergeValues needs at least one value');
  switch (kind) {
    case 'limit_max':
    case 'tolerance':
      return extreme(values, (a, b) => a < b); // lower of the values
    case 'limit_min':
      return extreme(values, (a, b) => a > b); // higher of the values
    case 'prohibition': {
      const i = values.findIndex((v) => v === true);
      return { ok: true, value: i >= 0, winner: Math.max(i, 0) }; // prohibited if any source prohibits
    }
    case 'allowed_set': {
      const sets = values as string[][];
      const inter = sets[0]!.filter((x) => sets.every((s) => s.includes(x)));
      return inter.length
        ? { ok: true, value: inter, winner: 0 }
        : {
            ok: false,
            code: 'empty_intersection',
            message: 'the allowed sets have nothing in common',
          };
    }
    case 'range': {
      const ranges = values as RangeValue[];
      const keys = [...new Set(ranges.flatMap((r) => Object.keys(r)))];
      const out: RangeValue = {};
      for (const k of keys) {
        const parts = ranges
          .map((r) => r[k])
          .filter((x): x is { min?: number; max?: number } => x !== undefined);
        const mins = parts.map((p) => p.min).filter((x): x is number => x !== undefined);
        const maxs = parts.map((p) => p.max).filter((x): x is number => x !== undefined);
        const min = mins.length ? Math.max(...mins) : undefined;
        const max = maxs.length ? Math.min(...maxs) : undefined;
        if (min !== undefined && max !== undefined && min > max)
          return {
            ok: false,
            code: 'empty_intersection',
            message: `the ranges for "${k}" do not overlap`,
          };
        out[k] = { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
      }
      return { ok: true, value: out, winner: 0 };
    }
    case 'info':
      return { ok: true, value: values, winner: 0 };
    default: // table | value | parameter: never auto-merged
      return values.every((v) => same(v, values[0]))
        ? { ok: true, value: values[0], winner: 0 }
        : {
            ok: false,
            code: 'conflict',
            message: 'different values from different rules; a policy decision is required',
          };
  }
}

export const TIGHTENABLE: readonly RuleKind[] = [
  'limit_max',
  'limit_min',
  'tolerance',
  'prohibition',
  'allowed_set',
  'range',
];

/** True if `proposed` is at least as strict as `base` (the PROJECT / characteristic layers may only tighten). */
export function isTighterOrEqual(kind: RuleKind, base: unknown, proposed: unknown): boolean {
  switch (kind) {
    case 'limit_max':
    case 'tolerance': {
      const b = numericValue(base);
      const p = numericValue(proposed);
      return b !== null && p !== null && p <= b;
    }
    case 'limit_min': {
      const b = numericValue(base);
      const p = numericValue(proposed);
      return b !== null && p !== null && p >= b;
    }
    case 'prohibition':
      return base === true ? proposed === true : typeof proposed === 'boolean';
    case 'allowed_set':
      return (
        Array.isArray(base) &&
        Array.isArray(proposed) &&
        proposed.length > 0 &&
        proposed.every((x) => base.includes(x))
      );
    case 'range': {
      const b = base as RangeValue;
      const p = proposed as RangeValue;
      return Object.entries(b).every(([k, bound]) => {
        const q = p[k];
        if (!q) return bound.min === undefined && bound.max === undefined;
        return (
          (bound.min === undefined || (q.min !== undefined && q.min >= bound.min)) &&
          (bound.max === undefined || (q.max !== undefined && q.max <= bound.max))
        );
      });
    }
    default:
      return false;
  }
}
