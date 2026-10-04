// Plant strength models (M5.2): gather the results of one group, fit (a proposal), store the fit with the points it
// used, find the APPROVED valid model for a design's group, and re-check approved models against today's materials.
// Nothing here approves, applies or changes a design or a rule.
import { createHash } from 'node:crypto';
import { schema, type AuditRecorder, type Executor } from '@khalta/db';
import {
  DEFAULT_FIT_LIMITS,
  fitModel,
  groupKey,
  groupOfParts,
  invalidations,
  kindOfMaterial,
  windowStart,
  type EvaluationSnapshot,
  FIT_VERSION,
  type FitLimits,
  type FitResult,
  type GroupMaterial,
  type StrengthGroup,
  type StrengthModelInput,
  type StrengthPoint,
} from '@khalta/engine';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { settingsSchema } from '../settings';
import type { z } from 'zod';

type Settings = z.infer<typeof settingsSchema>;
export type ModelRow = typeof schema.strengthModels.$inferSelect;

export const limitsFrom = (s: Settings): FitLimits => ({
  ...DEFAULT_FIT_LIMITS,
  minResults: s.strengthModelMinResults,
  minLevels: s.strengthModelMinLevels,
  minSpan: s.strengthModelMinSpan,
  windowMonths: s.strengthModelWindowMonths,
  rmseFactor: s.strengthHeldOutRmseFactor,
  missS: s.strengthHeldOutMissS,
});

/** The group of a stored design, from its lines and the materials' CURRENT tests. */
export async function designGroup(
  db: Executor,
  d: { id: string; plantId: string; requirements: unknown },
): Promise<StrengthGroup | null> {
  const req = d.requirements as { basis?: string | null; testAgeDays?: number | null };
  const lines = await db
    .select({ materialId: schema.mixDesignLines.materialId })
    .from(schema.mixDesignLines)
    .where(eq(schema.mixDesignLines.designId, d.id));
  const ids = [...new Set(lines.map((l) => l.materialId))];
  if (ids.length === 0) return null;
  const mats = await materialsNow(db, ids);
  return groupOfParts(
    d.plantId,
    { basis: req.basis ?? null, testAgeDays: req.testAgeDays ?? null },
    lines,
    mats.map((m) => ({
      id: m.id,
      category: m.category,
      supplierId: m.supplierId,
      test: { properties: m.properties },
    })),
  );
}

async function materialsNow(db: Executor, ids: string[]) {
  const mats = await db
    .select({
      id: schema.materials.id,
      category: schema.materials.category,
      supplierId: schema.materials.supplierId,
    })
    .from(schema.materials)
    .where(and(inArray(schema.materials.id, ids), isNull(schema.materials.deletedAt)));
  const tests = await db
    .select({
      materialId: schema.materialTests.materialId,
      properties: schema.materialTests.properties,
    })
    .from(schema.materialTests)
    .where(
      and(inArray(schema.materialTests.materialId, ids), eq(schema.materialTests.isCurrent, true)),
    );
  const by = new Map(tests.map((t) => [t.materialId, t.properties as Record<string, unknown>]));
  return mats.map((m) => ({
    id: m.id,
    category: m.category as GroupMaterial['category'],
    supplierId: m.supplierId,
    properties: by.get(m.id) ?? {},
  }));
}

/** The group parts as they are today, for invalidation checks. */
export async function groupMaterialsNow(db: Executor, g: StrengthGroup): Promise<GroupMaterial[]> {
  const ids = [g.cementId, ...g.scm.map((s) => s.id), ...g.admixtures.map((s) => s.id)];
  const mats = await materialsNow(db, ids);
  return mats.map((m) => ({
    id: m.id,
    category: m.category,
    kind: kindOfMaterial(m.category, m.properties),
    supplierId: m.supplierId,
  }));
}

interface SetPoint {
  resultId: string;
  designId: string;
  castDate: string;
  mpa: number;
}

