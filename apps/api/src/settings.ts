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
  // Warn-only material sanity ranges (07 §2.3); keys are engine sanity keys, never block saving.
  sanityRanges: z
    .record(z.string(), z.strictObject({ min: z.number().optional(), max: z.number().optional() }))
    .default(DEFAULT_SANITY),
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
