import type { Category, Properties } from './properties';
import { isAggregate } from './properties';

export interface SanityRange {
  min?: number;
  max?: number;
}
/** Warn-only ranges (tenant settings). Keys are property names; only configured properties are checked. */
export type SanityRanges = Record<string, SanityRange>;

export interface SanityWarning {
  field: string;
  value: number;
  range: SanityRange;
}

export const DEFAULT_SANITY: SanityRanges = {
  aggregate_sg_ssd: { min: 2.3, max: 3.1 },
  aggregate_absorption_pct: { min: 0, max: 6 },
};

/** Soft checks that never block saving (07 §2.3). */
export function sanityWarnings(
  category: Category,
  props: Properties,
  ranges: SanityRanges,
): SanityWarning[] {
  const out: SanityWarning[] = [];
  const check = (field: string, key: string) => {
    const v = props[field];
    const r = ranges[key];
    if (typeof v !== 'number' || !r) return;
    if ((r.min !== undefined && v < r.min) || (r.max !== undefined && v > r.max))
      out.push({ field, value: v, range: r });
  };
  if (isAggregate(category)) {
    check('sg_ssd', 'aggregate_sg_ssd');
    check('absorption_pct', 'aggregate_absorption_pct');
  }
  return out;
}
