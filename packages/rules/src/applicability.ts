import type { RuleRecord } from './schema';

/** What the engine knows about the request when it asks "which rules apply?". */
export interface Context {
  exposure?: string[];
  s3_option?: number;
  air_entrained?: boolean;
  slump_mm?: number;
  fc_mpa?: number;
  nmas_mm?: number;
  [field: string]: unknown;
}

export type Applicability =
  { applies: 'yes' } | { applies: 'no' } | { applies: 'undetermined'; fields: string[] };

const NUMERIC_OPS = ['gt', 'gte', 'lt', 'lte', 'min', 'max'] as const;

function matches(cond: unknown, val: unknown): boolean {
  if (Array.isArray(cond))
    return Array.isArray(val) ? val.some((v) => cond.includes(v)) : cond.includes(val);
  if (cond !== null && typeof cond === 'object') {
    const c = cond as Record<string, number>;
    if (typeof val !== 'number') return false;
    return NUMERIC_OPS.every((op) => {
      const b = c[op];
      if (b === undefined) return true;
      return op === 'gt'
        ? val > b
        : op === 'gte' || op === 'min'
          ? val >= b
          : op === 'lt'
            ? val < b
            : val <= b;
    });
  }
  return cond === val;
}

/**
 * A rule applies when every `applies_to` condition matches the context. A condition on a field the
 * context does not provide is `undetermined` (never silently "applies" or "does not apply"), unless
 * another condition already rules the rule out.
 */
export function applicability(rule: Pick<RuleRecord, 'applies_to'>, ctx: Context): Applicability {
  const missing: string[] = [];
  for (const [field, cond] of Object.entries(rule.applies_to)) {
    const val = ctx[field];
    if (val === undefined) {
      missing.push(field);
      continue;
    }
    if (!matches(cond, val)) return { applies: 'no' };
  }
  return missing.length ? { applies: 'undetermined', fields: missing } : { applies: 'yes' };
}
