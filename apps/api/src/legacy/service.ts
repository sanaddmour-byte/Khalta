import { schema, type Executor } from '@khalta/db';
import {
  detectMapping,
  litresToKg,
  matchMaterial,
  parseLegacyRows,
  type LegacyColumn,
  type LegacyDesign,
  type Mapping,
} from '@khalta/engine';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { loadLiveRows, loadSgs } from '../prices/service';
import type { AuthContext } from '../middleware';

export type Decision = { materialId: string } | { create: true } | null | undefined;
export type Decisions = Record<string, Decision>;
export const decisionKey = (category: string, name: string) => `${category}|${name.trim()}`;

export interface PlannedLine {
  line: number;
  materialName: string;
  category: string;
  quantity: string;
  unit: 'kg/m3' | 'L/m3';
  kg: string | null;
  materialId: string | null;
  method: 'exact' | 'confirmed' | 'created' | null;
}
export interface PlannedDesign {
  code: string;
  name: string;
  plantCode: string;
  plantId: string | null;
  requirements: Record<string, unknown>;
  approvalReference: string | null;
  inProduction: boolean | null;
  avgMonthlyVolumeM3: string | null;
  firstLine: number;
  lines: PlannedLine[];
  errors: { code: string; line?: number; detail?: string }[];
  warnings: { code: string; line?: number; detail?: string }[];
}
export interface PlannedMaterial {
  key: string;
  name: string;
  category: string;
  lines: number;
  exactId: string | null;
  ambiguous: boolean;
  suggestions: { id: string; name: string; category: string; score: number }[];
  decision: 'exact' | 'confirmed' | 'create' | 'unresolved';
  materialId: string | null;
}
export interface Plan {
  mapping: Mapping;
  missing: LegacyColumn[];
  fileErrors: string[];
  designs: PlannedDesign[];
  materials: PlannedMaterial[];
  summary: { designs: number; ok: number; errors: number; materials: number; unresolved: number };
}

export interface BatchRow {
  header: string[];
  rows: string[][];
}

