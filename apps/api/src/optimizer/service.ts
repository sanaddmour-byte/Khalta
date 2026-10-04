// Runs the controlled optimizer for a request: builds the evaluation snapshot (without proportions) from the
// tenant's materials, prices and rule versions, checks the user's characteristics, runs the optimizer with
// the real solver and the independent candidate validator, and shapes what each role may see.
import { schema, type Executor } from '@khalta/db';
import {
  adHocMaterialSchema,
  checkCharacteristics,
  idOf,
  mergePreferences,
  profileLayers,
  type ResolvedCharacteristic,
  PRICE_PATTERN,
  todayAmman,
  cementLabel,
  colourAllows,
  groupKey,
  groupOfParts,
  type EvaluationSnapshot,
  type Properties,
  type StrengthGroup,
  type StrengthModelInput,
} from '@khalta/engine';
import { limitContextFor, selectRules } from '@khalta/engine/evaluate';
import {
  candidateRecord,
  createHighsSolver,
  DEFAULT_OPTIMIZER_SETTINGS,
  optimize,
  prepare,
  type OptimizeResult,
  type OptimizerInput,
  type OptimizerSettings,
  type Solver,
} from '@khalta/engine/optimizer';
import { validateCandidate } from '@khalta/validator';
import type { Mode, RuleRecord } from '@khalta/rules';
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../errors';
import { loadSnapshotMaterials, runEvaluation as runEval } from '../evaluation/service';
import { loadCurrentRecords } from '../rules/service';
import { loadSettings, type Settings } from '../settings';
import { applyProfiles } from '../profiles/service';
import { toInput } from '../strength/service';

export const requestBody = z.strictObject({
  plantId: z.uuid(),
  mode: z.enum(['ACI', 'JS', 'BOTH']).default('BOTH'),
  objective: z.enum(['cheapest', 'closest_to_targets']).default('cheapest'),
  requirements: z.strictObject({
    fcMpa: z.number().positive().max(120),
    basis: z.enum(['cylinder', 'cube', 'b_grade']),
    testAgeDays: z.number().int().positive().max(365).default(28),
    exposure: z.array(z.string().min(1).max(8)).max(12).default([]),
    slumpMm: z.number().min(0).max(300),
    nmasMm: z.number().positive().max(150).nullable().default(null),
    pumpable: z.boolean().default(false),
    s3Option: z
      .union([z.literal(1), z.literal(2)])
      .nullable()
      .default(null),
    airPct: z.number().min(0).max(15).nullable().default(null),
  }),
  /** What-if materials that exist only inside this request (07 §2.4); never saved, never usable in a design until promoted. */
  adHoc: z.array(adHocMaterialSchema).max(10).default([]),
  /** Characteristic profiles to layer under the request (one per scope); trial generation needs approved versions. */
  profileIds: z.array(z.uuid()).max(3).optional(),
  /** Appendix E characteristics; validated and checked against the hard limits by the engine. */
  characteristics: z.unknown().optional(),
  /** M7.1: `white` allows only cements recorded as white; `grey` excludes white cements; `any` (default) allows all. */
  cementColour: z.enum(['any', 'white', 'grey']).default('any'),
  /** The verified project-requirements revision this request is made against (frozen into the design it produces). */
  projectRequirementsId: z.uuid().optional(),
  materials: z
    .strictObject({
      include: z.array(z.uuid()).max(200).optional(),
      exclude: z.array(z.uuid()).max(200).optional(),
      prefer: z.array(z.uuid()).max(200).optional(),
    })
    .optional(),
});
export type RequestBody = z.infer<typeof requestBody>;

let solverPromise: Promise<Solver> | null = null;
/** One WASM instance per process (each solve creates its own native model, so calls never share state). */
export const getSolver = () => (solverPromise ??= createHighsSolver());

