// Rule schema (M0.4). Enumerations come from CLAUDE.md / 01-domain §2.4 / Appendix A / Addendum A1.
import { z } from 'zod';

export const RULE_KINDS = [
  'limit_max',
  'limit_min',
  'allowed_set',
  'prohibition',
  'range',
  'tolerance',
  'table',
  'value',
  'info',
  'parameter',
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const REQUIREMENT_CLASSES = [
  'CODE_HARD',
  'PROJECT_HARD',
  'EMPIRICAL_CALIBRATED',
  'ENGINEERING_GUARDRAIL',
  'OPTIMIZATION_PREFERENCE',
  'DESIGN_AID',
  'USER_SPECIFIED', // Addendum A1: never used by seeds; produced by request/profile characteristics
] as const;
export type RequirementClass = (typeof REQUIREMENT_CLASSES)[number];

// Closed list: unit confusion (MPa vs kg/cm², ppm vs %) is caught at load and import time.
export const UNITS = [
  'ratio',
  'MPa',
  'kg/m3',
  '%',
  'ppm',
  'mm',
  'degC',
  'fraction',
  'L/m3',
  'kg/cm2',
  'days',
  'none',
] as const;
export type Units = (typeof UNITS)[number];

/** Rulesets whose rules are merged by Both mode. Everything else is single-source. */
export const CODE_RULESETS = ['ACI', 'JS'] as const;

const FRACTION = /^\d+\/\d+$/;
const KEY = /^[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*$/;

export const tableDefinitionSchema = z
  .strictObject({
    rows: z
      .strictObject({
        name: z.string(),
        values: z.array(z.union([z.number(), z.tuple([z.number(), z.number()])])).min(1),
      })
      .optional(),
    cols: z.strictObject({ name: z.string(), values: z.array(z.number()).min(1) }),
    data: z.array(z.array(z.number().nullable())).min(1),
    interpolation: z.enum(['linear', 'none']),
  })
  .superRefine((t, ctx) => {
    const rows = t.rows ? t.rows.values.length : 1;
    if (t.data.length !== rows)
      ctx.addIssue({ code: 'custom', message: `data has ${t.data.length} rows, expected ${rows}` });
    for (const [i, r] of t.data.entries())
      if (r.length !== t.cols.values.length)
        ctx.addIssue({
          code: 'custom',
          message: `data row ${i} has ${r.length} cells, expected ${t.cols.values.length}`,
        });
    const sorted = t.cols.values.every((v, i, a) => i === 0 || v > a[i - 1]!);
    if (!sorted)
      ctx.addIssue({ code: 'custom', message: 'cols.values must be strictly ascending' });
    if (t.rows && t.rows.values.every((v) => typeof v === 'number')) {
      const nums = t.rows.values as number[];
      if (!nums.every((v, i, a) => i === 0 || v > a[i - 1]!))
        ctx.addIssue({ code: 'custom', message: 'rows.values must be strictly ascending' });
    }
  });
export type TableDefinition = z.infer<typeof tableDefinitionSchema>;

/** Checks that a scalar/structured `value` has the shape its kind requires. Returns an error or null. */
export function validateValue(kind: RuleKind, value: unknown): string | null {
  if (value === null || value === undefined) return null; // "not on file" is always allowed
  const numeric = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  switch (kind) {
    case 'limit_max':
    case 'limit_min':
    case 'tolerance':
      return numeric(value) || (typeof value === 'string' && FRACTION.test(value))
        ? null
        : `${kind} needs a number (or a fraction like "1/3")`;
    case 'prohibition':
      return typeof value === 'boolean' ? null : 'prohibition needs true or false';
    case 'allowed_set':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? null
        : 'allowed_set needs a list of strings';
    case 'range': {
      if (typeof value !== 'object' || Array.isArray(value))
        return 'range needs an object of {min,max} per key';
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v !== 'object' || v === null) return `range entry "${k}" must be {min?,max?}`;
        const { min, max } = v as { min?: unknown; max?: unknown };
        if ((min !== undefined && !numeric(min)) || (max !== undefined && !numeric(max)))
          return `range entry "${k}" needs numeric min/max`;
        if (numeric(min) && numeric(max) && (min as number) > (max as number))
          return `range entry "${k}" has min above max`;
      }
      return null;
    }
    case 'table':
      return 'table rules carry their data in `definition`, not `value`';
    default:
      return null; // value | info | parameter: any JSON
  }
}

const appliesToSchema = z.record(z.string(), z.unknown());

export const ruleSchema = z
  .strictObject({
    key: z.string().regex(KEY, 'key must be dotted identifiers'),
    requirement: z.string().regex(KEY).optional(),
    kind: z.enum(RULE_KINDS),
    requirement_class: z.enum(REQUIREMENT_CLASSES),
    group: z.string().optional(),
    applies_to: appliesToSchema.default({}),
    prerequisites: z.array(z.string()).default([]),
    value: z.unknown().optional(),
    definition: tableDefinitionSchema.nullable().optional(),
    inherits: z
      .string()
      .regex(/^[A-Z0-9_]+:[A-Za-z0-9_.-]+$/, 'inherits must look like "ACI:<rule_key>"')
      .optional(),
    units: z.enum(UNITS),
    clause_ref: z.string().min(1),
    source_doc: z.string().optional(),
    valid_from: z.string().optional(),
    valid_to: z.string().optional(),
    note_en: z.string().optional(),
    note_ar: z.string().optional(),
    verified: z.boolean(),
  })
  .superRefine((r, ctx) => {
    if (r.inherits && r.value !== undefined && r.value !== null)
      ctx.addIssue({ code: 'custom', message: 'a rule that inherits must not set its own value' });
    if (r.kind === 'table') {
      if (r.value !== undefined && r.value !== null)
        ctx.addIssue({ code: 'custom', message: 'table rules must not set `value`' });
    } else {
      if (r.definition !== undefined && r.definition !== null)
        ctx.addIssue({ code: 'custom', message: '`definition` is only for table rules' });
      const err = validateValue(r.kind, r.value);
      if (err) ctx.addIssue({ code: 'custom', message: err });
    }
    if (r.requirement_class === 'USER_SPECIFIED')
      ctx.addIssue({
        code: 'custom',
        message: 'USER_SPECIFIED is not a rule class (it is produced by request characteristics)',
      });
  });
export type RuleSeed = z.output<typeof ruleSchema>;

export const seedFileSchema = z.strictObject({
  ruleset: z.string().regex(/^[A-Z0-9_]+$/),
  edition: z.string().min(1),
  source_doc: z.string().optional(),
  rules: z.array(ruleSchema),
});
export type SeedFile = z.output<typeof seedFileSchema>;

/** A rule as the resolver sees it: seed content + the ruleset it belongs to + identity/version. */
export interface RuleRecord extends Omit<RuleSeed, 'value'> {
  id: string;
  ruleset: string;
  version: number;
  requirement: string;
  value: unknown | null;
}

export function toRecord(
  seed: RuleSeed,
  ruleset: string,
  id = `${ruleset}:${seed.key}`,
  version = 1,
): RuleRecord {
  return {
    ...seed,
    id,
    ruleset,
    version,
    requirement: seed.requirement ?? seed.key,
    value: seed.value ?? null,
  };
}

export function parseFraction(s: string): number {
  const [n, d] = s.split('/').map(Number) as [number, number];
  return n / d;
}
/** Numeric view of a limit value (fractions like "1/3" are parsed). */
export function numericValue(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && FRACTION.test(v)) return parseFraction(v);
  return null;
}
