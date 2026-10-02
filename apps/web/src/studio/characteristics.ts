// The characteristics the Studio panel offers, and the JSON (Appendix E) it builds. Pure: unit-tested.
export type CharMode = 'auto' | 'fixed' | 'range' | 'target';
export type Section = 'strength' | 'binder' | 'aggregates' | 'fresh' | 'economics';

export interface CharDef {
  /** Appendix E key. */
  key: string;
  section: Section;
  unit: string;
  modes: readonly CharMode[];
  /** `aggregate`: one row per aggregate in the pool; `sieve`: one row per listed sieve. */
  keyed?: 'aggregate' | 'sieve';
  /** Where the live limit shown beside the input comes from (a requirement name in `bounds`). */
  bound?: string;
}

const ALL: readonly CharMode[] = ['auto', 'fixed', 'range', 'target'];
export const CHAR_DEFS: readonly CharDef[] = [
  { key: 'extra_margin_mpa', section: 'strength', unit: 'MPa', modes: ['auto', 'fixed'] },
  { key: 'fcr_mpa', section: 'strength', unit: 'MPa', modes: ['auto', 'fixed'] },
  { key: 'wcm', section: 'binder', unit: '', modes: ['auto', 'fixed', 'range'], bound: 'max_wcm' },
  { key: 'binder_kg', section: 'binder', unit: 'kg/m³', modes: ALL },
  { key: 'cement_kg', section: 'binder', unit: 'kg/m³', modes: ALL },
  { key: 'water_kg', section: 'binder', unit: 'kg/m³', modes: ALL },
  { key: 'scm', section: 'binder', unit: '%', modes: ['auto', 'fixed', 'range'] },
  { key: 'admixture', section: 'binder', unit: '', modes: ['auto', 'fixed'] },
  { key: 'air_pct', section: 'binder', unit: '%', modes: ['auto', 'fixed', 'range'] },
  { key: 'sand_ratio_pct', section: 'aggregates', unit: '%', modes: ALL },
  { key: 'agg_share_pct', section: 'aggregates', unit: '%', modes: ALL, keyed: 'aggregate' },
  {
    key: 'agg_kg',
    section: 'aggregates',
    unit: 'kg/m³',
    modes: ['auto', 'fixed', 'range'],
    keyed: 'aggregate',
  },
  { key: 'fm_combined', section: 'aggregates', unit: '', modes: ['auto', 'range', 'target'] },
  {
    key: 'passing_pct',
    section: 'aggregates',
    unit: '%',
    modes: ['auto', 'range'],
    keyed: 'sieve',
  },
  { key: 'shilstone.cf', section: 'aggregates', unit: '', modes: ['auto', 'range'] },
  { key: 'shilstone.wf', section: 'aggregates', unit: '', modes: ['auto', 'range'] },
  { key: 'fines_max_pct', section: 'aggregates', unit: '%', modes: ['auto', 'range'] },
  { key: 'paste_l', section: 'fresh', unit: 'L/m³', modes: ['auto', 'range', 'target'] },
  {
    key: 'fresh_density_kg_m3',
    section: 'fresh',
    unit: 'kg/m³',
    modes: ['auto', 'range', 'target'],
  },
  { key: 'max_cost_jod_m3', section: 'economics', unit: 'JOD/m³', modes: ['auto', 'range'] },
];
export const SECTIONS: readonly Section[] = [
  'strength',
  'binder',
  'aggregates',
  'fresh',
  'economics',
];
export const SIEVES = ['4.75', '2.36', '1.18', '0.6', '0.3', '0.15'] as const;

export interface CharState {
  mode: CharMode;
  value: string;
  min: string;
  max: string;
  /** scm / admixture product (material id). */
  product: string;
  /** admixture dosage level (1-based). */
  level: string;
  basis?: 'mass' | 'volume';
}
export const emptyChar = (): CharState => ({
  mode: 'auto',
  value: '',
  min: '',
  max: '',
  product: '',
  level: '1',
});
export type CharMap = Record<string, CharState>;

