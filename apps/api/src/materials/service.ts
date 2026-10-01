import { schema, type Executor } from '@khalta/db';
import {
  blockers,
  declaredKeyFields,
  detectDrift,
  fineModulus,
  freshness,
  overallSource,
  parseProperties,
  readiness,
  sanityWarnings,
  validateGradation,
  validateWaterReduction,
  DEFAULT_FM_SIEVES,
  type Category,
  type GradationPoint,
  type Properties,
  type ReadinessContext,
  type Source,
} from '@khalta/engine';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { ApiError } from '../errors';
import { sameJson } from '../rules/canonical';
import { currentRules } from '../rules/service';
import type { Settings } from '../settings';

export type MaterialRow = typeof schema.materials.$inferSelect;
export type TestRow = typeof schema.materialTests.$inferSelect;
export type FieldSources = Record<string, Source>;

/** Engineering parameters the materials module reads from the rules library (null = not configured). */
export interface MaterialParams {
  fmSieves: readonly number[];
  testAgeLimitDays: Record<string, number | null>;
  driftTolerance: Record<string, number | null>;
}

export async function loadMaterialParams(db: Executor, tenantId: string): Promise<MaterialParams> {
  const params: MaterialParams = {
    fmSieves: DEFAULT_FM_SIEVES,
    testAgeLimitDays: {},
    driftTolerance: {},
  };
  for (const { row, ruleset } of await currentRules(db, tenantId)) {
    if (ruleset !== 'ENGINEERING') continue;
    const num = typeof row.value === 'number' ? row.value : null;
    if (
      row.key === 'eng.fm.sieves' &&
      Array.isArray(row.value) &&
      row.value.every((v) => typeof v === 'number')
    )
      params.fmSieves = row.value as number[];
    else if (row.key.startsWith('eng.test_age_limit_days.'))
      params.testAgeLimitDays[row.key.slice(24)] = num;
    else if (row.key.startsWith('eng.drift.tolerance.'))
      params.driftTolerance[row.key.slice(20)] = num;
  }
  return params;
}

const jsonErr = (message: string, details?: unknown) =>
  new ApiError(400, 'invalid_request', message, details);

export interface TestInput {
  properties: Properties;
  source: Source;
  fieldSources?: FieldSources | undefined;
  declaredReason?: string | undefined;
  hasAttachment: boolean;
}

/**
 * Validates a new test version against the previous one and resolves per-field provenance:
 * unchanged fields keep their previous source; new or changed fields take `fieldSources[f] ?? source`.
 * Hard errors throw 400 (properties schema, gradation, water-reduction table, evidence rules);
 * sanity-range hits are returned as warnings only.
 */
