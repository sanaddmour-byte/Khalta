import { schema, type Executor } from '@khalta/db';
import { eq } from 'drizzle-orm';
import { DEFAULT_SANITY } from '@khalta/engine';
import { z } from 'zod';

// Tenant-level settings (01-domain.md §2.8). Engineering parameters live in rule seeds, not here.
export const settingsSchema = z.strictObject({
  maxPlants: z.number().int().min(1).max(200).default(20),
  salesCanViewCost: z.boolean().default(false),
  minorAdjustmentPolicy: z.enum(['none']).default('none'), // every proportion change needs a trial
  numberFormat: z.enum(['latin', 'arabic-indic']).default('latin'),
  stalePriceDays: z.number().int().positive().nullable().default(null), // null = not configured
  insightMinSavingJodPerM3: z.number().nonnegative().default(0.25),
  insightMinAnnualJod: z.number().nonnegative().default(1000),
  // Evaluation (M2.1). Null = not configured: no near-limit warnings / no safety margin, both stated in reports.
  nearLimitPct: z.number().positive().max(50).nullable().default(null),
  safetyMarginMpa: z.number().min(0).max(20).nullable().default(null),
  yieldTolerance: z.number().positive().max(0.05).default(0.005), // m³ either side of 1.000
  // Warn-only material sanity ranges (07 §2.3); keys are engine sanity keys, never block saving.
  sanityRanges: z
    .record(z.string(), z.strictObject({ min: z.number().optional(), max: z.number().optional() }))
    .default(DEFAULT_SANITY),
  // Optimizer (M3.1). Search and rounding settings; none is a code value or an engineering recommendation.
  optimizer: z
    .strictObject({
      scmStepPct: z.number().positive().max(20).default(5),
      waterOverrideWarnPct: z.number().positive().max(50).default(5),
      maxConfigurations: z.number().int().min(1).max(1000).default(200),
      candidatesTopN: z.number().int().min(1).max(10).default(5),
      targetWeightJodPerUnit: z.number().nonnegative().default(0.05),
      scmSearchCapPct: z.number().positive().max(100).default(40),
      timeBudgetSeconds: z.number().positive().max(60).default(20),
      guardrailGuard: z.number().min(0).max(5).default(0.25),
      minAggregateVolume: z.number().min(0.1).max(0.9).default(0.45),
      sandRatioTolerancePts: z.number().nonnegative().default(0.5),
      wcmTolerance: z.number().nonnegative().default(0.005),
    })
    .default({
      scmStepPct: 5,
      waterOverrideWarnPct: 5,
      maxConfigurations: 200,
      candidatesTopN: 5,
      targetWeightJodPerUnit: 0.05,
      scmSearchCapPct: 40,
      timeBudgetSeconds: 20,
      guardrailGuard: 0.25,
      minAggregateVolume: 0.45,
      sandRatioTolerancePts: 0.5,
      wcmTolerance: 0.005,
    }),
  // When on, designs that rely on user-declared key properties cannot be approved (enforced from M4.1).
  approvalRequiresLabSource: z.boolean().default(false),
});
export type Settings = z.infer<typeof settingsSchema>;
export const settingsPatchSchema = settingsSchema.partial();

export async function loadSettings(db: Executor, tenantId: string): Promise<Settings> {
  const [row] = await db
    .select({ settings: schema.tenantSettings.settings })
    .from(schema.tenantSettings)
    .where(eq(schema.tenantSettings.tenantId, tenantId));
  return settingsSchema.parse(row?.settings ?? {});
}
