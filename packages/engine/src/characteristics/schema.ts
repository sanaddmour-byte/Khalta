// Mix characteristics (07 §1.2, Appendix E). One Zod schema is the single source for the API, the form
// and the engine. Keys come only from the §1.2 table; anything else is rejected.
import { z } from 'zod';

const num = z.number().finite();
const nonNeg = num.min(0);

export type CharMode = 'auto' | 'fixed' | 'range' | 'target';

/** Builds the union of mode shapes a characteristic supports; `extra` adds fields to every shape. */
function spec<const M extends readonly CharMode[]>(
  modes: M,
  opts: { value?: z.ZodType<number>; extra?: z.ZodRawShape } = {},
) {
  const value = opts.value ?? num;
  const extra = opts.extra ?? {};
  const shapes: z.ZodType[] = [];
  if (modes.includes('auto')) shapes.push(z.strictObject({ mode: z.literal('auto'), ...extra }));
  if (modes.includes('fixed'))
    shapes.push(z.strictObject({ mode: z.literal('fixed'), value, ...extra }));
  if (modes.includes('range'))
    shapes.push(
      z
        .strictObject({
          mode: z.literal('range'),
          min: value.optional(),
          max: value.optional(),
          ...extra,
        })
        .refine((r) => r['min'] !== undefined || r['max'] !== undefined, {
          message: 'a range needs min, max or both',
        })
        .refine(
          (r) =>
            r['min'] === undefined ||
            r['max'] === undefined ||
            (r['min'] as number) <= (r['max'] as number),
          { message: 'min is above max' },
        ),
    );
  if (modes.includes('target'))
    shapes.push(
      z.strictObject({
        mode: z.literal('target'),
        value,
        weight_jod_per_unit: nonNeg.optional(),
        ...extra,
      }),
    );
  return shapes.length === 1
    ? shapes[0]!
    : z.union(shapes as [z.ZodType, z.ZodType, ...z.ZodType[]]);
}

const pct = num.min(0).max(100);

const scmSpec = z.union([
  z.strictObject({ mode: z.literal('auto') }),
  z.strictObject({ mode: z.literal('fixed'), product: z.string().min(1), pct }),
  z
    .strictObject({
      mode: z.literal('range'),
      product: z.string().min(1),
      min: pct.optional(),
      max: pct.optional(),
    })
    .refine((r) => r.min !== undefined || r.max !== undefined, {
      message: 'a range needs min, max or both',
    }),
]);

const admixtureSpec = z.union([
  z.strictObject({ mode: z.literal('auto') }),
  z.strictObject({
    mode: z.literal('fixed'),
    product: z.string().min(1),
    dosage_level: z.number().int().min(1).optional(),
    dosage_pct: nonNeg.optional(),
  }),
  z
    .strictObject({
      mode: z.literal('range'),
      product: z.string().min(1),
      min: nonNeg.optional(),
      max: nonNeg.optional(),
    })
    .refine((r) => r.min !== undefined || r.max !== undefined, {
      message: 'a range needs min, max or both',
    }),
]);

const record = <T extends z.ZodType>(s: T) => z.record(z.string().min(1), s);

export const characteristicsSchema = z.strictObject({
  wcm: spec(['auto', 'fixed', 'range']).optional(),
  binder_kg: spec(['auto', 'fixed', 'range', 'target']).optional(),
  cement_kg: spec(['auto', 'fixed', 'range', 'target']).optional(),
  scm: scmSpec.optional(),
  water_kg: spec(['auto', 'fixed', 'range', 'target']).optional(),
  air_pct: spec(['auto', 'fixed', 'range']).optional(),
  admixture: admixtureSpec.optional(),
  sand_ratio_pct: spec(['auto', 'fixed', 'range', 'target'], {
    extra: { basis: z.enum(['mass', 'volume']).optional() },
  }).optional(),
  agg_share_pct: record(spec(['auto', 'fixed', 'range', 'target'])).optional(),
  agg_kg: record(spec(['auto', 'fixed', 'range'])).optional(),
  paste_l: spec(['auto', 'range', 'target']).optional(),
  fm_combined: spec(['auto', 'range', 'target']).optional(),
  passing_pct: record(spec(['auto', 'range'])).optional(),
  'shilstone.cf': spec(['auto', 'range']).optional(),
  'shilstone.wf': spec(['auto', 'range']).optional(),
  fines_max_pct: spec(['auto', 'range']).optional(),
  fresh_density_kg_m3: spec(['auto', 'range', 'target']).optional(),
  slump_mm: spec(['auto', 'fixed']).optional(),
  nmas_mm: z
    .union([
      z.strictObject({ mode: z.literal('auto') }),
      z.strictObject({ mode: z.literal('fixed'), value: num.positive() }),
      z.strictObject({ mode: z.literal('list'), values: z.array(num.positive()).min(1) }),
    ])
    .optional(),
  extra_margin_mpa: spec(['auto', 'fixed'], { value: nonNeg }).optional(),
  fcr_mpa: spec(['auto', 'fixed'], { value: num.positive() }).optional(),
  max_cost_jod_m3: spec(['auto', 'range']).optional(),
});
export type Characteristics = z.output<typeof characteristicsSchema>;
export type CharacteristicKey = keyof Characteristics;

export const CHARACTERISTIC_KEYS = Object.keys(characteristicsSchema.shape) as CharacteristicKey[];

/** Keys whose value is a map keyed by material id or sieve size. */
export const KEYED_KEYS = ['agg_share_pct', 'agg_kg', 'passing_pct'] as const;

export const characteristicsInputSchema = z.strictObject({
  objective: z.enum(['cheapest', 'closest_to_targets']).optional(),
  characteristics: characteristicsSchema.default({}),
  materials: z
    .strictObject({
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
      prefer: z.array(z.string()).optional(),
    })
    .optional(),
  origin: z
    .strictObject({
      profiles: z.array(z.string()).optional(),
      request_overrides: z.array(z.string()).optional(),
    })
    .optional(),
});
export type CharacteristicsInput = z.output<typeof characteristicsInputSchema>;

export type SpecObject = {
  mode: CharMode | 'list';
  value?: number;
  min?: number;
  max?: number;
  [k: string]: unknown;
};
