// Layer merge, unit normalization and rejection of loosening input (07 §1.3, §4.1; 02-codes §9).
import { lookupTable, type ResolveResult, type ResolvedRequirement } from '@khalta/rules';
import {
  characteristicsInputSchema,
  KEYED_KEYS,
  type CharacteristicsInput,
  type SpecObject,
} from './schema';
import type { Rejection, SnapshotMaterial } from '../evaluate/types';

export const LAYER_LEVELS = [
  'engine_default',
  'tenant',
  'plant',
  'product_family',
  'request',
] as const;
export type LayerLevel = (typeof LAYER_LEVELS)[number];

export interface Layer {
  level: LayerLevel;
  /** Shown as the origin of every value this layer wins, e.g. "c30-pump-aqaba@3" or "request". */
  origin: string;
  characteristics: unknown;
}

export interface ResolvedCharacteristic {
  /** Top-level key from the schema, e.g. `wcm`, `agg_share_pct`. */
  key: string;
  /** Material id or sieve size for keyed characteristics. */
  sub: string | null;
  spec: SpecObject;
  origin: string;
}

export const idOf = (c: Pick<ResolvedCharacteristic, 'key' | 'sub'>) =>
  c.sub === null ? c.key : `${c.key}.${c.sub}`;

type UnitFactor = { [unit: string]: number };
const MPA: UnitFactor = { MPa: 1, 'kg/cm2': 0.0980665 };
const PCT: UnitFactor = { '%': 1, fraction: 100 };
const UNIT_TABLE: Record<string, UnitFactor> = {
  fcr_mpa: MPA,
  extra_margin_mpa: MPA,
  sand_ratio_pct: PCT,
  air_pct: PCT,
  agg_share_pct: PCT,
  paste_l: { 'L/m3': 1, m3: 1000 },
  fresh_density_kg_m3: { 'kg/m3': 1, 't/m3': 1000 },
};

export type NormalizeResult =
  { ok: true; characteristics: unknown } | { ok: false; key: string; message: string };

/**
 * Converts an optional `unit` on any specification to the key's canonical unit (the schema is strict, so
 * the `unit` field is consumed here). Unknown units are rejected, never guessed.
 */
export function normalizeUnits(raw: unknown): NormalizeResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ok: true, characteristics: raw };
  const out: Record<string, unknown> = {};
  const one = (
    key: string,
    spec: unknown,
  ): { ok: true; spec: unknown } | { ok: false; message: string } => {
    if (typeof spec !== 'object' || spec === null || !('unit' in spec)) return { ok: true, spec };
    const { unit, ...rest } = spec as Record<string, unknown>;
    const table = UNIT_TABLE[key];
    const factor = table && typeof unit === 'string' ? table[unit] : undefined;
    if (factor === undefined)
      return { ok: false, message: `unit "${String(unit)}" is not supported for ${key}` };
    for (const f of ['value', 'min', 'max'])
      if (typeof rest[f] === 'number') rest[f] = round9((rest[f] as number) * factor);
    return { ok: true, spec: rest };
  };
  for (const [key, spec] of Object.entries(raw)) {
    if ((KEYED_KEYS as readonly string[]).includes(key) && typeof spec === 'object' && spec) {
      const inner: Record<string, unknown> = {};
      for (const [sub, s] of Object.entries(spec)) {
        const r = one(key, s);
        if (!r.ok) return { ok: false, key: `${key}.${sub}`, message: r.message };
        inner[sub] = r.spec;
      }
      out[key] = inner;
    } else {
      const r = one(key, spec);
      if (!r.ok) return { ok: false, key, message: r.message };
      out[key] = r.spec;
    }
  }
  return { ok: true, characteristics: out };
}

const round9 = (n: number) => Math.round(n * 1e9) / 1e9;

export type MergeResult =
  | { ok: true; characteristics: ResolvedCharacteristic[] }
  | { ok: false; errors: { level: LayerLevel; origin: string; key?: string; message: string }[] };

/**
 * Merges layers least specific first (defaults → tenant → plant → product family → request). For the same
 * key (and the same sub-key for keyed characteristics) the more specific layer replaces the less specific
 * one. Deterministic: output is sorted by id. Each layer is normalized and parsed with the Appendix E schema.
 */
