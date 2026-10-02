// Typed lab properties per material category (01-domain §2.2, 07 §2). One Zod schema per category is the
// single source for the API, the forms and the readiness rules. All values are SI; SG/absorption are SSD.
import { z } from 'zod';

export const CATEGORIES = [
  'cement',
  'scm',
  'fine_agg',
  'coarse_agg',
  'water',
  'admixture',
  'fiber',
  'pigment',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SOURCES = ['lab_report', 'supplier_datasheet', 'user_declared'] as const;
export type Source = (typeof SOURCES)[number];
/** Weakest first: a record's overall source is the weakest of its fields. */
export const SOURCE_STRENGTH: Record<Source, number> = {
  user_declared: 0,
  supplier_datasheet: 1,
  lab_report: 2,
};

const pct = z.number().min(0).max(100);
const positive = z.number().positive();
const nonNeg = z.number().min(0);

export const sievePointSchema = z.strictObject({ sieve_mm: positive, passing_pct: pct });

const aggregate = z.strictObject({
  sieve_analysis: z.array(sievePointSchema).optional(),
  sg_ssd: positive.optional(),
  absorption_pct: nonNeg.max(100).optional(),
  dry_rodded_unit_weight_kg_m3: positive.optional(),
  total_moisture_pct: nonNeg.max(100).optional(),
  finer_75um_pct: pct.optional(),
  chlorides_pct: nonNeg.max(100).optional(),
  sulfates_pct: nonNeg.max(100).optional(),
  la_abrasion_pct: pct.optional(),
  flakiness_pct: pct.optional(),
  elongation_pct: pct.optional(),
  shape: z.enum(['rounded', 'sub_rounded', 'sub_angular', 'angular']).optional(),
  texture: z.enum(['smooth', 'granular', 'rough', 'crystalline', 'honeycombed']).optional(),
});

const cementitious = {
  sg: positive.optional(),
  mortar_strength_28d_mpa: nonNeg.optional(),
  c3a_pct: pct.optional(),
  pozzolan_pct: pct.optional(),
  limestone_pct: pct.optional(),
  alkali_na2o_eq_pct: nonNeg.max(10).optional(),
  blaine_m2_kg: positive.optional(),
};

export const ADMIXTURE_TYPES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const; // ASTM C494
export const SCM_TYPES = [
  'fly_ash',
  'ggbs',
  'silica_fume',
  'natural_pozzolan',
  'limestone_filler',
] as const;

export const waterReductionPointSchema = z.strictObject({
  dosage_pct: positive,
  water_reduction_pct: pct,
});

const admixture = z.strictObject({
  type: z.enum(ADMIXTURE_TYPES).optional(),
  sg: positive.optional(),
  solids_pct: pct.optional(),
  /** Water-soluble chloride (Cl⁻) as % of the product mass; counted in the chloride check. */
  chloride_pct: pct.optional(),
  min_dosage_pct: nonNeg.optional(), // % of cementitious mass
  max_dosage_pct: positive.optional(),
  water_reduction_table: z.array(waterReductionPointSchema).optional(),
  set_retardation_min: z.number().optional(),
  water_convention: z.enum(['liquid_counts_as_water', 'liquid_ignored']).optional(),
});

export const PROPERTY_SCHEMAS = {
  fine_agg: aggregate,
  coarse_agg: aggregate,
  cement: z.strictObject({ cement_type: z.string().min(1).max(60).optional(), ...cementitious }),
  scm: z.strictObject({ scm_type: z.enum(SCM_TYPES).optional(), ...cementitious }),
  admixture,
  water: z.strictObject({
    water_source: z.string().min(1).max(100).optional(),
    sg: positive.optional(),
    sg_confirmed: z.boolean().optional(),
    chloride_mg_l: nonNeg.optional(),
  }),
  fiber: z.strictObject({ sg: positive.optional(), fiber_type: z.string().max(60).optional() }),
  pigment: z.strictObject({ sg: positive.optional() }),
} as const satisfies Record<Category, z.ZodType>;

export type Properties = Record<string, unknown>;

export function parseProperties(
  category: Category,
  props: unknown,
): { ok: true; data: Properties } | { ok: false; errors: { path: string; message: string }[] } {
  const r = PROPERTY_SCHEMAS[category].safeParse(props);
  return r.success
    ? { ok: true, data: r.data as Properties }
    : {
        ok: false,
        errors: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
}

/** Admixture dosage → water-reduction table rules (≥ 3 points, ascending dosage, inside min/max). */
export function validateWaterReduction(props: Properties): { path: string; message: string }[] {
  const t = props['water_reduction_table'] as
    { dosage_pct: number; water_reduction_pct: number }[] | undefined;
  if (!t) return [];
  const out: { path: string; message: string }[] = [];
  if (t.length < 3)
    out.push({
      path: 'water_reduction_table',
      message: 'the dosage–water-reduction table needs at least 3 points',
    });
  for (let i = 1; i < t.length; i++)
    if (t[i]!.dosage_pct <= t[i - 1]!.dosage_pct)
      out.push({
        path: `water_reduction_table.${i}`,
        message: 'dosages must be strictly ascending',
      });
  const min = props['min_dosage_pct'] as number | undefined;
  const max = props['max_dosage_pct'] as number | undefined;
  if (min !== undefined && max !== undefined && min > max)
    out.push({ path: 'min_dosage_pct', message: 'minimum dosage is above the maximum' });
  for (const [i, p] of t.entries()) {
    if (min !== undefined && p.dosage_pct < min)
      out.push({
        path: `water_reduction_table.${i}`,
        message: 'dosage is below the product minimum',
      });
    if (max !== undefined && p.dosage_pct > max)
      out.push({
        path: `water_reduction_table.${i}`,
        message: 'dosage is above the product maximum',
      });
  }
  return out;
}

export const isAggregate = (c: Category) => c === 'fine_agg' || c === 'coarse_agg';
