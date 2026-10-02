// Characteristic profiles (07 §3): matching and layering. Pure. A profile never loosens a code limit: layering
// happens first and the existing hard-limit checker runs on the merged result, so a loosening value is
// rejected exactly as if the user had typed it.
import type { Layer, LayerLevel } from '../characteristics/resolve';

export const PROFILE_SCOPES = ['tenant', 'plant', 'product_family'] as const;
export type ProfileScope = (typeof PROFILE_SCOPES)[number];
export const PLACEMENTS = ['slab', 'beam', 'column', 'wall', 'foundation', 'other'] as const;
export const SEASONS = ['summer', 'winter', 'all'] as const;

export interface AppliesTo {
  fcMin?: number;
  fcMax?: number;
  /** The request must include every listed class. */
  exposure?: string[];
  pumpable?: boolean;
  placement?: string;
  season?: string;
}

export interface ProfileVersionView {
  profileId: string;
  version: number;
  status: 'draft' | 'approved';
  scope: ProfileScope;
  plantId: string | null;
  name: string;
  family: string | null;
  appliesTo: AppliesTo;
  characteristics: unknown;
  materials: { include?: string[]; exclude?: string[]; prefer?: string[] };
  objective: 'cheapest' | 'closest_to_targets' | null;
  mode: 'ACI' | 'JS' | 'BOTH' | null;
  createdAt: string;
}

export interface MatchContext {
  fcMpa: number | null;
  exposure: string[];
  pumpable: boolean | null;
  placement?: string | null;
  season?: string | null;
  plantId: string | null;
}

/** Number of `applies_to` fields set: the narrower profile wins. */
export const specificity = (a: AppliesTo): number =>
  (a.fcMin !== undefined || a.fcMax !== undefined ? 1 : 0) +
  (a.exposure && a.exposure.length > 0 ? 1 : 0) +
  (a.pumpable !== undefined ? 1 : 0) +
  (a.placement ? 1 : 0) +
  (a.season ? 1 : 0);

export function matches(v: ProfileVersionView, c: MatchContext): boolean {
  if (v.scope === 'plant' && (v.plantId === null || v.plantId !== c.plantId)) return false;
  const a = v.appliesTo;
  if (a.fcMin !== undefined && (c.fcMpa === null || c.fcMpa < a.fcMin)) return false;
  if (a.fcMax !== undefined && (c.fcMpa === null || c.fcMpa > a.fcMax)) return false;
  if (a.exposure && a.exposure.length > 0 && !a.exposure.every((e) => c.exposure.includes(e)))
    return false;
  if (a.pumpable !== undefined && c.pumpable !== a.pumpable) return false;
  if (a.placement && a.placement !== c.placement) return false;
  if (a.season && a.season !== 'all' && a.season !== c.season) return false;
  return true;
}

export interface Selection {
  /** At most one per scope, in layering order (tenant, plant, product family). */
  chosen: ProfileVersionView[];
  /** Matching profiles that lost to a narrower one of the same scope. */
  alsoMatched: ProfileVersionView[];
  /** Scopes where several equally narrow profiles match: the user must pick; none is applied. */
  ties: { scope: ProfileScope; candidates: ProfileVersionView[] }[];
}

/** Picks the narrowest matching version per scope (ties are reported, never guessed). */
export function selectProfiles(
  versions: readonly ProfileVersionView[],
  c: MatchContext,
): Selection {
  const out: Selection = { chosen: [], alsoMatched: [], ties: [] };
  for (const scope of PROFILE_SCOPES) {
    const m = versions.filter((v) => v.scope === scope && matches(v, c));
    if (m.length === 0) continue;
    const top = Math.max(...m.map((v) => specificity(v.appliesTo)));
    const narrow = m.filter((v) => specificity(v.appliesTo) === top);
    if (narrow.length > 1) {
      out.ties.push({ scope, candidates: narrow });
      out.alsoMatched.push(...m.filter((v) => !narrow.includes(v)));
      continue;
    }
    out.chosen.push(narrow[0]!);
    out.alsoMatched.push(...m.filter((v) => v !== narrow[0]));
  }
  return out;
}

