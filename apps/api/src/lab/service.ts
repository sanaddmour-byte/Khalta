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
import { toBatchWeights } from '@khalta/engine/production';
import { validateBatch } from '@khalta/validator';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../errors';
import type { DesignRow } from '../evaluation/service';
import { ruleNumber } from '../lifecycle/service';
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
