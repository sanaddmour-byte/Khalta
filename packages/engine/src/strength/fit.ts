// Plant strength model (01-domain §3): ln f = a − b·(w/cm) by ordinary least squares, with held-out diagnostics and
// the validity rules. Pure and deterministic (doubles, figures rounded to 6 decimals so a stored model re-fits to the
// same text). The model is a PROPOSAL until a QC manager approves it; nothing here approves or applies anything.

export interface StrengthPoint {
  id: string;
  /** Effective w/cm of the design the result belongs to. */
  wcm: number;
  /** Result at the model's test age (MPa). */
  mpa: number;
  /** `YYYY-MM-DD` */
  castDate: string;
}

export interface FitLimits {
  minResults: number;
  minLevels: number;
  /** Minimum span (max − min) of w/cm. */
  minSpan: number;
  windowMonths: number;
  /** Held-out RMSE must be at most this multiple of s. */
  rmseFactor: number;
  /** No held-out miss may exceed this many s. */
  missS: number;
}
export const DEFAULT_FIT_LIMITS: FitLimits = {
  minResults: 30,
  minLevels: 3,
  minSpan: 0.1,
  windowMonths: 12,
  rmseFactor: 1.5,
  missS: 3,
};

export type ModelReasonCode =
  | 'too_few_results'
  | 'too_few_levels'
  | 'span_too_narrow'
  | 'slope_not_positive'
  | 'no_held_out'
  | 'held_out_rmse'
  | 'held_out_miss'
  | 'degenerate_fit';

export interface HeldOut {
  method: 'leave_one_out' | 'five_fold';
  n: number;
  rmseMpa: number;
  meanErrorMpa: number;
  /** Largest |observed − predicted| (MPa). */
  worstMissMpa: number;
  /** Share of held-out results at or above the prediction minus 1.64 s. */
  coverage: number;
}

export interface FitResult {
  a: number;
  b: number;
  seA: number;
  seB: number;
  n: number;
  /** Distinct w/cm levels (rounded to 0.01). */
  levels: number;
  wcmMin: number;
  wcmMax: number;
  /** Residual standard deviation around the curve, in MPa (n − 2 degrees of freedom). */
  sMpa: number;
  r2: number;
  heldOut: HeldOut | null;
  status: 'valid' | 'provisional';
  reasons: { code: ModelReasonCode; detail: string }[];
}

export const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export interface Curve {
  a: number;
  b: number;
}
export const predictMpa = (m: Curve, wcm: number) => Math.exp(m.a - m.b * wcm);
/** The w/cm at which the curve gives `fcr` (MPa). */
export const wcmForStrength = (m: Curve, fcr: number) => (m.a - Math.log(fcr)) / m.b;
/** The curve's strength at the w/cm, minus k standard deviations. */
export const lowerBandMpa = (m: Curve, wcm: number, sMpa: number, k = 1.64) =>
  predictMpa(m, wcm) - k * sMpa;

interface Ols {
  a: number;
  b: number;
  sxx: number;
  n: number;
  xbar: number;
}
function ols(xs: number[], ys: number[]): Ols | null {
  const n = xs.length;
  if (n < 2) return null;
  const xbar = xs.reduce((s, x) => s + x, 0) / n;
  const ybar = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - xbar) ** 2;
    sxy += (xs[i]! - xbar) * (ys[i]! - ybar);
  }
  if (sxx < 1e-12) return null;
  const slope = sxy / sxx;
  return { a: ybar - slope * xbar, b: -slope, sxx, n, xbar };
}

function heldOut(points: StrengthPoint[], sMpa: number): HeldOut | null {
  const n = points.length;
  if (n < 5) return null;
  const ordered = [...points].sort((p, q) => p.id.localeCompare(q.id));
  const folds = n <= 200 ? n : 5;
  const errors: number[] = [];
  let covered = 0;
  for (let f = 0; f < folds; f++) {
    const test = ordered.filter((_, i) => i % folds === f);
    const train = ordered.filter((_, i) => i % folds !== f);
    const m = ols(
      train.map((p) => p.wcm),
      train.map((p) => Math.log(p.mpa)),
    );
    if (!m) return null;
    for (const p of test) {
      const pred = predictMpa(m, p.wcm);
      errors.push(p.mpa - pred);
      if (p.mpa >= pred - 1.64 * sMpa) covered++;
    }
  }
  const rmse = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length);
  return {
    method: folds === n ? 'leave_one_out' : 'five_fold',
    n: errors.length,
    rmseMpa: round6(rmse),
    meanErrorMpa: round6(errors.reduce((s, e) => s + e, 0) / errors.length),
    worstMissMpa: round6(Math.max(...errors.map(Math.abs))),
    coverage: round6(covered / errors.length),
  };
}

