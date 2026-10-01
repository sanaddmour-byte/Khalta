import { z } from 'zod';
import { CATEGORIES, PROPERTY_SCHEMAS, type Category } from './properties';

/** A what-if material defined inside one request (07 §2.4). It can be promoted into the library. */
export const adHocMaterialSchema = z
  .strictObject({
    category: z.enum(CATEGORIES),
    market_name_ar: z.string().trim().max(120).optional(),
    market_name_en: z.string().trim().min(1).max(120),
    technical_name: z.string().trim().max(120).optional(),
    source: z.string().trim().max(120).optional(),
    properties: z.record(z.string(), z.unknown()),
    /** JOD per kg as a decimal string (no floats for money); theoretical until promoted and priced. */
    price_jod_per_kg: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/).optional(),
  })
  .superRefine((m, ctx) => {
    const r = PROPERTY_SCHEMAS[m.category as Category].safeParse(m.properties);
    if (!r.success) for (const i of r.error.issues) ctx.addIssue({ code: 'custom', path: ['properties', ...i.path], message: i.message });
  });
export type AdHocMaterial = z.infer<typeof adHocMaterialSchema>;
