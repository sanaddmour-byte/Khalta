import {
  blockers,
  CEMENT_CLASSES,
  CEMENT_COLOURS,
  CEMENT_KINDS_CURRENT,
  type Category,
} from '@khalta/engine';

export type FieldType = 'number' | 'text' | 'select';
export interface FieldDef {
  key: string;
  type: FieldType;
  /** Display unit; `null` = unitless. Rendered in an LTR island next to the input. */
  unit: string | null;
  options?: readonly string[];
  /** A select whose chosen option is stored as a number (e.g. the cement strength class). */
  numeric?: boolean;
  /** `evaluate` fields are needed to evaluate a mix, `design` fields to generate one; the rest are optional. */
  tier: 'evaluate' | 'design' | 'optional';
}

const num = (key: string, unit: string | null): Omit<FieldDef, 'tier'> => ({
  key,
  type: 'number',
  unit,
});
const txt = (key: string): Omit<FieldDef, 'tier'> => ({ key, type: 'text', unit: null });
const sel = (key: string, options: readonly string[]): Omit<FieldDef, 'tier'> => ({
  key,
  type: 'select',
  unit: null,
  options,
});

const AGG = [
  num('sg_ssd', null),
  num('absorption_pct', '%'),
  num('finer_75um_pct', '%'),
  num('dry_rodded_unit_weight_kg_m3', 'kg/m³'),
  num('total_moisture_pct', '%'),
  num('chlorides_pct', '%'),
  num('sulfates_pct', '%'),
  num('la_abrasion_pct', '%'),
  num('flakiness_pct', '%'),
  num('elongation_pct', '%'),
  sel('shape', ['rounded', 'sub_rounded', 'sub_angular', 'angular']),
  sel('texture', ['smooth', 'granular', 'rough', 'crystalline', 'honeycombed']),
];
const CEMENTITIOUS = [
  num('sg', null),
  num('mortar_strength_28d_mpa', 'MPa'),
  num('c3a_pct', '%'),
  num('pozzolan_pct', '%'),
  num('limestone_pct', '%'),
  num('alkali_na2o_eq_pct', '%'),
  num('blaine_m2_kg', 'm²/kg'),
];
const BASE: Record<Category, Omit<FieldDef, 'tier'>[]> = {
  fine_agg: AGG,
  coarse_agg: AGG,
  cement: [
    txt('cement_type'),
    sel('cement_kind', CEMENT_KINDS_CURRENT),
    sel('cement_colour', CEMENT_COLOURS),
    { ...sel('cement_strength_class', CEMENT_CLASSES.map(String)), numeric: true },
    ...CEMENTITIOUS,
  ],
  scm: [
    sel('scm_type', ['fly_ash', 'ggbs', 'silica_fume', 'natural_pozzolan', 'limestone_filler']),
    ...CEMENTITIOUS,
  ],
  admixture: [
    sel('type', ['A', 'B', 'C', 'D', 'E', 'F', 'G']),
    num('sg', null),
    num('solids_pct', '%'),
    num('chloride_pct', '%'),
    num('min_dosage_pct', '% cementitious'),
    num('max_dosage_pct', '% cementitious'),
    num('set_retardation_min', 'min'),
    sel('water_convention', ['liquid_counts_as_water', 'liquid_ignored']),
  ],
  water: [txt('water_source'), num('sg', null), num('chloride_mg_l', 'mg/L')],
  fiber: [txt('fiber_type'), num('sg', null)],
  pigment: [num('sg', null)],
};

/** Fields shown for a category, tiered from the engine's own minimum sets (07 §2.2): one source of truth. */
export function fieldsFor(category: Category): FieldDef[] {
  const need = new Map<string, 'evaluate' | 'design'>();
  // an empty property bag lists every field either workflow requires; recycled water / sulfate / ASR
  // fields are surfaced as design fields so the form never hides a possible blocker.
  for (const b of blockers(category, {}, 'design', {
    sulfateGoverns: true,
    asrActive: true,
    recycledWater: true,
  }))
    if (!need.has(b.field) || b.workflow === 'evaluate') need.set(b.field, b.workflow);
  return BASE[category].map((f) => ({ ...f, tier: need.get(f.key) ?? 'optional' }));
}

/** Properties handled by dedicated editors rather than a plain input. */
export const SPECIAL_FIELDS = ['sieve_analysis', 'water_reduction_table', 'sg_confirmed'] as const;