/** Recomputes the whole import from the stored table, the chosen mapping and the matching decisions. */
export async function planImport(
  db: Executor,
  auth: AuthContext,
  batch: BatchRow,
  mappingIn: Mapping | undefined,
  decisions: Decisions,
): Promise<Plan> {
  const detected = detectMapping(batch.header);
  const mapping = mappingIn ?? detected.mapping;
  const { designs, fileErrors } = parseLegacyRows(batch.rows, mapping);
  const missing = detectMissing(mapping);

  const [plants, mats, existing] = await Promise.all([
    db
      .select({ id: schema.plants.id, code: schema.plants.code })
      .from(schema.plants)
      .where(and(eq(schema.plants.tenantId, auth.tenantId), isNull(schema.plants.deletedAt))),
    db
      .select()
      .from(schema.materials)
      .where(and(eq(schema.materials.tenantId, auth.tenantId), isNull(schema.materials.deletedAt))),
    db
      .select({ code: schema.mixDesigns.code })
      .from(schema.mixDesigns)
      .where(
        and(eq(schema.mixDesigns.tenantId, auth.tenantId), isNull(schema.mixDesigns.deletedAt)),
      ),
  ]);
  const plantByCode = new Map(plants.map((p) => [p.code.toLowerCase(), p.id]));
  const matById = new Map(mats.map((m) => [m.id, m]));
  const candidates = mats.map((m) => ({
    id: m.id,
    category: m.category,
    names: [m.marketNameAr, m.marketNameEn, m.technicalName],
  }));
  const codes = new Set(existing.map((e) => e.code.toLowerCase()));

  // distinct (category, name) pairs across the file
  const pairs = new Map<string, { name: string; category: string; lines: number }>();
  for (const d of designs)
    for (const l of d.lines) {
      const k = decisionKey(l.category, l.materialName);
      const p = pairs.get(k);
      if (p) p.lines++;
      else pairs.set(k, { name: l.materialName.trim(), category: l.category, lines: 1 });
    }
  const materials: PlannedMaterial[] = [];
  const resolved = new Map<string, { id: string | null; method: PlannedLine['method'] }>();
  for (const [key, p] of pairs) {
    const m = matchMaterial(p.name, p.category, candidates);
    const dec = decisions[key];
    let id: string | null = null;
    let method: PlannedLine['method'] = null;
    let decision: PlannedMaterial['decision'] = 'unresolved';
    if (dec && 'materialId' in dec && matById.has(dec.materialId)) {
      id = dec.materialId;
      method = dec.materialId === m.exactId ? 'exact' : 'confirmed';
      decision = method;
    } else if (dec && 'create' in dec) {
      method = 'created';
      decision = 'create';
    } else if (m.exactId) {
      id = m.exactId;
      method = 'exact';
      decision = 'exact';
    }
    resolved.set(key, { id, method });
    materials.push({
      key,
      name: p.name,
      category: p.category,
      lines: p.lines,
      exactId: m.exactId,
      ambiguous: m.ambiguous,
      suggestions: m.suggestions.map((s) => {
        const mm = matById.get(s.id)!;
        return {
          id: s.id,
          name: mm.marketNameAr ?? mm.marketNameEn,
          category: mm.category,
          score: Math.round(s.score * 100) / 100,
        };
      }),
      decision,
      materialId: id,
    });
  }

  const usedIds = [...new Set([...resolved.values()].flatMap((r) => (r.id ? [r.id] : [])))];
  const sgs = await loadSgs(db, auth.tenantId, usedIds);
  const plantIds = [
    ...new Set(
      designs.flatMap((d) =>
        plantByCode.get(d.plantCode.toLowerCase())
          ? [plantByCode.get(d.plantCode.toLowerCase())!]
          : [],
      ),
    ),
  ];
  const priced = new Set(
    (await loadLiveRows(db, auth.tenantId, usedIds, plantIds)).map(
      (r) => `${r.materialId}|${r.plantId}`,
    ),
  );
  const tested = new Set(
    usedIds.length
      ? (
          await db
            .select({ id: schema.materialTests.materialId })
            .from(schema.materialTests)
            .where(
              and(
                eq(schema.materialTests.isCurrent, true),
                inArray(schema.materialTests.materialId, usedIds),
              ),
            )
        ).map((t) => t.id)
      : [],
  );
  const seenCodes = new Set<string>();

  const planned: PlannedDesign[] = designs.map((d: LegacyDesign) => {
    const plantId = plantByCode.get(d.plantCode.toLowerCase()) ?? null;
    const errors = [...d.errors];
    const warnings = [...d.warnings];
    if (d.plantCode && !plantId) errors.push({ code: 'unknown_plant', detail: d.plantCode });
    if (codes.has(d.code.toLowerCase())) errors.push({ code: 'code_exists_in_library' });
    if (seenCodes.has(d.code.toLowerCase())) errors.push({ code: 'duplicate_code_in_file' });
    seenCodes.add(d.code.toLowerCase());
    const lines: PlannedLine[] = d.lines.map((l) => {
      const r = resolved.get(decisionKey(l.category, l.materialName)) ?? { id: null, method: null };
      let kg: string | null = l.unit === 'kg/m3' ? Number(l.quantity).toFixed(3) : null;
      const mat = r.id ? matById.get(r.id) : undefined;
      if (r.method !== 'created' && !r.id)
        errors.push({ code: 'unresolved_material', line: l.line, detail: l.materialName });
      if (mat && mat.category !== l.category)
        errors.push({ code: 'category_mismatch', line: l.line, detail: l.materialName });
      if (l.unit === 'L/m3') {
        kg = r.id ? litresToKg(l.quantity, sgs.get(r.id) ?? null) : null;
        if (kg === null)
          errors.push({ code: 'litres_need_sg', line: l.line, detail: l.materialName });
      }
      if (r.id && !tested.has(r.id))
        warnings.push({ code: 'material_without_tests', line: l.line, detail: l.materialName });
      if (r.id && plantId && !priced.has(`${r.id}|${plantId}`))
        warnings.push({ code: 'material_not_priced', line: l.line, detail: l.materialName });
      return {
        line: l.line,
        materialName: l.materialName,
        category: l.category,
        quantity: l.quantity,
        unit: l.unit,
        kg,
        materialId: r.id,
        method: r.method,
      };
    });
    return {
      code: d.code,
      name: d.name || d.code,
      plantCode: d.plantCode,
      plantId,
      requirements: {
        fcMpa: d.fcMpa,
        basis: d.basis,
        testAgeDays: d.testAgeDays,
        exposure: d.exposure,
        slumpMm: d.slumpMm,
        nmasMm: d.nmasMm,
        pumpable: d.pumpable,
      },
      approvalReference: d.approvalReference,
      inProduction: d.inProduction,
      avgMonthlyVolumeM3: d.avgMonthlyVolumeM3,
      firstLine: d.firstLine,
      lines,
      errors,
      warnings,
    };
  });
  const ok = planned.filter((d) => d.errors.length === 0).length;
  return {
    mapping,
    missing,
    fileErrors,
    designs: planned,
    materials,
    summary: {
      designs: planned.length,
      ok,
      errors: planned.length - ok,
      materials: materials.length,
      unresolved: materials.filter((m) => m.decision === 'unresolved').length,
    },
  };
}

const REQUIRED: LegacyColumn[] = [
  'design_code',
  'plant_code',
  'fc_mpa',
  'material_name',
  'material_category',
  'quantity',
  'unit',
];
const detectMissing = (m: Mapping) => REQUIRED.filter((c) => m[c] === undefined);
