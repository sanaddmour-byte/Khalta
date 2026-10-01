import { fineModulus, type GradationPoint } from './gradation';
import type { Properties } from './properties';

export interface DriftItem {
  field: string;
  previous: number;
  current: number;
  delta: number;
  /** Absolute tolerance from QC; null = not configured, so only the raw delta is reported. */
  tolerance: number | null;
  status: 'within' | 'beyond' | 'no_tolerance';
}

/** Scalar properties compared between consecutive tests of the SAME material. */
export const DRIFT_FIELDS = ['sg_ssd', 'sg', 'absorption_pct', 'finer_75um_pct', 'c3a_pct', 'mortar_strength_28d_mpa', 'solids_pct'] as const;

function scalar(props: Properties, field: string, fmSieves?: readonly number[]): number | null {
  if (field === 'fm') {
    const pts = props['sieve_analysis'] as GradationPoint[] | undefined;
    if (!pts) return null;
    const r = fineModulus(pts, fmSieves);
    return r.ok ? r.fm : null;
  }
  const v = props[field];
  return typeof v === 'number' ? v : null;
}

/**
 * Compares two consecutive tests. `tolerances` maps field → absolute tolerance (null when QC has not set one).
 * Only fields present in both tests are compared; nothing is invented for missing data.
 */
export function detectDrift(previous: Properties, current: Properties, tolerances: Record<string, number | null | undefined>, fmSieves?: readonly number[]): DriftItem[] {
  const out: DriftItem[] = [];
  for (const field of [...DRIFT_FIELDS, 'fm']) {
    const a = scalar(previous, field, fmSieves);
    const b = scalar(current, field, fmSieves);
    if (a === null || b === null) continue;
    const delta = Math.round((b - a) * 1e9) / 1e9;
    const tol = tolerances[field] ?? null;
    out.push({ field, previous: a, current: b, delta, tolerance: tol, status: tol === null ? 'no_tolerance' : Math.abs(delta) > tol ? 'beyond' : 'within' });
  }
  return out;
}
