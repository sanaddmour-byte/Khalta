// Project requirements (a versioned record). The code rulesets say what ACI and JS require; a project adds its own
// specification: which standards and editions apply, the strength designation and how it is judged, the exposure,
// restrictions on materials, and governing limits with their source. A REVISION is immutable once verified; a change
// is a new revision. A design freezes the revision it was made against.
//
// Nothing here contains an engineering value: the content is whatever the project's specification states, entered by
// a person and verified by a second person. Pure functions only.
import { z } from 'zod';

export const REQUIREMENT_SOURCES = ['code', 'project', 'approved_internal'] as const;
export type RequirementSource = (typeof REQUIREMENT_SOURCES)[number];

const text = (max = 300) => z.string().trim().min(1).max(max);

/** The test basis a limit is stated on. Limits are comparable only when these agree. */
export const testBasisSchema = z.strictObject({
  specimen: z.enum(['cylinder', 'cube']).nullable().default(null),
  ageDays: z.number().int().positive().nullable().default(null),
  method: text(120).nullable().default(null),
});
export type TestBasis = z.infer<typeof testBasisSchema>;

export const governingLimitSchema = z.strictObject({
  /** A requirement key the resolver knows (for example `max_wcm`); the direction is `min`/`max` in `bound`. */
  key: text(80),
  bound: z.enum(['min', 'max']),
  value: z.number().finite(),
  /** The unit the value is stated in (compared literally: no conversion is guessed). */
  unit: text(30),
  basis: testBasisSchema.default({ specimen: null, ageDays: null, method: null }),
  source: z.enum(REQUIREMENT_SOURCES),
  /** Where it comes from: a clause, a specification section, an approved internal procedure. */
  sourceRef: text(300),
});
export type GoverningLimit = z.infer<typeof governingLimitSchema>;

export const projectRequirementsSchema = z.strictObject({
  standards: z
    .array(
      z.strictObject({
        ruleset: z.enum(['ACI', 'JS', 'OTHER']),
        name: text(120),
        edition: text(80),
      }),
    )
    .min(1)
    .max(20),
  specification: z.strictObject({
    reference: text(120),
    revision: text(40),
    title: text(200).optional(),
  }),
  strength: z.strictObject({
    designation: text(60),
    basis: z.enum(['cylinder', 'cube', 'b_grade']),
    specifiedMpa: z.number().positive().finite(),
    testAgeDays: z.number().int().positive(),
    acceptanceMethod: text(300),
  }),
  exposure: z.array(text(10)).max(12).default([]),
  materialRestrictions: z
    .array(
      z.strictObject({
        category: z.enum([
          'cement',
          'scm',
          'fine_agg',
          'coarse_agg',
          'admixture',
          'water',
          'fiber',
          'pigment',
        ]),
        action: z.enum(['exclude', 'require', 'limit']),
        materialId: z.uuid().optional(),
        property: text(60).optional(),
        value: z.number().finite().optional(),
        unit: text(30).optional(),
        note: text(300),
      }),
    )
    .max(100)
    .default([]),
  permittedSubstitutions: z
    .array(
      z.strictObject({
        materialId: z.uuid(),
        substituteIds: z.array(z.uuid()).min(1).max(20),
        note: text(300),
      }),
    )
    .max(100)
    .default([]),
  governingLimits: z.array(governingLimitSchema).max(200).default([]),
});
export type ProjectRequirementsContent = z.infer<typeof projectRequirementsSchema>;

export const REQUIREMENT_STATUSES = ['draft', 'verified', 'superseded'] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

const canon = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, canon(x)]),
    );
  return v;
};

/**
 * The canonical text of a record (keys sorted at every level). What a verification and a frozen copy bind to is the
 * SHA-256 of this text; the hashing itself lives in the API, because the engine also runs in the browser.
 */
export function canonicalJson(content: ProjectRequirementsContent): string {
  return JSON.stringify(canon(content));
}

// ---- comparable limits ------------------------------------------------------------------------------------------

export type Incompatibility = 'unit' | 'specimen' | 'age' | 'method';

export interface ResolvedLimit {
  key: string;
  bound: 'min' | 'max';
  value: number;
  unit: string;
  basis: TestBasis;
  /** The limit that governs, and every other limit of the same key that was comparable with it. */
  governing: GoverningLimit;
  comparedWith: GoverningLimit[];
  /** True when a looser limit from another source was set aside because a stricter comparable one governs. */
  setAsideLooser: GoverningLimit[];
}

export interface IncompatibleLimits {
  key: string;
  bound: 'min' | 'max';
  /** Why no stricter-value choice is made, and which limits are involved. */
  reasons: Incompatibility[];
  limits: GoverningLimit[];
}

