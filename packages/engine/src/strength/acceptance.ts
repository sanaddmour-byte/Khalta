// Acceptance of strength tests against f'c (ACI 318-19 §26.12.3.1 and its JS counterpart), from rule VALUES passed in
// (never hard-coded here), and the model-based sequence rule. A "test" is the average of one set of specimens.

export interface AcceptanceRules {
  /** Every average of 3 consecutive tests must be at least this ratio of f'c. */
  avg3MinRatio: number | null;
  /** f'c above which the single-test criterion is a ratio instead of a deficit. */
  thresholdMpa: number | null;
  singleMaxDeficitMpa: number | null;
  singleMinRatio: number | null;
  /** True only when every value above came from a verified rule. */
  verified: boolean;
}

export interface AcceptanceBreach {
  kind: 'avg3' | 'single';
  /** The value that failed (MPa) and the limit it had to meet (MPa). */
  valueMpa: number;
  limitMpa: number;
  /** Index (0-based) of the test that completed the window / the single test. */
  at: number;
}
export interface AcceptanceResult {
  /** `unknown`: a needed rule value is not on file, so nothing can be judged. */
  status: 'ok' | 'breach' | 'unknown';
  missing: string[];
  /** The latest running average of 3 (null before 3 tests). */
  latestAvg3Mpa: number | null;
  breaches: AcceptanceBreach[];
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Judge the LATEST tests only: a breach is raised when the most recent window of 3, or the most recent single test,
 * fails. Older failures that later tests have recovered from do not keep an alert alive.
 */
export function judgeAcceptance(
  fcMpa: number,
  tests: number[],
  r: AcceptanceRules,
): AcceptanceResult {
  const missing: string[] = [];
  if (r.avg3MinRatio === null) missing.push('accept.avg3.min_ratio_fc');
  if (r.thresholdMpa === null) missing.push('accept.fc_threshold_mpa');
  const high = r.thresholdMpa !== null && fcMpa > r.thresholdMpa;
  if (r.thresholdMpa !== null && high && r.singleMinRatio === null)
    missing.push('accept.single.min_ratio_fc');
  if (r.thresholdMpa !== null && !high && r.singleMaxDeficitMpa === null)
    missing.push('accept.single.max_deficit_mpa');
  if (missing.length > 0 || tests.length === 0)
    return { status: 'unknown', missing, latestAvg3Mpa: null, breaches: [] };

  const breaches: AcceptanceBreach[] = [];
  const last = tests.length - 1;
  const singleLimit = high
    ? fcMpa * (r.singleMinRatio as number)
    : fcMpa - (r.singleMaxDeficitMpa as number);
  if (tests[last]! < singleLimit - 1e-9)
    breaches.push({ kind: 'single', valueMpa: tests[last]!, limitMpa: singleLimit, at: last });
  let latestAvg3: number | null = null;
  if (tests.length >= 3) {
    latestAvg3 = mean(tests.slice(-3));
    const lim = fcMpa * (r.avg3MinRatio as number);
    if (latestAvg3 < lim - 1e-9)
      breaches.push({ kind: 'avg3', valueMpa: latestAvg3, limitMpa: lim, at: last });
  }
  return {
    status: breaches.length > 0 ? 'breach' : 'ok',
    missing: [],
    latestAvg3Mpa: latestAvg3,
    breaches,
  };
}

/** The sequence rule: the last `n` tests all below the model's lower prediction band. */
export function belowBandSequence(tests: number[], lowerBandMpa: number, n: number): boolean {
  return tests.length >= n && tests.slice(-n).every((t) => t < lowerBandMpa);
}
