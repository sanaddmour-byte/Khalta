// Runs the controlled optimizer for a request: builds the evaluation snapshot (without proportions) from the
// tenant's materials, prices and rule versions, checks the user's characteristics, runs the optimizer with
// the real solver and the independent candidate validator, and shapes what each role may see.
import { schema, type Executor } from '@khalta/db';
import { checkCharacteristics, todayAmman, type EvaluationSnapshot } from '@khalta/engine';
import { limitContextFor, selectRules } from '@khalta/engine/evaluate';
import {
  candidateRecord,
  createHighsSolver,
  DEFAULT_OPTIMIZER_SETTINGS,
  optimize,
  type OptimizeResult,
  type OptimizerInput,
  type OptimizerSettings,
  type Solver,
} from '@khalta/engine/optimizer';
import { validateCandidate } from '@khalta/validator';
import type { Mode, RuleRecord } from '@khalta/rules';
import { and, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../errors';
import { loadSnapshotMaterials } from '../evaluation/service';
import { loadCurrentRecords } from '../rules/service';
import { loadSettings, type Settings } from '../settings';

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
  /** Appendix E characteristics; validated and checked against the hard limits by the engine. */
  characteristics: z.unknown().optional(),
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

export interface RunResult {
  input: OptimizerInput;
  result: OptimizeResult;
  validations: Map<number, ReturnType<typeof validateCandidate>>;
}

export async function runOptimizer(
  db: Executor,
  tenantId: string,
  body: RequestBody,
): Promise<RunResult> {
  const settings = await loadSettings(db, tenantId);
  const base = await buildRequestSnapshot(db, tenantId, body);
  if (body.characteristics !== undefined) {
    const checked = checkCharacteristics(
      [{ level: 'request', origin: 'request', characteristics: body.characteristics }],
      limitContextFor({ ...base, lines: [] }),
    );
    if (!checked.ok)
      throw new ApiError(400, 'characteristics_rejected', 'The characteristics were rejected', {
        invalid: checked.invalid,
        rejected: checked.rejected,
      });
    base.characteristics = checked.characteristics ?? [];
  }
  const input: OptimizerInput = {
    base,
    objective: body.objective,
    ...(body.materials ? { materials: body.materials } : {}),
    settings: optimizerSettings(settings),
  };
  const result = await optimize(input, {
    solver: await getSolver(),
    validate: (rec) => validateCandidate(rec).status === 'pass',
  });
  const validations = new Map(
    result.candidates.map((c) => [
      c.rank,
      validateCandidate(candidateRecord(c, body.materials ?? {})),
    ]),
  );
  return { input, result, validations };
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