export const optimizerSettings = (s: Settings): OptimizerSettings => ({
  ...DEFAULT_OPTIMIZER_SETTINGS,
  scmStepPct: s.optimizer.scmStepPct,
  waterOverrideWarnPct: s.optimizer.waterOverrideWarnPct,
  maxConfigurations: s.optimizer.maxConfigurations,
  candidatesTopN: s.optimizer.candidatesTopN,
  targetWeightJodPerUnit: s.optimizer.targetWeightJodPerUnit,
  scmSearchCapPct: s.optimizer.scmSearchCapPct,
  timeBudgetMs: s.optimizer.timeBudgetSeconds * 1000,
  guardrailGuard: s.optimizer.guardrailGuard,
  minAggregateVolume: s.optimizer.minAggregateVolume,
  roundingTolerance: {
    sand_ratio_pct: s.optimizer.sandRatioTolerancePts,
    wcm: s.optimizer.wcmTolerance,
  },
});

const slimRule = (r: RuleRecord): RuleRecord => {
  const { note_en: _en, note_ar: _ar, group: _g, ...rest } = r;
  return { ...rest, prerequisites: [] };
};

/** The evaluation snapshot of a request, without proportions: every candidate adds its own lines. */
export async function buildRequestSnapshot(
  db: Executor,
  tenantId: string,
  body: RequestBody,
  now = new Date(),
): Promise<Omit<EvaluationSnapshot, 'lines'>> {
  const settings = await loadSettings(db, tenantId);
  const date = todayAmman(now);
  const r = body.requirements;
  const request: EvaluationSnapshot['request'] = {
    fcMpa: r.fcMpa,
    basis: r.basis,
    testAgeDays: r.testAgeDays,
    exposure: r.exposure,
    s3Option: r.s3Option,
    slumpMm: r.slumpMm,
    nmasMm: r.nmasMm,
    pumpable: r.pumpable,
    airPct: r.airPct,
  };
  const mats = await db
    .select({ id: schema.materials.id })
    .from(schema.materials)
    .where(
      and(
        eq(schema.materials.tenantId, tenantId),
        eq(schema.materials.isActive, true),
        isNull(schema.materials.deletedAt),
        or(isNull(schema.materials.plantId), eq(schema.materials.plantId, body.plantId)),
      ),
    );
  const materials = await loadSnapshotMaterials(
    db,
    tenantId,
    body.plantId,
    mats.map((m) => m.id),
    date,
    {},
    now,
  );
  body.adHoc.forEach((a, i) => {
    const price = a.price_jod_per_kg;
    if (price !== undefined && !PRICE_PATTERN.test(price))
      throw new ApiError(400, 'invalid_request', 'An ad-hoc price has at most 3 decimals');
    const fields = Object.fromEntries(
      Object.keys(a.properties).map((k) => [k, 'user_declared' as const]),
    );
    materials.push({
      id: `adhoc-${i + 1}`,
      category: a.category,
      nameEn: a.market_name_en,
      nameAr: a.market_name_ar ?? null,
      test: {
        id: `adhoc-${i + 1}`,
        version: 1,
        source: 'user_declared',
        fieldSources: fields,
        testedAt: date,
        validUntil: null,
        freshness: 'fresh',
        properties: a.properties as Properties,
      },
      price:
        price === undefined
          ? { status: 'unavailable' }
          : {
              status: 'ok',
              priceId: `adhoc-${i + 1}`,
              price,
              unit: 'JOD/kg',
              supplierId: 'adhoc',
              includesDelivery: true,
              effectiveFrom: date,
              staleness: 'fresh',
              ageDays: 0,
            },
    });
  });
  const all = await loadCurrentRecords(db, tenantId);
  const mode = body.mode as Mode;
  const rules = selectRules(all, mode, request).map(slimRule);
  return {
    schema: 1,
    design: { id: 'request', code: 'REQUEST', name: 'Optimizer request', plantId: body.plantId },
    mode,
    evaluationDate: date,
    priceBasis: { kind: 'live', date, snapshotId: null },
    request,
    projectOverrides: [],
    tablePolicy: {},
    rules,
    materials,
    settings: {
      nearLimitPct: settings.nearLimitPct,
      safetyMarginMpa: settings.safetyMarginMpa,
      yieldTolerance: settings.yieldTolerance,
      roundingTolerance: {},
    },
    characteristics: [],
    strengthRecords: null,
  };
}

export interface Resolved {
  ok: boolean;
  invalid: unknown[];
  rejected: unknown[];
  characteristics: ResolvedCharacteristic[];
  profiles: { profileId: string; version: number; status: 'draft' | 'approved' }[];
  origins: Record<string, string>;
  materials: { include?: string[]; exclude?: string[]; prefer?: string[] } | undefined;
}

