// Engineering parameters the optimizer needs, read from the snapshot's rules. A parameter that is not on file
// BLOCKS the request and is named; nothing is defaulted silently (CLAUDE.md: no silent assumptions).
import { DEFAULT_FM_SIEVES } from '../materials/sieves';
import { isNum, type RuleIndex } from '../evaluate/util';
import type { Band, Guardrails, OptimizerBlocker } from './types';

type Limit = { sieve_mm: number; min_pct: number; max_pct: number };

const isLimits = (v: unknown): v is Limit[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every(
    (x) =>
      x !== null &&
      typeof x === 'object' &&
      isNum((x as Limit).sieve_mm) &&
      isNum((x as Limit).min_pct) &&
      isNum((x as Limit).max_pct),
  );

/** A value that is one number, or a table keyed by NMAS (mm) -> number; returns the number for `nmas`. */
export function byNmas(v: unknown, nmas: number): number | null {
  if (isNum(v)) return v;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const x = (v as Record<string, unknown>)[String(nmas)];
    return isNum(x) ? x : null;
  }
  return null;
}

export interface GuardrailParams {
  /** Per-NMAS values (Shilstone WF bounds may vary by NMAS) are resolved with `forNmas`. */
  forNmas(nmas: number): { wf: Band } | { blocker: OptimizerBlocker };
  base: Guardrails;
}

/**
 * Reads the guardrail parameters. Returns the parameters and the list of blockers (every missing value, not
 * just the first, so the user sees the whole list at once).
 */
export function readGuardrails(
  rules: RuleIndex,
  opts: { needPumpable: boolean; codes: readonly string[] },
): { params: GuardrailParams | null; blockers: OptimizerBlocker[] } {
  const blockers: OptimizerBlocker[] = [];
  const num = (set: 'ENGINEERING', key: string, what: string): number => {
    const v = rules.number(set, key);
    if (v === null)
      blockers.push({
        code: 'parameter_missing',
        subject: key,
        detail: `${what} is not on file (${key}); the optimizer cannot run without it`,
      });
    return v ?? 0;
  };
  const gradingExponent = num(
    'ENGINEERING',
    'eng.grading.target.exponent',
    'Grading target exponent',
  );
  const gradingBandPct = num('ENGINEERING', 'eng.grading.target.band_pct', 'Grading band');
  const gradingMarginPts = num('ENGINEERING', 'eng.margin.grading_pct_points', 'Grading margin');
  const cfMin = num('ENGINEERING', 'eng.shilstone.cf.min', 'Coarseness factor minimum');
  const cfMax = num('ENGINEERING', 'eng.shilstone.cf.max', 'Coarseness factor maximum');
  const wfAdjustPoints = num(
    'ENGINEERING',
    'eng.shilstone.wf.binder_adjust.points',
    'WF binder adjustment',
  );
  const wfAdjustPerKg = num(
    'ENGINEERING',
    'eng.shilstone.wf.binder_adjust.per_kg',
    'WF binder step',
  );
  const wfAdjustAboveKg = num(
    'ENGINEERING',
    'eng.shilstone.wf.binder_adjust.above_kg',
    'WF binder threshold',
  );
  const finesMaxPct = num('ENGINEERING', 'eng.fines.max_pct_75um', 'Fines (75 µm) cap');
  const wcmMargin = num('ENGINEERING', 'eng.margin.wcm', 'w/cm robustness margin');
  const caVolumeSanityBandPct = rules.number('ENGINEERING', 'eng.ca_volume.sanity_band_pct') ?? 10;
  let pumpableMin03Pct: number | null = null;
  if (opts.needPumpable) {
    pumpableMin03Pct = rules.number('ENGINEERING', 'eng.pumpable.min_passing_0_3mm_pct');
    if (pumpableMin03Pct === null)
      blockers.push({
        code: 'parameter_missing',
        subject: 'eng.pumpable.min_passing_0_3mm_pct',
        detail:
          'Pumpable minimum passing 0.3 mm is not on file; a pumpable request cannot be optimized without it',
      });
  }
  const sieves = rules.value('ENGINEERING', 'eng.fm.sieves', false);
  const fmSieves =
    Array.isArray(sieves) && sieves.every(isNum) ? (sieves as number[]) : [...DEFAULT_FM_SIEVES];

  // Individual aggregate acceptance: every selected code must have its limits; the tightest applies.
  const merge = (key: string, label: string): Limit[] | null => {
    let out: Limit[] | null = null;
    for (const code of opts.codes) {
      const v = rules.value(code, key);
      if (!isLimits(v)) {
        blockers.push({
          code: 'rule_not_on_file',
          subject: `${code}:${key}`,
          detail: `${label} (${code}) are not on file; enter them from the licensed standard`,
        });
        continue;
      }
      if (out === null) out = v.map((x) => ({ ...x }));
      else
        for (const x of v) {
          const hit = out.find((y) => y.sieve_mm === x.sieve_mm);
          if (hit) {
            hit.min_pct = Math.max(hit.min_pct, x.min_pct);
            hit.max_pct = Math.min(hit.max_pct, x.max_pct);
          } else out.push({ ...x });
        }
    }
    return out;
  };
  const fine = merge('grading.fine.limits', 'Fine aggregate grading limits');
  const coarse = merge('grading.coarse.limits', 'Coarse aggregate grading limits');
  const wfMin = rules.value('ENGINEERING', 'eng.shilstone.wf.min');
  const wfMax = rules.value('ENGINEERING', 'eng.shilstone.wf.max');
  if (blockers.length > 0) return { params: null, blockers };
  return {
    blockers,
    params: {
      base: {
        gradingExponent,
        gradingBandPct,
        gradingMarginPts,
        cfMin,
        cfMax,
        wfAdjustPoints,
        wfAdjustPerKg,
        wfAdjustAboveKg,
        finesMaxPct,
        pumpableMin03Pct,
        fmSieves,
        caVolumeSanityBandPct,
        wcmMargin,
        fineLimits: fine as Limit[],
        coarseLimits: coarse as Limit[],
      },
      forNmas(nmas) {
        const lo = byNmas(wfMin, nmas);
        const hi = byNmas(wfMax, nmas);
        if (lo === null || hi === null)
          return {
            blocker: {
              code: 'parameter_missing',
              subject: lo === null ? 'eng.shilstone.wf.min' : 'eng.shilstone.wf.max',
              detail: `Shilstone workability factor ${lo === null ? 'minimum' : 'maximum'} is not on file for NMAS ${nmas} mm`,
            },
          };
        return { wf: { min: lo, max: hi } };
      },
    },
  };
}
