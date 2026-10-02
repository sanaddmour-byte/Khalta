// Pure measurements of a concrete set of proportions against the engineering guardrails. Used for the final
// check of every candidate after rounding (the optimizer's LP uses the same formulas in linear form).
import { fineModulus, type GradationPoint } from '../materials/gradation';
import { passingAt } from '../evaluate/blend';
import { US_SIEVES } from '../materials/sieves';
import type { Band, CandidateGuardrails, Guardrails, OptimizerBlocker } from './types';

export interface AggMass {
  id: string;
  name: string;
  kind: 'fine' | 'coarse';
  kg: number;
  points: GradationPoint[];
  finer75Pct: number | null;
}

const ASTM = Object.values(US_SIEVES).sort((x, y) => x - y);

/** Maximum aggregate size: the smallest ASTM E11 sieve strictly above the NMAS. */
export function dmaxFor(nmas: number): number {
  return ASTM.find((s) => s > nmas) ?? nmas;
}

/** 0.45-power target % passing at a sieve for a maximum size. */
export const targetPassing = (sieve: number, dmax: number, exponent: number) =>
  100 * Math.pow(sieve / dmax, exponent);

/** The sieves on which the combined grading is compared with the target curve: ASTM sieves from 0.15 mm up to (not including) the maximum size. */
export const gradingSieves = (dmax: number) => ASTM.filter((s) => s >= 0.15 && s < dmax);

/** Binder-dependent Shilstone workability-factor adjustment (subtractive above the threshold). */
export const wfAdjustment = (
  g: Pick<Guardrails, 'wfAdjustPoints' | 'wfAdjustPerKg' | 'wfAdjustAboveKg'>,
  binderKg: number,
) => (g.wfAdjustPoints * Math.max(0, binderKg - g.wfAdjustAboveKg)) / g.wfAdjustPerKg;

export function combinedAt(aggs: readonly AggMass[], sieve: number): number | null {
  const total = aggs.reduce((a, x) => a + x.kg, 0);
  if (total <= 0) return null;
  let acc = 0;
  for (const a of aggs) {
    const p = passingAt(a.points, sieve);
    if (p === null) return null;
    acc += a.kg * p;
  }
  return acc / total;
}

/** % passing 75 µm of one aggregate: the gradation when it reaches 0.075 mm, else the tested finer-than-75-µm. */
export function finesOf(a: Pick<AggMass, 'points' | 'finer75Pct'>): number | null {
  const p = passingAt(a.points, 0.075);
  return p ?? a.finer75Pct;
}

export function combinedFines(aggs: readonly AggMass[]): number | null {
  const total = aggs.reduce((a, x) => a + x.kg, 0);
  if (total <= 0) return null;
  let acc = 0;
  for (const a of aggs) {
    const f = finesOf(a);
    if (f === null) return null;
    acc += a.kg * f;
  }
  return acc / total;
}

export function measure(
  aggs: readonly AggMass[],
  binderKg: number,
  nmas: number,
  g: Guardrails,
  wf: Band,
): { ok: true; value: CandidateGuardrails } | { ok: false; blocker: OptimizerBlocker } {
  const dmax = dmaxFor(nmas);
  const sieves = gradingSieves(dmax);
  const rows: CandidateGuardrails['gradingSieves'] = [];
  for (const s of sieves) {
    const p = combinedAt(aggs, s);
    if (p === null)
      return {
        ok: false,
        blocker: {
          code: 'input_missing',
          subject: `sieve ${s}`,
          detail: `an aggregate's sieve analysis does not give % passing at ${s} mm`,
        },
      };
    rows.push({
      sieve_mm: s,
      passing_pct: p,
      target_pct: targetPassing(s, dmax, g.gradingExponent),
      band_pct: g.gradingBandPct,
    });
  }
  const p95 = combinedAt(aggs, 9.5);
  const p236 = combinedAt(aggs, 2.36);
  const p03 = combinedAt(aggs, 0.3);
  const fines = combinedFines(aggs);
  if (p95 === null || p236 === null || fines === null)
    return {
      ok: false,
      blocker: {
        code: 'input_missing',
        subject: 'shilstone sieves',
        detail:
          'the 9.5 mm, 2.36 mm and 75 µm values are needed for the coarseness/workability factors and fines cap',
      },
    };
  const retained236 = 100 - p236;
  const cf = retained236 > 0 ? ((100 - p95) / retained236) * 100 : Number.POSITIVE_INFINITY;
  const adj = wfAdjustment(g, binderKg);
  const pts: GradationPoint[] = [];
  for (const s of g.fmSieves) {
    const p = combinedAt(aggs, s);
    if (p !== null) pts.push({ sieve_mm: s, passing_pct: p });
  }
  const fmr = fineModulus(pts, g.fmSieves);
  return {
    ok: true,
    value: {
      dmaxMm: dmax,
      gradingSieves: rows,
      coarsenessFactor: cf,
      workabilityFactor: p236,
      workabilityFactorAdjusted: p236 - adj,
      finesPct: fines,
      passing03Pct: p03,
      fmCombined: fmr.ok ? fmr.fm : Number.NaN,
      limits: {
        cf: { min: g.cfMin, max: g.cfMax },
        wf,
        finesMax: g.finesMaxPct,
        pumpableMin: g.pumpableMin03Pct,
      },
    },
  };
}