/** Row id: `key` or `key.sub` for keyed characteristics. */
export const rowId = (key: string, sub?: string) => (sub === undefined ? key : `${key}.${sub}`);

const num = (s: string): number | null => {
  const v = Number(s.trim());
  return s.trim() !== '' && Number.isFinite(v) ? v : null;
};

/** One state → its Appendix E spec, or null while it is incomplete (an incomplete row is not sent). */
export function specOf(key: string, s: CharState): Record<string, unknown> | null {
  if (s.mode === 'auto') return null;
  if (key === 'scm') {
    if (!s.product) return null;
    if (s.mode === 'fixed') {
      const pct = num(s.value);
      return pct === null ? null : { mode: 'fixed', product: s.product, pct };
    }
    const min = num(s.min);
    const max = num(s.max);
    return min === null && max === null
      ? null
      : {
          mode: 'range',
          product: s.product,
          ...(min !== null && { min }),
          ...(max !== null && { max }),
        };
  }
  if (key === 'admixture') {
    const level = num(s.level);
    return s.product && level !== null
      ? { mode: 'fixed', product: s.product, dosage_level: level }
      : null;
  }
  const extra = key === 'sand_ratio_pct' && s.basis ? { basis: s.basis } : {};
  if (s.mode === 'fixed' || s.mode === 'target') {
    const v = num(s.value);
    return v === null ? null : { mode: s.mode, value: v, ...extra };
  }
  const min = num(s.min);
  const max = num(s.max);
  if (min === null && max === null) return null;
  return { mode: 'range', ...(min !== null && { min }), ...(max !== null && { max }), ...extra };
}

/** The `characteristics` object of a request (Appendix E); keyed rows are grouped under their key. */
export function buildCharacteristics(map: CharMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, state] of Object.entries(map)) {
    const def = CHAR_DEFS.find((d) => id === d.key || id.startsWith(`${d.key}.`));
    if (!def) continue;
    const spec = specOf(def.key, state);
    if (!spec) continue;
    if (def.keyed) {
      const sub = id.slice(def.key.length + 1);
      const group = (out[def.key] ??= {}) as Record<string, unknown>;
      group[sub] = spec;
    } else out[def.key] = spec;
  }
  return out;
}

/** Degrees of freedom as the optimizer counts them: quantities (binder, water, one per aggregate) − equalities. */
export function dofOf(aggregates: number, map: CharMap) {
  const fixedKeys = new Set([
    'wcm',
    'binder_kg',
    'cement_kg',
    'water_kg',
    'sand_ratio_pct',
    'agg_share_pct',
    'agg_kg',
  ]);
  const fixed = Object.entries(map).filter(([id, s]) => {
    if (s.mode !== 'fixed' || specOf(id.split('.')[0]!, s) === null) return false;
    return fixedKeys.has(id.split('.')[0]!);
  });
  const quantities = 2 + aggregates;
  const equalities = 1 + fixed.length;
  const dof = quantities - equalities;
  return {
    quantities,
    equalities,
    dof,
    state:
      dof > 0
        ? ('free' as const)
        : dof === 0
          ? ('fully_specified' as const)
          : ('over_specified' as const),
  };
}

/** Releasing a characteristic sets it back to Auto; nothing else changes (hard limits have no control). */
export function release(map: CharMap, id: string): CharMap {
  const cur = map[id];
  return cur ? { ...map, [id]: { ...cur, mode: 'auto' } } : map;
}

/** Exposure classes by category, in the order the picker shows them. */
export const EXPOSURE: Record<'F' | 'S' | 'W' | 'C', readonly string[]> = {
  F: ['F0', 'F1', 'F2', 'F3'],
  S: ['S0', 'S1', 'S2', 'S3'],
  W: ['W0', 'W1', 'W2'],
  C: ['C0', 'C1', 'C2'],
};
export const AIR_ENTRAINED = ['F1', 'F2', 'F3'];