export const originOf = (v: Pick<ProfileVersionView, 'profileId' | 'version'>) =>
  `profile:${v.profileId}@${v.version}`;

const LEVEL: Record<ProfileScope, LayerLevel> = {
  tenant: 'tenant',
  plant: 'plant',
  product_family: 'product_family',
};

/** Layers for `mergeLayers` / `checkCharacteristics`: profiles least specific first, the request last. */
export function profileLayers(
  chosen: readonly ProfileVersionView[],
  requestCharacteristics: unknown,
): Layer[] {
  const layers: Layer[] = chosen.map((v) => ({
    level: LEVEL[v.scope],
    origin: originOf(v),
    characteristics: v.characteristics ?? {},
  }));
  layers.push({
    level: 'request',
    origin: 'request',
    characteristics: requestCharacteristics ?? {},
  });
  return layers;
}

export interface Preferences {
  include?: string[];
  exclude?: string[];
  prefer?: string[];
}

/** Include lists intersect only when several layers give one; exclusion always wins; preferences accumulate. */
export function mergePreferences(
  chosen: readonly ProfileVersionView[],
  request: Preferences | undefined,
): Preferences {
  const lists = [...chosen.map((v) => v.materials), request ?? {}];
  const includes = lists.map((l) => l.include).filter((x): x is string[] => !!x && x.length > 0);
  const exclude = [...new Set(lists.flatMap((l) => l.exclude ?? []))];
  const prefer = [...new Set(lists.flatMap((l) => l.prefer ?? []))];
  let include: string[] | undefined;
  if (includes.length > 0) include = includes.reduce((a, b) => a.filter((x) => b.includes(x)));
  return {
    ...(include ? { include: include.filter((x) => !exclude.includes(x)) } : {}),
    ...(exclude.length ? { exclude } : {}),
    ...(prefer.length ? { prefer } : {}),
  };
}

/** The most specific profile's default objective / mode (a request that states one keeps its own). */
export function defaultsOf(chosen: readonly ProfileVersionView[]) {
  let objective: ProfileVersionView['objective'] = null;
  let mode: ProfileVersionView['mode'] = null;
  for (const v of chosen) {
    if (v.objective) objective = v.objective;
    if (v.mode) mode = v.mode;
  }
  return { objective, mode };
}

export interface ProfileDiffRow {
  key: string;
  kind: 'added' | 'removed' | 'changed';
  from: unknown;
  to: unknown;
}

/** Row-level difference between two versions' characteristics (keyed ones per sub-key) and applies_to. */
export function diffVersions(
  a: Pick<ProfileVersionView, 'characteristics' | 'appliesTo' | 'objective' | 'mode' | 'materials'>,
  b: Pick<ProfileVersionView, 'characteristics' | 'appliesTo' | 'objective' | 'mode' | 'materials'>,
): ProfileDiffRow[] {
  const flat = (p: string, v: unknown, out: Record<string, unknown>) => {
    const keyed = ['agg_share_pct', 'agg_kg', 'passing_pct'];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      for (const [k, x] of Object.entries(o)) {
        if (p === 'chars' && keyed.includes(k) && x && typeof x === 'object')
          for (const [s, y] of Object.entries(x as Record<string, unknown>))
            out[`chars.${k}.${s}`] = y;
        else out[`${p}.${k}`] = x;
      }
    }
    return out;
  };
  const side = (v: Parameters<typeof diffVersions>[0]) => {
    const o: Record<string, unknown> = {};
    flat('chars', v.characteristics, o);
    flat('applies_to', v.appliesTo, o);
    flat('materials', v.materials, o);
    o['objective'] = v.objective;
    o['mode'] = v.mode;
    return o;
  };
  const x = side(a);
  const y = side(b);
  const rows: ProfileDiffRow[] = [];
  for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
    const same = JSON.stringify(x[k] ?? null) === JSON.stringify(y[k] ?? null);
    if (same) continue;
    rows.push({
      key: k,
      kind:
        x[k] === undefined || x[k] === null
          ? 'added'
          : y[k] === undefined || y[k] === null
            ? 'removed'
            : 'changed',
      from: x[k] ?? null,
      to: y[k] ?? null,
    });
  }
  return rows;
}
