// Proposals only (never written by code): a refit of the production standard deviation s, and a calibration of the
// water-demand adjustments β_FM and β_75 from trial batches. A QC manager decides on the Rules screen.

export interface SProposal {
  n: number;
  sMpa: number | null;
  meanMpa: number | null;
  /** n ≥ 30: the sample the codes accept for s without a modification factor. */
  enoughForCode: boolean;
  /** Greater than the approved model's s. */
  higherThanModel: boolean;
}

export function sRefit(testMeans: number[], modelS: number | null, minN = 30): SProposal {
  const n = testMeans.length;
  if (n < 2) return { n, sMpa: null, meanMpa: null, enoughForCode: false, higherThanModel: false };
  const mean = testMeans.reduce((a, b) => a + b, 0) / n;
  const s = Math.sqrt(testMeans.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const r = (x: number) => Math.round(x * 1e6) / 1e6;
  return {
    n,
    sMpa: r(s),
    meanMpa: r(mean),
    enoughForCode: n >= minN,
    higherThanModel: modelS !== null && s > modelS + 1e-9,
  };
}

export interface BetaRow {
  id: string;
  /** Free water of the trial design (kg/m³). */
  waterKgM3: number;
  slumpMm: number;
  fm: number;
  /** % of the combined aggregate passing 75 µm. */
  p75: number;
}
export interface BetaProposal {
  ok: boolean;
  n: number;
  /** What is missing when `ok` is false. */
  missing: {
    code: 'too_few_batches' | 'no_fm_variation' | 'no_p75_variation' | 'singular';
    detail: string;
  }[];
  betaFm: number | null;
  betaP75: number | null;
  seBetaFm: number | null;
  seBetaP75: number | null;
  slumpCoefficient: number | null;
  rowsUsed: string[];
}

/** Solve A·x = b (Gaussian elimination, partial pivoting); null when singular. Also returns A⁻¹ diagonal. */
function invert(a: number[][]): number[][] | null {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    if (Math.abs(m[p]![c]!) < 1e-12) return null;
    [m[c], m[p]] = [m[p]!, m[c]!];
    const d = m[c]![c]!;
    for (let j = 0; j < 2 * n; j++) m[c]![j]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]!;
      for (let j = 0; j < 2 * n; j++) m[r]![j]! -= f * m[c]![j]!;
    }
  }
  return m.map((row) => row.slice(n));
}

const range = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

/**
 * W = c + g_FM·FM + g_75·P75 + g_s·slump by least squares; β_FM = −g_FM (more fines in the blend, less water) and
 * β_75 = g_75. Needs `minBatches` and variation in FM (≥ 0.15) and P75 (≥ 0.5 points), else it says what is missing.
 */
export function betaProposal(rows: BetaRow[], minBatches = 12): BetaProposal {
  const none = (missing: BetaProposal['missing']): BetaProposal => ({
    ok: false,
    n: rows.length,
    missing,
    betaFm: null,
    betaP75: null,
    seBetaFm: null,
    seBetaP75: null,
    slumpCoefficient: null,
    rowsUsed: [],
  });
  const missing: BetaProposal['missing'] = [];
  if (rows.length < minBatches)
    missing.push({
      code: 'too_few_batches',
      detail: `${rows.length} batches, ${minBatches} needed`,
    });
  if (rows.length >= 2 && range(rows.map((r) => r.fm)) < 0.15)
    missing.push({ code: 'no_fm_variation', detail: 'the combined FM varies by less than 0.15' });
  if (rows.length >= 2 && range(rows.map((r) => r.p75)) < 0.5)
    missing.push({
      code: 'no_p75_variation',
      detail: 'the 75 µm content varies by less than 0.5 points',
    });
  if (missing.length > 0) return none(missing);
  const X = rows.map((r) => [1, r.fm, r.p75, r.slumpMm]);
  const y = rows.map((r) => r.waterKgM3);
  const k = 4;
  const xtx = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => X.reduce((s, row) => s + row[i]! * row[j]!, 0)),
  );
  const inv = invert(xtx);
  if (!inv) return none([{ code: 'singular', detail: 'the batches do not separate the effects' }]);
  const xty = Array.from({ length: k }, (_, i) => X.reduce((s, row, r) => s + row[i]! * y[r]!, 0));
  const beta = inv.map((row) => row.reduce((s, v, j) => s + v * xty[j]!, 0));
  const rss = X.reduce(
    (s, row, r) => s + (y[r]! - row.reduce((t, v, j) => t + v * beta[j]!, 0)) ** 2,
    0,
  );
  const s2 = rows.length > k ? rss / (rows.length - k) : 0;
  const se = (i: number) => Math.sqrt(s2 * inv[i]![i]!);
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  return {
    ok: true,
    n: rows.length,
    missing: [],
    betaFm: r6(-beta[1]!),
    betaP75: r6(beta[2]!),
    seBetaFm: r6(se(1)),
    seBetaP75: r6(se(2)),
    slumpCoefficient: r6(beta[3]!),
    rowsUsed: rows.map((r) => r.id),
  };
}

type Gradation = { sieve_mm: number; passing_pct: number }[];
/** % passing 75 µm: the entered point, or forced by the data (a coarser-or-equal sieve at 100 %, a finer at 0 %). */
function passing75(points: Gradation): number | null {
  const exact = points.find((p) => p.sieve_mm === 0.075);
  if (exact) return exact.passing_pct;
  if (points.some((p) => p.sieve_mm < 0.075 && p.passing_pct === 100)) return 100;
  if (points.some((p) => p.sieve_mm > 0.075 && p.passing_pct === 0)) return 0;
  return null;
}

/** Mass-weighted % passing 75 µm of the combined aggregate from each line's sieve analysis; null if any is missing. */
export function combinedP75(lines: { kg: number; sieve: Gradation | undefined }[]): number | null {
  const total = lines.reduce((s, l) => s + l.kg, 0);
  if (lines.length === 0 || total <= 0) return null;
  let acc = 0;
  for (const l of lines) {
    const p = l.sieve ? passing75(l.sieve) : null;
    if (p === null) return null;
    acc += l.kg * p;
  }
  return acc / total;
}