/** One test per set: the average of its specimens (ACI 318 §26.12), keyed by the first result's id. */
async function setsAt(
  db: Executor,
  tenantId: string,
  plantId: string,
  ageDays: number,
  basis: 'cylinder' | 'cube',
): Promise<SetPoint[]> {
  const rows = await db
    .select()
    .from(schema.strengthResults)
    .where(
      and(
        eq(schema.strengthResults.tenantId, tenantId),
        eq(schema.strengthResults.plantId, plantId),
        eq(schema.strengthResults.ageDays, ageDays),
        eq(schema.strengthResults.specimenType, basis),
      ),
    )
    .orderBy(
      asc(schema.strengthResults.castDate),
      asc(schema.strengthResults.createdAt),
      asc(schema.strengthResults.id),
    );
  const sets = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.designId}|${r.setId}`;
    sets.set(k, [...(sets.get(k) ?? []), r]);
  }
  return [...sets.values()].map((g) => ({
    resultId: g[0]!.id,
    designId: g[0]!.designId,
    castDate: g[0]!.castDate,
    mpa: g.reduce((a, r) => a + Number(r.resultMpa), 0) / g.length,
  }));
}

async function wcmOf(db: Executor, designId: string): Promise<number | null> {
  const [d] = await db
    .select({ ev: schema.mixDesigns.lastEvaluationId })
    .from(schema.mixDesigns)
    .where(eq(schema.mixDesigns.id, designId));
  if (!d?.ev) return null;
  const [e] = await db
    .select({ report: schema.designEvaluations.report })
    .from(schema.designEvaluations)
    .where(eq(schema.designEvaluations.id, d.ev));
  const v = (e?.report as { figures?: Record<string, unknown> } | undefined)?.figures?.[
    'ratio.wcm'
  ];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export interface Gathered {
  points: StrengthPoint[];
  rows: {
    resultId: string;
    wcm: number | null;
    mpa: number;
    included: boolean;
    exclusion: string | null;
  }[];
}

/** Every set of the group's plant, age and basis that belongs to this group, with why any is left out. */
export async function gather(
  db: Executor,
  tenantId: string,
  g: StrengthGroup,
  today: string,
  limits: FitLimits,
): Promise<Gathered> {
  const sets = await setsAt(db, tenantId, g.plantId, g.ageDays, g.basis);
  const key = groupKey(g);
  const start = windowStart(today, limits.windowMonths);
  const cache = new Map<string, { in: boolean; wcm: number | null }>();
  const out: Gathered = { points: [], rows: [] };
  for (const s of sets) {
    let c = cache.get(s.designId);
    if (!c) {
      const [d] = await db
        .select()
        .from(schema.mixDesigns)
        .where(eq(schema.mixDesigns.id, s.designId));
      const dg = d ? await designGroup(db, d) : null;
      c = { in: !!dg && groupKey(dg) === key, wcm: d ? await wcmOf(db, d.id) : null };
      cache.set(s.designId, c);
    }
    if (!c.in) continue;
    const exclusion =
      s.castDate < start ? 'outside_window' : c.wcm === null ? 'no_evaluation' : null;
    out.rows.push({
      resultId: s.resultId,
      wcm: c.wcm,
      mpa: s.mpa,
      included: exclusion === null,
      exclusion,
    });
    if (!exclusion && c.wcm !== null)
      out.points.push({ id: s.resultId, wcm: c.wcm, mpa: s.mpa, castDate: s.castDate });
  }
  return out;
}

/** Sets (anywhere in the plant) whose design's group cannot be identified: listed, never guessed. */
export async function unassigned(db: Executor, tenantId: string, plantId: string) {
  const out: { designId: string; reason: string; sets: number }[] = [];
  const sets = await db
    .select({ designId: schema.strengthResults.designId, setId: schema.strengthResults.setId })
    .from(schema.strengthResults)
    .where(
      and(
        eq(schema.strengthResults.tenantId, tenantId),
        eq(schema.strengthResults.plantId, plantId),
      ),
    );
  const per = new Map<string, Set<string>>();
  for (const s of sets) per.set(s.designId, (per.get(s.designId) ?? new Set()).add(s.setId));
  for (const [designId, ids] of per) {
    const [d] = await db.select().from(schema.mixDesigns).where(eq(schema.mixDesigns.id, designId));
    if (!d) continue;
    const g = await designGroup(db, d);
    if (!g) out.push({ designId, reason: 'materials_not_identifiable', sets: ids.size });
  }
  return out;
}

/** Every distinct group that has results at the plant (all ages and bases present). */
export async function groupsAt(
  db: Executor,
  tenantId: string,
  plantId?: string,
): Promise<StrengthGroup[]> {
  const rows = await db
    .select({ designId: schema.strengthResults.designId })
    .from(schema.strengthResults)
    .where(
      and(
        eq(schema.strengthResults.tenantId, tenantId),
        ...(plantId ? [eq(schema.strengthResults.plantId, plantId)] : []),
      ),
    );
  const seen = new Map<string, StrengthGroup>();
  for (const id of new Set(rows.map((r) => r.designId))) {
    const [d] = await db.select().from(schema.mixDesigns).where(eq(schema.mixDesigns.id, id));
    const g = d ? await designGroup(db, d) : null;
    if (g) seen.set(groupKey(g), g);
  }
  return [...seen.values()];
}

const modelHash = (m: { a: string; b: string; groupKey: string; wcmMin: string; wcmMax: string }) =>
  createHash('sha256')
    .update(JSON.stringify([m.groupKey, m.a, m.b, m.wcmMin, m.wcmMax]))
    .digest('hex');

/**
 * The stored validation report: what the model was trained on, the limits it was judged against, both validation
 * checks, its operating domain and the fit version. Everything a reviewer needs to decide on approval without
 * recomputing. `pointsSha256` fingerprints the exact training set (result ids and values).
 */
export function validationReport(
  g: StrengthGroup,
  fit: FitResult,
  points: { id: string; wcm: number; mpa: number; castDate: string }[],
  limits: FitLimits,
  today: string,
) {
  const dates = points.map((p) => p.castDate).sort();
  const ordered = [...points].sort((a, b) => a.id.localeCompare(b.id));
  return {
    fitVersion: FIT_VERSION,
    fittedOn: today,
    group: { key: groupKey(g), basis: g.basis, ageDays: g.ageDays, sources: g.sources ?? null },
    training: {
      n: fit.n,
      levels: fit.levels,
      firstCast: dates[0] ?? null,
      lastCast: dates[dates.length - 1] ?? null,
      pointsSha256: createHash('sha256')
        .update(JSON.stringify(ordered.map((p) => [p.id, p.wcm, p.mpa, p.castDate])))
        .digest('hex'),
    },
    limits,
    domain: { wcmMin: fit.wcmMin, wcmMax: fit.wcmMax, ageDays: g.ageDays, basis: g.basis },
    figures: { sMpa: fit.sMpa, r2: fit.r2, seA: fit.seA, seB: fit.seB },
    heldOut: fit.heldOut,
    chronological: fit.chronological,
    status: fit.status,
    reasons: fit.reasons,
    // A supplier recorded in place on a material cannot be traced back per result: noted, never hidden.
    sourceNote:
      'A source change must be recorded as a new material; an in-place supplier change invalidates an approved model.',
  };
}

export type FitOutcome =
  | { kind: 'fitted'; model: ModelRow; fit: FitResult; created: boolean }
  | { kind: 'insufficient'; n: number };

/** Fit one group and store it (a proposal). An unchanged input set does not create a duplicate row. */
export async function fitGroup(
  tx: Executor,
  tenantId: string,
  g: StrengthGroup,
  settings: Settings,
  actorId: string | null,
  today: string,
): Promise<FitOutcome> {
  const limits = limitsFrom(settings);
  const got = await gather(tx, tenantId, g, today, limits);
  const fit = fitModel(got.points, limits);
  if (!fit) return { kind: 'insufficient', n: got.points.length };
  const key = groupKey(g);
  const existing = await tx
    .select()
    .from(schema.strengthModels)
    .where(
      and(eq(schema.strengthModels.tenantId, tenantId), eq(schema.strengthModels.groupKey, key)),
    );
  const newest = existing.sort((x, y) => y.fittedAt.getTime() - x.fittedAt.getTime())[0];
  if (newest) {
    const prev = await tx
      .select({ id: schema.strengthModelPoints.resultId, inc: schema.strengthModelPoints.included })
      .from(schema.strengthModelPoints)
      .where(eq(schema.strengthModelPoints.modelId, newest.id));
    const a = prev
      .filter((p) => p.inc)
      .map((p) => p.id)
      .sort()
      .join(',');
    const b = got.points
      .map((p) => p.id)
      .sort()
      .join(',');
    if (a === b && newest.status === fit.status && !newest.retiredAt)
      return { kind: 'fitted', model: newest, fit, created: false };
  }
  const [row] = await tx
    .insert(schema.strengthModels)
    .values({
      tenantId,
      plantId: g.plantId,
      groupKey: key,
      grp: g,
      ageDays: g.ageDays,
      basis: g.basis,
      a: fit.a.toFixed(6),
      b: fit.b.toFixed(6),
      seA: fit.seA.toFixed(6),
      seB: fit.seB.toFixed(6),
      n: fit.n,
      levels: fit.levels,
      wcmMin: fit.wcmMin.toFixed(6),
      wcmMax: fit.wcmMax.toFixed(6),
      sMpa: fit.sMpa.toFixed(6),
      r2: fit.r2.toFixed(6),
      heldOut: fit.heldOut,
      chronological: fit.chronological,
      validationReport: validationReport(g, fit, got.points, limits, today),
      fitVersion: FIT_VERSION,
      reasons: fit.reasons,
      status: fit.status,
      fittedBy: actorId,
    })
    .returning();
  if (got.rows.length > 0)
    await tx.insert(schema.strengthModelPoints).values(
      got.rows.map((r) => ({
        modelId: row!.id,
        resultId: r.resultId,
        wcm: r.wcm === null ? null : r.wcm.toFixed(6),
        mpa: r.mpa.toFixed(2),
        included: r.included,
        exclusion: r.exclusion,
      })),
    );
  return { kind: 'fitted', model: row!, fit, created: true };
}

export const toInput = (m: ModelRow): StrengthModelInput => ({
  id: m.id,
  a: Number(m.a),
  b: Number(m.b),
  wcmMin: Number(m.wcmMin),
  wcmMax: Number(m.wcmMax),
  ageDays: m.ageDays,
  basis: m.basis,
  groupKey: m.groupKey,
  sMpa: Number(m.sMpa),
});

/** The approved, valid, not-retired model of a group, if any. */
export async function modelInForce(
  db: Executor,
  tenantId: string,
  key: string,
): Promise<ModelRow | null> {
  const [m] = await db
    .select()
    .from(schema.strengthModels)
    .where(
      and(
        eq(schema.strengthModels.tenantId, tenantId),
        eq(schema.strengthModels.groupKey, key),
        isNotNull(schema.strengthModels.approvedAt),
        isNull(schema.strengthModels.retiredAt),
        eq(schema.strengthModels.status, 'valid'),
      ),
    );
  return m ?? null;
}

/** For a snapshot: the approved valid model of the design's own group (never a model of another group). */
export async function modelForSnapshot(
  db: Executor,
  tenantId: string,
  s: Pick<EvaluationSnapshot, 'design' | 'request' | 'lines' | 'materials'>,
): Promise<StrengthModelInput | null> {
  const g = groupOfParts(
    s.design.plantId,
    s.request,
    s.lines,
    s.materials.map((m) => ({ id: m.id, category: m.category, test: m.test })),
  );
  if (!g) return null;
  const m = await modelInForce(db, tenantId, groupKey(g));
  return m ? toInput(m) : null;
}

/** Compare approved models with the materials and results of today; an invalid one is marked and reported. */
export async function revalidateApproved(
  tx: Executor,
  audit: AuditRecorder,
  tenantId: string,
  settings: Settings,
  today: string,
): Promise<
  { id: string; groupKey: string; plantId: string; reasons: { code: string; detail: string }[] }[]
> {
  const live = await tx
    .select()
    .from(schema.strengthModels)
    .where(
      and(
        eq(schema.strengthModels.tenantId, tenantId),
        isNotNull(schema.strengthModels.approvedAt),
        isNull(schema.strengthModels.retiredAt),
        eq(schema.strengthModels.status, 'valid'),
      ),
    );
  const bad: Awaited<ReturnType<typeof revalidateApproved>> = [];
  const limits = limitsFrom(settings);
  for (const m of live) {
    const g = m.grp as StrengthGroup;
    const now = await groupMaterialsNow(tx, g);
    const got = await gather(tx, tenantId, g, today, limits);
    const reasons = invalidations(g, now, got.points.length);
    if (reasons.length === 0) continue;
    await tx
      .update(schema.strengthModels)
      .set({ status: 'invalidated', reasons })
      .where(eq(schema.strengthModels.id, m.id));
    await audit.record({
      action: 'strength_model.invalidate',
      entityType: 'strength_model',
      entityId: m.id,
      after: { reasons },
    });
    bad.push({ id: m.id, groupKey: m.groupKey, plantId: m.plantId, reasons });
  }
  return bad;
}

export { modelHash };