/** Cements a colour request rules out, added to the request's own exclusions (so the pool says why). */
export function withColour(
  m: { include?: string[]; exclude?: string[]; prefer?: string[] } | undefined,
  materials: readonly {
    id: string;
    category: string;
    test: { properties: Record<string, unknown> } | null;
  }[],
  colour: 'any' | 'white' | 'grey',
): { include?: string[]; exclude?: string[]; prefer?: string[] } | undefined {
  if (colour === 'any') return m;
  const out = materials
    .filter(
      (x) => x.category === 'cement' && !colourAllows(colour, cementLabel(x.test?.properties).kind),
    )
    .map((x) => x.id);
  if (out.length === 0) return m;
  return { ...(m ?? {}), exclude: [...new Set([...(m?.exclude ?? []), ...out])] };
}

/** Profiles (least specific first) then the request, merged and checked against the hard limits. */
export async function resolveCharacteristics(
  db: Executor,
  tenantId: string,
  body: RequestBody,
  snapshot: EvaluationSnapshot,
  forGeneration: boolean,
): Promise<Resolved> {
  const prof = await applyProfiles(db, tenantId, body.plantId, body.profileIds, forGeneration);
  const merged =
    prof.chosen.length > 0 ? mergePreferences(prof.chosen, body.materials) : body.materials;
  const materials = withColour(merged, snapshot.materials, body.cementColour);
  const hasAny = prof.chosen.length > 0 || body.characteristics !== undefined;
  if (!hasAny)
    return {
      ok: true,
      invalid: [],
      rejected: [],
      characteristics: [],
      profiles: [],
      origins: {},
      materials,
    };
  const checked = checkCharacteristics(
    profileLayers(prof.chosen, body.characteristics),
    limitContextFor(snapshot),
  );
  const chars = checked.characteristics ?? [];
  return {
    ok: checked.ok,
    invalid: checked.invalid,
    rejected: checked.rejected,
    characteristics: checked.ok ? chars : [],
    profiles: prof.versions,
    origins: Object.fromEntries(chars.map((c) => [idOf(c), c.origin])),
    materials,
  };
}

export interface RunResult {
  input: OptimizerInput;
  result: OptimizeResult;
  validations: Map<number, ReturnType<typeof validateCandidate>>;
  resolved: Resolved;
}

export async function runOptimizer(
  db: Executor,
  tenantId: string,
  body: RequestBody,
): Promise<RunResult> {
  const settings = await loadSettings(db, tenantId);
  const base = await buildRequestSnapshot(db, tenantId, body);
  const resolved = await resolveCharacteristics(db, tenantId, body, { ...base, lines: [] }, true);
  if (!resolved.ok)
    throw new ApiError(400, 'characteristics_rejected', 'The characteristics were rejected', {
      invalid: resolved.invalid,
      rejected: resolved.rejected,
    });
  base.characteristics = resolved.characteristics;
  const attached = await poolModel(db, tenantId, base, resolved.materials);
  if (attached) base.strengthModel = attached;
  const solver = await getSolver();
  const run = (b: typeof base) =>
    optimize(
      {
        base: b,
        objective: body.objective,
        ...(resolved.materials ? { materials: resolved.materials } : {}),
        settings: optimizerSettings(settings),
      } satisfies OptimizerInput,
      { solver, validate: (rec) => validateCandidate(rec).status === 'pass' },
    );
  let result = await run(base);
  // The model describes ONE group. A candidate that uses other SCMs or admixtures is outside it, so the whole run
  // falls back to the ACI 211.1 baseline (stated in each report) rather than apply a model where it does not hold.
  if (
    attached &&
    result.candidates.some((c) => {
      const g = groupOfParts(base.design.plantId, base.request, c.lines, base.materials);
      return !g || groupKey(g) !== attached.groupKey;
    })
  ) {
    delete base.strengthModel;
    result = await run(base);
  }
  const input: OptimizerInput = {
    base,
    objective: body.objective,
    ...(resolved.materials ? { materials: resolved.materials } : {}),
    settings: optimizerSettings(settings),
  };
  const validations = new Map(
    result.candidates.map((c) => [
      c.rank,
      validateCandidate(candidateRecord(c, resolved.materials ?? {})),
    ]),
  );
  return { input, result, validations, resolved };
}