export function mergeLayers(layers: Layer[]): MergeResult {
  const ordered = [...layers].sort(
    (a, b) => LAYER_LEVELS.indexOf(a.level) - LAYER_LEVELS.indexOf(b.level),
  );
  const errors: { level: LayerLevel; origin: string; key?: string; message: string }[] = [];
  const merged = new Map<string, ResolvedCharacteristic>();
  for (const layer of ordered) {
    const norm = normalizeUnits(layer.characteristics ?? {});
    if (!norm.ok) {
      errors.push({
        level: layer.level,
        origin: layer.origin,
        key: norm.key,
        message: norm.message,
      });
      continue;
    }
    const parsed = characteristicsInputSchema.safeParse({ characteristics: norm.characteristics });
    if (!parsed.success) {
      for (const i of parsed.error.issues)
        errors.push({
          level: layer.level,
          origin: layer.origin,
          key: i.path.slice(1).join('.') || undefined,
          message: i.message,
        });
      continue;
    }
    for (const [key, spec] of Object.entries(parsed.data.characteristics)) {
      if (spec === undefined) continue;
      if ((KEYED_KEYS as readonly string[]).includes(key)) {
        for (const [sub, s] of Object.entries(spec as Record<string, SpecObject>))
          merged.set(`${key}.${sub}`, { key, sub, spec: s, origin: layer.origin });
      } else merged.set(key, { key, sub: null, spec: spec as SpecObject, origin: layer.origin });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    characteristics: [...merged.values()]
      .filter((c) => c.spec.mode !== 'auto')
      .sort((a, b) => idOf(a).localeCompare(idOf(b))),
  };
}

// ------------------------------------------------------------------ hard-limit rejection

export interface LimitContext {
  resolved: ResolveResult;
  materials: SnapshotMaterial[];
  /** Governing code f'cr (MPa) before any user addition; null when it cannot be computed. */
  codeFcrMpa: number | null;
  nmasMm: number | null;
}

const reqOf = (r: ResolveResult, name: string) =>
  r.requirements.find((x) => x.requirement === name);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function ref(r: ResolvedRequirement | undefined) {
  return {
    rule: r?.governing?.ruleKey ?? null,
    clause: r?.governing?.clause_ref ?? null,
    source: r?.governing ? String(r.governing.source) : null,
  };
}

const SCM_RULE: Record<string, string> = {
  fly_ash: 'scm.max.fly_ash_pozzolan_pct',
  natural_pozzolan: 'scm.max.fly_ash_pozzolan_pct',
  ggbs: 'scm.max.slag_pct',
  silica_fume: 'scm.max.silica_fume_pct',
};

const fmt = (v: number) => String(Math.round(v * 1e6) / 1e6);

/**
 * Entry-time check (UI and API share it): a characteristic may tighten a CODE_HARD / PROJECT_HARD limit,
 * never loosen it. Each rejection names the rule, clause and allowed bound. Limits that are not on file
 * cannot be checked here and are not invented; the evaluator reports them as "not evaluated".
 */
export function rejectLoosening(chars: ResolvedCharacteristic[], ctx: LimitContext): Rejection[] {
  const out: Rejection[] = [];
  const push = (r: Rejection) => out.push(r);

  /** Upper bound a value/range must respect. */
  const upper = (
    c: ResolvedCharacteristic,
    req: ResolvedRequirement | undefined,
    label: string,
  ) => {
    if (!req || !num(req.value)) return;
    const limit = req.value;
    const s = c.spec;
    const top = s.mode === 'fixed' || s.mode === 'target' ? s.value : s.max;
    const bottom = s.mode === 'range' ? s.min : undefined;
    if (num(bottom) && bottom > limit)
      push({
        key: idOf(c),
        code: 'infeasible_with_limit',
        message: `${label} minimum ${fmt(bottom)} is above the limit ${fmt(limit)}`,
        proposed: bottom,
        allowed: limit,
        ...ref(req),
      });
    else if (num(top) && top > limit)
      push({
        key: idOf(c),
        code: 'override_loosens',
        message: `${label} ${fmt(top)} would loosen the limit ${fmt(limit)}`,
        proposed: top,
        allowed: limit,
        ...ref(req),
      });
    else if (s.mode === 'range' && !num(s.max) && s.min !== undefined) return; // open-ended: limit still applies on top
  };

  for (const c of chars) {
    const s = c.spec;
    switch (c.key) {
      case 'wcm':
        upper(c, reqOf(ctx.resolved, 'max_wcm'), 'w/cm');
        break;
      case 'scm': {
        const m = ctx.materials.find((x) => x.id === (s['product'] as string | undefined));
        const type = m?.test?.properties['scm_type'] as string | undefined;
        const limitRule = type ? SCM_RULE[type] : undefined;
        const req = limitRule ? reqOf(ctx.resolved, limitRule) : undefined;
        const total = reqOf(ctx.resolved, 'scm.max.total_pct');
        const pctValue = s.mode === 'fixed' ? (s['pct'] as number) : s.max;
        for (const r of [req, total]) {
          if (!r || !num(r.value) || !num(pctValue) || pctValue <= r.value) continue;
          push({
            key: idOf(c),
            code: 'override_loosens',
            message: `SCM ${fmt(pctValue)} % would loosen the limit ${fmt(r.value)} %`,
            proposed: pctValue,
            allowed: r.value,
            ...ref(r),
          });
          break;
        }
        break;
      }
      case 'air_pct': {
        const target = reqOf(ctx.resolved, 'air_target_pct');
        const tol = reqOf(ctx.resolved, 'air_tolerance_pct');
        if (!target || !num(tol?.value) || ctx.nmasMm === null) break;
        const t = lookupTable(target.value as never, { col: ctx.nmasMm });
        if (t.status !== 'ok') break;
        const lo = t.value - (tol!.value as number);
        const hi = t.value + (tol!.value as number);
        const a = s.mode === 'fixed' ? s.value : undefined;
        const a1 = s.mode === 'range' ? s.min : undefined;
        const a2 = s.mode === 'range' ? s.max : undefined;
        const bad = [a, a1, a2].find((x) => num(x) && (x < lo || x > hi));
        if (num(bad))
          push({
            key: idOf(c),
            code: 'override_loosens',
            message: `air ${fmt(bad)} % is outside the allowed ${fmt(lo)}–${fmt(hi)} %`,
            proposed: bad,
            allowed: [lo, hi],
            ...ref(target),
          });
        break;
      }
      case 'fcr_mpa':
        if (
          s.mode === 'fixed' &&
          num(s.value) &&
          ctx.codeFcrMpa !== null &&
          s.value < ctx.codeFcrMpa
        )
          push({
            key: idOf(c),
            code: 'override_loosens',
            message: `f'cr ${fmt(s.value)} MPa is below the required ${fmt(ctx.codeFcrMpa)} MPa`,
            proposed: s.value,
            allowed: ctx.codeFcrMpa,
            rule: 'fcr',
            clause: 'ACI 301 §4.2.3.3',
            source: 'ACI',
          });
        break;
      case 'admixture': {
        const m = ctx.materials.find((x) => x.id === (s['product'] as string | undefined));
        const props = m?.test?.properties;
        const min = props?.['min_dosage_pct'] as number | undefined;
        const max = props?.['max_dosage_pct'] as number | undefined;
        const vals = [s['dosage_pct'], s['min'], s['max']].filter(num);
        const bad = vals.find((v) => (num(min) && v < min) || (num(max) && v > max));
        if (bad !== undefined)
          push({
            key: idOf(c),
            code: 'outside_product_range',
            message: `dosage ${fmt(bad)} % is outside the product range ${min ?? '–'}–${max ?? '–'} %`,
            proposed: bad,
            allowed: [min ?? null, max ?? null],
            rule: null,
            clause: null,
            source: null,
          });
        break;
      }
      default:
    }
  }
  return out;
}

/** Convenience for the API: parse, merge, normalize and reject in one call. */
export function checkCharacteristics(layers: Layer[], ctx: LimitContext) {
  const merged = mergeLayers(layers);
  if (!merged.ok)
    return { ok: false as const, invalid: merged.errors, rejected: [] as Rejection[] };
  const rejected = rejectLoosening(merged.characteristics, ctx);
  return {
    ok: rejected.length === 0,
    invalid: [] as never[],
    rejected,
    characteristics: merged.characteristics,
  };
}

export type { CharacteristicsInput };