/** Fit and judge. `points` must already be one group at one test age and inside the time window. */
export function fitModel(
  points: StrengthPoint[],
  limits: FitLimits = DEFAULT_FIT_LIMITS,
): FitResult | null {
  const usable = points.filter((p) => p.mpa > 0 && p.wcm > 0 && Number.isFinite(p.mpa + p.wcm));
  const fit = ols(
    usable.map((p) => p.wcm),
    usable.map((p) => Math.log(p.mpa)),
  );
  if (!fit || usable.length < 3) return null;
  const n = usable.length;
  const resid = usable.map((p) => p.mpa - predictMpa(fit, p.wcm));
  const sMpa = n > 2 ? Math.sqrt(resid.reduce((s, e) => s + e * e, 0) / (n - 2)) : 0;
  // standard errors on the log scale
  const lres = usable.map((p) => Math.log(p.mpa) - (fit.a - fit.b * p.wcm));
  const s2 = n > 2 ? lres.reduce((s, e) => s + e * e, 0) / (n - 2) : 0;
  const seB = Math.sqrt(s2 / fit.sxx);
  const seA = Math.sqrt(s2 * (1 / n + fit.xbar ** 2 / fit.sxx));
  const ybar = usable.reduce((s, p) => s + Math.log(p.mpa), 0) / n;
  const sst = usable.reduce((s, p) => s + (Math.log(p.mpa) - ybar) ** 2, 0);
  const r2 = sst > 0 ? 1 - lres.reduce((s, e) => s + e * e, 0) / sst : 0;
  const levels = new Set(usable.map((p) => p.wcm.toFixed(2))).size;
  const wcms = usable.map((p) => p.wcm);
  const wcmMin = Math.min(...wcms);
  const wcmMax = Math.max(...wcms);
  const ho = heldOut(usable, sMpa);

  const reasons: FitResult['reasons'] = [];
  if (n < limits.minResults)
    reasons.push({ code: 'too_few_results', detail: `${n} results, ${limits.minResults} needed` });
  if (levels < limits.minLevels)
    reasons.push({
      code: 'too_few_levels',
      detail: `${levels} distinct w/cm levels, ${limits.minLevels} needed`,
    });
  if (wcmMax - wcmMin < limits.minSpan - 1e-9)
    reasons.push({
      code: 'span_too_narrow',
      detail: `w/cm spans ${(wcmMax - wcmMin).toFixed(3)}, ${limits.minSpan} needed`,
    });
  if (!(fit.b > 0))
    reasons.push({ code: 'slope_not_positive', detail: 'strength does not fall as w/cm rises' });
  if (!ho) reasons.push({ code: 'no_held_out', detail: 'too few results to hold any out' });
  else {
    if (ho.rmseMpa > limits.rmseFactor * sMpa + 1e-9)
      reasons.push({
        code: 'held_out_rmse',
        detail: `held-out RMSE ${ho.rmseMpa} MPa exceeds ${limits.rmseFactor} × s (${round6(sMpa)})`,
      });
    if (ho.worstMissMpa > limits.missS * sMpa + 1e-9)
      reasons.push({
        code: 'held_out_miss',
        detail: `a held-out result misses by ${ho.worstMissMpa} MPa, beyond ${limits.missS} × s`,
      });
  }
  return {
    a: round6(fit.a),
    b: round6(fit.b),
    seA: round6(seA),
    seB: round6(seB),
    n,
    levels,
    wcmMin: round6(wcmMin),
    wcmMax: round6(wcmMax),
    sMpa: round6(sMpa),
    r2: round6(r2),
    heldOut: ho,
    status: reasons.length === 0 ? 'valid' : 'provisional',
    reasons,
  };
}

/** `YYYY-MM-DD` cutoff `months` before `today`. */
export function windowStart(today: string, months: number): string {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const t = y * 12 + (m - 1) - months;
  const yy = Math.floor(t / 12);
  const mm = (t % 12) + 1;
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
