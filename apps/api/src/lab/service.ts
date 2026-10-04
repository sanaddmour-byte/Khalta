// Production conversion on the server (F-024): gathers the design's lines, the aggregates' absorption and the
// admixtures' solids from their current tests, the QC moisture limits from the rules and the tenant convention,
// then runs the pure conversion and the independent batch validator.
import { schema, type Executor } from '@khalta/db';
import type {
  BatchConfig,
  BatchDesignLine,
  BatchResult,
  BatchValidation,
  MoistureInput,
} from '@khalta/engine';
import {
  CONVERSION_VERSION,
  PLAN_VERSION,
  planBatch,
  toBatchWeights,
} from '@khalta/engine/production';
import {
  PLAN_CATEGORIES,
  type BatchPlan,
  type PlanConfig,
  type PlanValidation,
} from '@khalta/engine';
import {
  BATCH_VALIDATOR_VERSION,
  PLAN_VALIDATOR_VERSION,
  validateBatch,
  validatePlan,
} from '@khalta/validator';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../errors';
import type { DesignRow } from '../evaluation/service';
import { designLines, ruleNumber, versionHash } from '../lifecycle/service';
import { loadCurrentRecords } from '../rules/service';
import { loadSettings } from '../settings';

export const moistureBody = z.strictObject({
  moisture: z
    .array(
      z.strictObject({
        materialId: z.uuid(),
        totalMoisturePct: z.number().min(0).max(100),
        /** ISO time of the reading; defaults to now (a reading entered at the batching desk). */
        measuredAt: z.iso.datetime().optional(),
        /** Where the reading came from; recorded with it and exported (never judged). */
        source: z.enum(['batching_desk', 'lab_test', 'probe']).optional(),
      }),
    )
    .max(20),
});
export type MoistureBody = z.infer<typeof moistureBody>;

export interface Conversion {
  design: BatchDesignLine[];
  moisture: MoistureInput[];
  config: BatchConfig;
  result: BatchResult;
  validator: BatchValidation;
}

export async function convert(
  db: Executor,
  tenantId: string,
  d: DesignRow,
  body: MoistureBody,
  now = new Date(),
): Promise<Conversion> {
  const lines = await db
    .select({
      materialId: schema.mixDesignLines.materialId,
      kg: schema.mixDesignLines.quantityKgM3,
      category: schema.materials.category,
    })
    .from(schema.mixDesignLines)
    .innerJoin(schema.materials, eq(schema.materials.id, schema.mixDesignLines.materialId))
    .where(eq(schema.mixDesignLines.designId, d.id));
  const ids = lines.map((l) => l.materialId);
  const tests = ids.length
    ? await db
        .select()
        .from(schema.materialTests)
        .where(
          and(
            eq(schema.materialTests.tenantId, tenantId),
            inArray(schema.materialTests.materialId, ids),
            eq(schema.materialTests.isCurrent, true),
          ),
        )
    : [];
  const prop = (id: string, k: string) => {
    const v = (
      tests.find((t) => t.materialId === id)?.properties as Record<string, unknown> | undefined
    )?.[k];
    return typeof v === 'number' ? v : null;
  };
  const design: BatchDesignLine[] = lines.map((l) => ({
    materialId: l.materialId,
    category: l.category,
    kgSsd: Number(l.kg),
    ...(l.category === 'admixture' ? { solidsPct: prop(l.materialId, 'solids_pct') } : {}),
  }));
  const aggIds = new Set(lines.filter((l) => l.category.endsWith('_agg')).map((l) => l.materialId));
  for (const m of body.moisture)
    if (!aggIds.has(m.materialId))
      throw new ApiError(
        400,
        'bad_request',
        'A moisture reading is for a material that is not an aggregate of this design',
      );
  const moisture: MoistureInput[] = body.moisture.map((m) => ({
    materialId: m.materialId,
    category: lines.find((l) => l.materialId === m.materialId)!.category as
      'fine_agg' | 'coarse_agg',
    totalMoisturePct: m.totalMoisturePct,
    absorptionPct: prop(m.materialId, 'absorption_pct'),
    measuredAt: m.measuredAt ?? now.toISOString(),
    source: m.source ?? 'batching_desk',
  }));
  const rules = await loadCurrentRecords(db, tenantId);
  const settings = await loadSettings(db, tenantId);
  const config: BatchConfig = {
    admixtureSolutionWater: settings.admixtureSolutionWater,
    maxTotalMoisturePct: ruleNumber(rules, 'eng.moisture.max_total_pct'),
    staleHours: ruleNumber(rules, 'eng.moisture.stale_hours'),
    now: now.toISOString(),
  };
  const result = toBatchWeights(design, moisture, config);
  return {
    design,
    moisture,
    config,
    result,
    validator: validateBatch(design, moisture, config, result),
  };
}

export const planBody = moistureBody.extend({
  /** The batch size in m³. */
  batchSizeM3: z.number().positive().max(100),
});
export type PlanBody = z.infer<typeof planBody>;

/** The equipment parameters from the rules; every one is null until QC enters it. */
export function planConfigFrom(
  rules: { ruleset: string; key: string; value: unknown }[],
  batchSizeM3: number,
): PlanConfig {
  return {
    batchSizeM3,
    resolutionKg: Object.fromEntries(
      PLAN_CATEGORIES.map((c) => [c, ruleNumber(rules, `eng.batch.resolution_kg.${c}`)]),
    ),
    maxRoundingDeviationPct: ruleNumber(rules, 'eng.batch.max_rounding_deviation_pct'),
    maxBatchSizeM3: ruleNumber(rules, 'eng.batch.max_size_m3'),
  };
}

export interface Preparation {
  conversion: Conversion;
  plan: BatchPlan | null;
  planValidator: PlanValidation | null;
  config: PlanConfig | null;
  binding: {
    designVersionHash: string;
    materialTestVersions: Record<string, number | null>;
    calcVersion: Record<string, string>;
  };
}

/** Moisture-corrected weights, then the rounded plan for a batch size, each independently checked. */
export async function prepare(
  db: Executor,
  tenantId: string,
  d: DesignRow,
  body: PlanBody,
  now = new Date(),
): Promise<Preparation> {
  const conversion = await convert(db, tenantId, d, body, now);
  const lines = await designLines(db, d.id);
  const tests = lines.length
    ? await db
        .select({
          materialId: schema.materialTests.materialId,
          version: schema.materialTests.version,
        })
        .from(schema.materialTests)
        .where(
          and(
            eq(schema.materialTests.tenantId, tenantId),
            inArray(
              schema.materialTests.materialId,
              lines.map((l) => l.materialId),
            ),
            eq(schema.materialTests.isCurrent, true),
          ),
        )
    : [];
  const binding = {
    designVersionHash: versionHash(d, lines),
    materialTestVersions: Object.fromEntries(
      lines.map((l) => [
        l.materialId,
        tests.find((t) => t.materialId === l.materialId)?.version ?? null,
      ]),
    ),
    calcVersion: {
      conversion: CONVERSION_VERSION,
      plan: PLAN_VERSION,
      batchValidator: BATCH_VALIDATOR_VERSION,
      planValidator: PLAN_VALIDATOR_VERSION,
    },
  };
  if (!conversion.result.ok)
    return { conversion, plan: null, planValidator: null, config: null, binding };
  const config = planConfigFrom(await loadCurrentRecords(db, tenantId), body.batchSizeM3);
  const plan = planBatch(conversion.result, config);
  return {
    conversion,
    plan,
    planValidator: validatePlan(conversion.result, config, plan),
    config,
    binding,
  };
}