export function resolveNewTest(
  category: Category,
  input: TestInput,
  previous: Pick<TestRow, 'properties' | 'fieldSources'> | undefined,
  settings: Settings,
) {
  const parsed = parseProperties(category, input.properties);
  if (!parsed.ok) throw jsonErr('Invalid material properties', parsed.errors);
  const props = parsed.data;
  const present = Object.keys(props).filter((k) => props[k] !== undefined && props[k] !== null);
  if (present.length === 0) throw jsonErr('A test needs at least one property');
  const sieve = props['sieve_analysis'] as GradationPoint[] | undefined;
  if (sieve) {
    const errs = validateGradation(sieve);
    if (errs.length) throw jsonErr('Invalid gradation', errs);
  }
  const wr = validateWaterReduction(props);
  if (wr.length) throw jsonErr('Invalid admixture table', wr);

  const prevProps = (previous?.properties ?? {}) as Properties;
  const prevSources = (previous?.fieldSources ?? {}) as FieldSources;
  const sources: FieldSources = {};
  const changed: string[] = [];
  for (const k of present) {
    // Same value keeps its provenance unless the caller explicitly re-sources it (a source upgrade is a change).
    const explicit = input.fieldSources?.[k];
    if (
      previous &&
      k in prevProps &&
      sameJson(prevProps[k], props[k]) &&
      prevSources[k] &&
      (!explicit || explicit === prevSources[k])
    )
      sources[k] = prevSources[k]!;
    else {
      sources[k] = explicit ?? input.source;
      changed.push(k);
    }
  }
  for (const k of Object.keys(input.fieldSources ?? {}))
    if (!present.includes(k))
      throw jsonErr(`fieldSources names "${k}", which is not in properties`);
  const removed = Object.keys(prevProps).filter((k) => !present.includes(k));
  if (changed.length === 0 && removed.length === 0)
    throw new ApiError(409, 'conflict', 'Nothing changed from the current test');

  const needsAttachment = changed.some((k) => sources[k] === 'lab_report');
  if (needsAttachment && !input.hasAttachment)
    throw jsonErr('A lab-report value needs the report attached');
  const declared = changed.filter((k) => sources[k] === 'user_declared');
  if (declared.length && !(input.declaredReason && input.declaredReason.trim().length >= 3))
    throw jsonErr('Say why these values are declared without a document', { fields: declared });

  const source = overallSource(sources, input.source);
  // DB rule: a lab_report record carries its attachment (the weakest source is lab_report only if every field is).
  if (source === 'lab_report' && !input.hasAttachment)
    throw jsonErr('A lab-report value needs the report attached');
  const warnings = sanityWarnings(category, props, settings.sanityRanges);
  return { props, sources, source, changed, removed, declared, warnings };
}

export function summarize(
  category: Category,
  test: TestRow | undefined,
  previous: TestRow | undefined,
  params: MaterialParams,
  now: Date,
  ctx: ReadinessContext = {},
) {
  if (!test) return { hasTest: false as const, canEvaluate: false, canDesign: false };
  const props = test.properties as Properties;
  const fieldSources = test.fieldSources as FieldSources;
  const fctx = { ...ctx, fmSieves: params.fmSieves };
  const r = readiness(category, props, fctx);
  const sieve = props['sieve_analysis'] as GradationPoint[] | undefined;
  const fm = sieve ? fineModulus(sieve, params.fmSieves) : undefined;
  return {
    hasTest: true as const,
    canEvaluate: r.canEvaluate,
    canDesign: r.canDesign,
    evaluateBlockers: r.evaluate,
    designBlockers: r.design,
    fm: fm?.ok ? fm.fm : null,
    fmMissing: fm && !fm.ok ? fm.missing : [],
    source: test.source,
    declaredKeyFields: declaredKeyFields(category, props, fieldSources, fctx),
    freshness: freshness(test.testedAt, now, params.testAgeLimitDays[category]),
    drift: previous
      ? detectDrift(
          previous.properties as Properties,
          props,
          params.driftTolerance,
          params.fmSieves,
        )
      : [],
  };
}

export async function currentTest(db: Executor, tenantId: string, materialId: string) {
  const [t] = await db
    .select()
    .from(schema.materialTests)
    .where(
      and(
        eq(schema.materialTests.tenantId, tenantId),
        eq(schema.materialTests.materialId, materialId),
        eq(schema.materialTests.isCurrent, true),
      ),
    );
  return t;
}

export async function testHistory(db: Executor, tenantId: string, materialId: string) {
  return db
    .select()
    .from(schema.materialTests)
    .where(
      and(
        eq(schema.materialTests.tenantId, tenantId),
        eq(schema.materialTests.materialId, materialId),
      ),
    )
    .orderBy(desc(schema.materialTests.version));
}

export async function loadMaterial(db: Executor, tenantId: string, id: string) {
  const [m] = await db
    .select()
    .from(schema.materials)
    .where(
      and(
        eq(schema.materials.id, id),
        eq(schema.materials.tenantId, tenantId),
        isNull(schema.materials.deletedAt),
      ),
    );
  return m;
}

export { blockers };