/** The in-force model whose cement is the request's only cement candidate (candidates are re-checked after the run). */
async function poolModel(
  db: Executor,
  tenantId: string,
  base: Omit<EvaluationSnapshot, 'lines'>,
  pick: { include?: string[]; exclude?: string[] } | undefined,
): Promise<StrengthModelInput | null> {
  const { basis, testAgeDays } = base.request;
  if ((basis !== 'cylinder' && basis !== 'cube') || testAgeDays === null) return null;
  const allowed = (id: string) =>
    !pick?.exclude?.includes(id) && (!pick?.include?.length || pick.include.includes(id));
  const cements = base.materials.filter((m) => m.category === 'cement' && allowed(m.id));
  if (cements.length !== 1) return null;
  const rows = await db
    .select()
    .from(schema.strengthModels)
    .where(
      and(
        eq(schema.strengthModels.tenantId, tenantId),
        eq(schema.strengthModels.plantId, base.design.plantId),
        eq(schema.strengthModels.ageDays, testAgeDays),
        eq(schema.strengthModels.basis, basis),
        isNotNull(schema.strengthModels.approvedAt),
        isNull(schema.strengthModels.retiredAt),
        eq(schema.strengthModels.status, 'valid'),
      ),
    );
  // a model qualifies when every material of its group is in the pool; more than one qualifying model is ambiguous
  const pool = new Set(base.materials.filter((m) => allowed(m.id)).map((m) => m.id));
  const mine = rows.filter((m) => {
    const g = m.grp as StrengthGroup;
    return [g.cementId, ...g.scm.map((x) => x.id), ...g.admixtures.map((x) => x.id)].every((id) =>
      pool.has(id),
    );
  });
  return mine.length === 1 ? toInput(mine[0]!) : null;
}

/** The exact snapshot a stored candidate was judged on, rebuilt from the request and its overrides. */
export function candidateSnapshot(
  requestSnapshot: Omit<EvaluationSnapshot, 'lines'>,
  cand: { lines: unknown; overrides: unknown },
): EvaluationSnapshot {
  const o = cand.overrides as {
    request: EvaluationSnapshot['request'];
    roundingTolerance: Record<string, number>;
  };
  return {
    ...requestSnapshot,
    lines: cand.lines as EvaluationSnapshot['lines'],
    request: o.request,
    settings: { ...requestSnapshot.settings, roundingTolerance: o.roundingTolerance },
  };
}

// ------------------------------------------------------------------- Studio helpers (M3.2)

const REQUIREMENTS_SHOWN = new Set([
  'max_wcm',
  'min_fc',
  'max_cl_nonprestressed',
  'max_cl_prestressed',
  'sulfate_cement',
  'scm_required',
  'cacl2_prohibited',
  'air_target_pct',
  'air_tolerance_pct',
]);

function cementLabelOf(m: { test: { properties?: unknown } | null }) {
  const l = cementLabel((m.test?.properties ?? {}) as Record<string, unknown>);
  return { cementKind: l.kind, cementClass: l.strengthClass };
}

/**
 * Everything the Requirements stage needs before anything is solved: which materials are usable at the plant
 * (and why not), the live code/project limits that bound the characteristics, what the optimizer would be
 * blocked on, and whether the characteristics are acceptable. Writes nothing.
 */
