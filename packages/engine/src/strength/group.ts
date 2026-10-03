// The group a strength model belongs to (01-domain §3): same plant, cement source, SCM family, admixture family,
// specimen basis and test age. A change of any part is a different group, and a model whose own materials no longer
// match its recorded group is invalidated (§4).
import { cementGroupKind } from '../materials/cement';
import type { Category } from '../materials/properties';

export interface GroupMaterial {
  id: string;
  category: Category;
  /** `cement_type` for cement, `scm_type` for an SCM, `type` for an admixture (null when not stated). */
  kind: string | null;
}
export interface StrengthGroup {
  plantId: string;
  cementId: string;
  cementType: string | null;
  scm: { id: string; type: string | null }[];
  admixtures: { id: string; type: string | null }[];
  basis: 'cylinder' | 'cube';
  ageDays: number;
}

const byId = <T extends { id: string }>(xs: T[]) =>
  [...xs].sort((a, b) => a.id.localeCompare(b.id));

/** The group of a design's materials; null when it cannot be identified (no cement, or more than one). */
export function groupOf(
  plantId: string,
  basis: 'cylinder' | 'cube',
  ageDays: number,
  mats: GroupMaterial[],
): StrengthGroup | null {
  const cements = mats.filter((m) => m.category === 'cement');
  if (cements.length !== 1) return null;
  return {
    plantId,
    cementId: cements[0]!.id,
    cementType: cements[0]!.kind,
    scm: byId(mats.filter((m) => m.category === 'scm').map((m) => ({ id: m.id, type: m.kind }))),
    admixtures: byId(
      mats.filter((m) => m.category === 'admixture').map((m) => ({ id: m.id, type: m.kind })),
    ),
    basis,
    ageDays,
  };
}

export function groupKey(g: StrengthGroup): string {
  return [
    g.plantId,
    `cement:${g.cementId}:${g.cementType ?? '-'}`,
    `scm:${g.scm.map((s) => `${s.id}:${s.type ?? '-'}`).join(',') || 'none'}`,
    `adm:${g.admixtures.map((s) => `${s.id}:${s.type ?? '-'}`).join(',') || 'none'}`,
    g.basis,
    `${g.ageDays}d`,
  ].join('|');
}

export type InvalidationCode =
  | 'material_missing'
  | 'cement_type_changed'
  | 'scm_type_changed'
  | 'admixture_type_changed'
  | 'no_recent_results';

/** Why a stored model no longer holds against the materials as they are now (empty when it still does). */
export function invalidations(
  g: StrengthGroup,
  now: GroupMaterial[],
  recentResults: number,
): { code: InvalidationCode; detail: string }[] {
  const out: { code: InvalidationCode; detail: string }[] = [];
  const need = [
    { id: g.cementId, type: g.cementType, code: 'cement_type_changed' as const },
    ...g.scm.map((s) => ({ ...s, code: 'scm_type_changed' as const })),
    ...g.admixtures.map((s) => ({ ...s, code: 'admixture_type_changed' as const })),
  ];
  for (const n of need) {
    const m = now.find((x) => x.id === n.id);
    if (!m)
      out.push({ code: 'material_missing', detail: `material ${n.id} is no longer available` });
    else if ((m.kind ?? null) !== (n.type ?? null))
      out.push({
        code: n.code,
        detail: `${n.id}: was ${n.type ?? 'unstated'}, now ${m.kind ?? 'unstated'}`,
      });
  }
  if (recentResults === 0)
    out.push({ code: 'no_recent_results', detail: 'no results inside the time window' });
  return out;
}

/** The `kind` of a material for grouping: cement_type (cement), scm_type (SCM) or the ASTM type (admixture). */
export function kindOfMaterial(
  category: Category,
  props: Record<string, unknown> | null | undefined,
): string | null {
  if (category === 'cement') return cementGroupKind(props);
  const v =
    category === 'scm' ? props?.['scm_type'] : category === 'admixture' ? props?.['type'] : null;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** The group of a design from its snapshot parts; null for a b-grade basis, no test age, or no single cement. */
export function groupOfParts(
  plantId: string,
  request: { basis: string | null; testAgeDays: number | null },
  lines: { materialId: string }[],
  materials: {
    id: string;
    category: Category;
    test: { properties: Record<string, unknown> } | null;
  }[],
): StrengthGroup | null {
  if ((request.basis !== 'cylinder' && request.basis !== 'cube') || request.testAgeDays === null)
    return null;
  const ids = new Set(lines.map((l) => l.materialId));
  const mats: GroupMaterial[] = materials
    .filter((m) => ids.has(m.id))
    .map((m) => ({
      id: m.id,
      category: m.category,
      kind: kindOfMaterial(m.category, m.test?.properties),
    }));
  return groupOf(plantId, request.basis, request.testAgeDays, mats);
}