export interface LimitResolution {
  resolved: ResolvedLimit[];
  /** Limits of one key stated on different bases or units: NEVER merged, and the requirement stays unresolved. */
  incompatible: IncompatibleLimits[];
}

const sameBasis = (a: TestBasis, b: TestBasis): Incompatibility[] => {
  const out: Incompatibility[] = [];
  if (a.specimen !== b.specimen) out.push('specimen');
  if (a.ageDays !== b.ageDays) out.push('age');
  if (a.method !== b.method) out.push('method');
  return out;
};

/**
 * Chooses the governing limit for each requirement, but ONLY among comparable limits (same key, direction, unit and
 * test basis). Limits that are not comparable are reported as incompatible and no value is chosen: a "stricter value
 * wins" rule across different specimens, ages or units would be a guess. Pure.
 */
export function resolveGoverningLimits(limits: readonly GoverningLimit[]): LimitResolution {
  const groups = new Map<string, GoverningLimit[]>();
  for (const l of limits) {
    const g = groups.get(`${l.key}|${l.bound}`) ?? [];
    g.push(l);
    groups.set(`${l.key}|${l.bound}`, g);
  }
  const resolved: ResolvedLimit[] = [];
  const incompatible: IncompatibleLimits[] = [];
  for (const [, group] of groups) {
    const first = group[0]!;
    const reasons = new Set<Incompatibility>();
    for (const l of group.slice(1)) {
      if (l.unit !== first.unit) reasons.add('unit');
      for (const r of sameBasis(first.basis, l.basis)) reasons.add(r);
    }
    if (reasons.size > 0) {
      incompatible.push({
        key: first.key,
        bound: first.bound,
        reasons: [...reasons],
        limits: group,
      });
      continue;
    }
    // a `max` limit is stricter when smaller; a `min` limit when larger
    const stricter = (a: GoverningLimit, b: GoverningLimit) =>
      first.bound === 'max' ? a.value <= b.value : a.value >= b.value;
    const governing = group.reduce((a, b) => (stricter(a, b) ? a : b));
    resolved.push({
      key: first.key,
      bound: first.bound,
      value: governing.value,
      unit: first.unit,
      basis: first.basis,
      governing,
      comparedWith: group.filter((l) => l !== governing),
      setAsideLooser: group.filter((l) => l !== governing && !stricter(l, governing)),
    });
  }
  return { resolved, incompatible };
}

/** The project's own limits that the rules resolver takes as overrides (it refuses any that would loosen a code limit). */
export function toProjectOverrides(
  content: ProjectRequirementsContent,
  resolution?: LimitResolution,
) {
  const r = resolution ?? resolveGoverningLimits(content.governingLimits);
  return r.resolved
    .filter((x) => x.governing.source === 'project')
    .map((x) => ({
      requirement: x.key,
      value: x.value,
      units: x.unit,
      clause_ref: x.governing.sourceRef,
    }));
}

// ---- classification of why a requirement cannot be met ------------------------------------------------------------

export const INFEASIBILITY_CLASSES = [
  'code_requirement',
  'project_requirement',
  'approved_internal_requirement',
  'user_preference',
  'material_availability',
  'missing_evidence',
] as const;
export type InfeasibilityClass = (typeof INFEASIBILITY_CLASSES)[number];

/**
 * Maps the optimizer's row classes (and blockers) to the six classes a person is told about. Only an explicitly
 * adjustable user preference may be relaxed by a user action; every other class is governed and has no such control.
 */
export function classifyInfeasibility(row: {
  klass?: string;
  id?: string;
  code?: string;
  source?: RequirementSource | 'user' | 'materials';
}): { class: InfeasibilityClass; adjustable: boolean } {
  if (
    row.code === 'rule_not_on_file' ||
    row.code === 'parameter_missing' ||
    row.code === 'material_unusable'
  )
    return row.code === 'material_unusable'
      ? { class: 'material_availability', adjustable: false }
      : { class: 'missing_evidence', adjustable: false };
  if (row.source === 'project') return { class: 'project_requirement', adjustable: false };
  if (row.source === 'approved_internal')
    return { class: 'approved_internal_requirement', adjustable: false };
  if (row.source === 'materials' || row.klass === 'PHYSICAL')
    return { class: 'material_availability', adjustable: false };
  if (row.klass === 'USER' || row.source === 'user')
    return { class: 'user_preference', adjustable: true };
  if (row.klass === 'ENGINEERING')
    return { class: 'approved_internal_requirement', adjustable: false };
  return { class: 'code_requirement', adjustable: false };
}