export async function preflight(db: Executor, tenantId: string, body: RequestBody) {
  const base = await buildRequestSnapshot(db, tenantId, body);
  const ctxLimits = limitContextFor({ ...base, lines: [] });
  const resolved = await resolveCharacteristics(db, tenantId, body, { ...base, lines: [] }, false);
  const characteristics = {
    ok: resolved.ok,
    invalid: resolved.invalid,
    rejected: resolved.rejected,
  };
  if (resolved.ok) base.characteristics = resolved.characteristics;
  const settings = await loadSettings(db, tenantId);
  const prep = prepare({
    base,
    objective: body.objective,
    ...(resolved.materials ? { materials: resolved.materials } : {}),
    settings: optimizerSettings(settings),
  });
  const excluded = new Map(
    (prep.ok ? prep.prepared.excluded : prep.excluded).map((e) => [e.materialId, e.reason]),
  );
  return {
    pool: base.materials.map((m) => ({
      id: m.id,
      category: m.category,
      nameEn: m.nameEn,
      nameAr: m.nameAr,
      usable: !excluded.has(m.id),
      reason: excluded.get(m.id) ?? null,
      hasTest: m.test !== null,
      source: m.test?.source ?? null,
      ...(m.category === 'cement' ? cementLabelOf(m) : {}),
    })),
    bounds: ctxLimits.resolved.requirements
      .filter((r) => REQUIREMENTS_SHOWN.has(r.requirement) || r.requirement.startsWith('scm.max.'))
      .map((r) => ({
        requirement: r.requirement,
        value: r.value,
        status: r.status,
        source: r.governing ? String(r.governing.source) : null,
        clause: r.governing?.clause_ref ?? null,
        verified: r.verified,
      })),
    fcrMpa: ctxLimits.codeFcrMpa,
    blockers: prep.ok ? [] : prep.blockers,
    baseline: prep.ok
      ? {
          wc: prep.prepared.baselineWc,
          wcmCeiling: prep.prepared.wcmCeiling,
          waterKg: Object.fromEntries(prep.prepared.baseWaterKg),
        }
      : null,
    characteristics,
    profiles: resolved.profiles,
    origins: resolved.origins,
  };
}

/** Evaluate a typed (unsaved) mix and run the independent validator; stores nothing. */
export async function evaluateMix(
  db: Executor,
  tenantId: string,
  body: RequestBody,
  lines: { materialId: string; kgPerM3: string }[],
) {
  const base = await buildRequestSnapshot(db, tenantId, body);
  const ids = new Set(base.materials.map((m) => m.id));
  if (lines.some((l) => !ids.has(l.materialId)))
    throw new ApiError(
      400,
      'invalid_request',
      'A line refers to a material not available at this plant',
    );
  if (new Set(lines.map((l) => l.materialId)).size !== lines.length)
    throw new ApiError(400, 'invalid_request', 'A material appears twice in the lines');
  const snapshot: EvaluationSnapshot = { ...base, lines };
  const resolved = await resolveCharacteristics(db, tenantId, body, snapshot, false);
  if (!resolved.ok)
    throw new ApiError(400, 'characteristics_rejected', 'The characteristics were rejected', {
      invalid: resolved.invalid,
      rejected: resolved.rejected,
    });
  snapshot.characteristics = resolved.characteristics;
  return runEval(snapshot);
}

const MAP_KEYED = ['agg_kg', 'agg_share_pct'] as const;

/** Re-express a request's material references (ids) for another plant; `null` entries mean "no counterpart". */
export function mapRequest(
  body: RequestBody,
  plantId: string,
  map: Record<string, string | null>,
): { ok: true; body: RequestBody } | { ok: false; missing: string[] } {
  const missing = new Set<string>();
  const one = (id: string): string => {
    const to = map[id];
    if (to === undefined || to === null) {
      missing.add(id);
      return id;
    }
    return to;
  };
  const list = (xs?: string[]) => (xs ? xs.map(one) : undefined);
  const next: RequestBody = { ...body, plantId };
  if (body.materials)
    next.materials = {
      ...(body.materials.include ? { include: list(body.materials.include)! } : {}),
      ...(body.materials.exclude ? { exclude: list(body.materials.exclude)! } : {}),
      ...(body.materials.prefer ? { prefer: list(body.materials.prefer)! } : {}),
    };
  if (body.characteristics && typeof body.characteristics === 'object') {
    const c = JSON.parse(JSON.stringify(body.characteristics)) as Record<string, unknown>;
    for (const k of MAP_KEYED) {
      const m = c[k] as Record<string, unknown> | undefined;
      if (m) c[k] = Object.fromEntries(Object.entries(m).map(([id, v]) => [one(id), v]));
    }
    for (const k of ['scm', 'admixture']) {
      const s = c[k] as { product?: string } | undefined;
      if (s?.product) s.product = one(s.product);
    }
    next.characteristics = c;
  }
  return missing.size ? { ok: false, missing: [...missing] } : { ok: true, body: next };
}
