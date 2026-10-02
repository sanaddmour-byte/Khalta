// Independent validation of an optimizer CANDIDATE (safety contract: solver output is not an approved mix).
// Beyond re-running the evaluation check (`validateEvaluation`), it re-derives with its own arithmetic every
// property the optimizer promised that the evaluator does not judge: material availability, the rounding
// grid, the combined-grading band, Shilstone CF/WF, the fines cap, pumpability, the characteristics the
// evaluator cannot read, the cost figure and the evidence labels. It imports no optimizer code.
import { effectiveValue, type RuleRecord } from '@khalta/rules';
import type {
  CandidateMismatch,
  CandidateRecord,
  CandidateValidatorResult,
  SnapshotMaterial,
} from '@khalta/engine';
import { R, type Rat, ZERO } from './rat';
import { validateEvaluation, VALIDATOR_VERSION } from './index';

const TOL = 1e-6;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** ASTM E11 sieves (mm), ascending. The validator's own copy. */
const SIEVES = [0.075, 0.15, 0.3, 0.6, 1.18, 2.36, 4.75, 9.5, 12.5, 19, 25, 37.5, 50, 75];

interface Point {
  sieve_mm: number;
  passing_pct: number;
}

/** % passing at a sieve: entered, or forced by the data (a finer 100 % or a coarser 0 %). */
function passAt(points: Point[] | undefined, s: number): Rat | null {
  if (!points) return null;
  const exact = points.find((p) => p.sieve_mm === s);
  if (exact) return R(exact.passing_pct);
  if (points.some((p) => p.sieve_mm < s && p.passing_pct === 100)) return R(100);
  if (points.some((p) => p.sieve_mm > s && p.passing_pct === 0)) return R(0);
  return null;
}

/** A `range` rule is an object keyed by sieve (mm): `{ "4.75": { min, max } }`. */
function limitsOf(v: unknown): { sieve_mm: number; min_pct: number; max_pct: number }[] | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: { sieve_mm: number; min_pct: number; max_pct: number }[] = [];
  for (const [k, x] of Object.entries(v)) {
    const { min, max } = (x ?? {}) as { min?: unknown; max?: unknown };
    if (!num(Number(k)) || (!num(min) && !num(max))) return null;
    out.push({ sieve_mm: Number(k), min_pct: num(min) ? min : 0, max_pct: num(max) ? max : 100 });
  }
  return out.length ? out : null;
}

export function validateCandidate(rec: CandidateRecord): CandidateValidatorResult {
  const out: CandidateMismatch[] = [];
  const add = (m: CandidateMismatch) => out.push(m);
  const snap = rec.snapshot;
  const evaluation = validateEvaluation(snap, rec.report);
  const finish = (): CandidateValidatorResult => ({
    validatorVersion: VALIDATOR_VERSION,
    status: out.length === 0 && evaluation.status === 'pass' ? 'pass' : 'fail',
    mismatches: out,
    evaluation,
  });
  if (evaluation.status !== 'pass')
    add({
      key: 'evaluation',
      kind: 'evaluation',
      reported: rec.report.verdict,
      recomputed: evaluation.mismatches.length,
      detail: 'the independent evaluation check disagrees with the report',
    });
  if (rec.report.verdict !== 'pass')
    add({
      key: 'verdict',
      kind: 'evaluation',
      reported: rec.report.verdict,
      recomputed: 'pass',
      detail: 'a candidate must evaluate to pass',
    });

  const byRef = new Map<string, RuleRecord>(snap.rules.map((r) => [`${r.ruleset}:${r.key}`, r]));
  const rv = (rs: string, key: string): unknown => {
    const r = byRef.get(`${rs}:${key}`);
    return r ? effectiveValue(r, byRef) : null;
  };
  const rn = (key: string): number | null => {
    const v = rv('ENGINEERING', key);
    return num(v) ? v : null;
  };
  const mats = new Map<string, SnapshotMaterial>(snap.materials.map((m) => [m.id, m]));
  const lines = snap.lines.map((l) => ({
    id: l.materialId,
    kg: R(l.kgPerM3),
    m: mats.get(l.materialId),
  }));
  const prop = (m: SnapshotMaterial | undefined, f: string): unknown => {
    const v = m?.test?.properties[f];
    return v === undefined || v === null || v === '' ? undefined : v;
  };

  // ---------------------------------------------------------- availability
  const include = rec.materials.include ?? [];
  const exclude = rec.materials.exclude ?? [];
  for (const l of lines) {
    const why: string[] = [];
    if (!l.m) why.push('material record missing');
    else {
      if (!l.m.test) why.push('no test data');
      else if (l.m.test.freshness === 'expired') why.push('test expired');
      if (l.m.price.status !== 'ok') why.push('no usable price');
      if (!['water', 'cement', 'scm', 'admixture', 'fine_agg', 'coarse_agg'].includes(l.m.category))
        why.push(`category ${l.m.category} is not optimized`);
    }
    if (exclude.includes(l.id)) why.push('excluded by the request');
    if (include.length > 0 && !include.includes(l.id)) why.push('not in the include list');
    if (why.length > 0)
      add({
        key: `availability.${l.id}`,
        kind: 'availability',
        reported: 'used',
        recomputed: why.join('; '),
      });
  }
  const cat = (c: string) => lines.filter((l) => l.m?.category === c);
  for (const [c, min] of [
    ['water', 1],
    ['cement', 1],
    ['fine_agg', 1],
    ['coarse_agg', 1],
  ] as const)
    if (cat(c).length < min)
      add({
        key: `composition.${c}`,
        kind: 'configuration',
        reported: cat(c).length,
        recomputed: `at least ${min}`,
      });

  // ---------------------------------------------------------- rounding grid
  const multiple = (x: Rat, step: Rat) => x.div(step).d === 1n;
  for (const l of lines) {
    const c = l.m?.category;
    const step = c === 'admixture' ? R('0.01') : c === 'water' ? R(1) : R(5);
    if (c === 'fine_agg' || c === 'coarse_agg') continue;
    if (!multiple(l.kg, step))
      add({
        key: `rounding.${l.id}`,
        kind: 'rounding',
        reported: l.kg.toNumber(),
        recomputed: `a multiple of ${step.toNumber()}`,
      });
  }
  const aggs = lines.filter((l) => l.m?.category === 'fine_agg' || l.m?.category === 'coarse_agg');
  const offGrid = aggs.filter((l) => !multiple(l.kg, R(5)));
  if (offGrid.length > 1 || offGrid.some((l) => !multiple(l.kg, R(1))))
    add({
      key: 'rounding.aggregates',
      kind: 'rounding',
      reported: offGrid.map((l) => l.id),
      recomputed: 'at most one aggregate off the 5 kg grid, on a 1 kg grid',
    });

  // ---------------------------------------------------------- guardrail parameters (own reader)
  const need = (k: string): number => {
    const v = rn(k);
    if (v === null)
      add({
        key: k,
        kind: 'parameter_missing',
        reported: null,
        recomputed: 'a number',
        detail: `${k} is not on file`,
      });
    return v ?? 0;
  };
  const exponent = need('eng.grading.target.exponent');
  const band = need('eng.grading.target.band_pct');
  const margin = need('eng.margin.grading_pct_points');
  const cfMin = need('eng.shilstone.cf.min');
  const cfMax = need('eng.shilstone.cf.max');
  const wfPts = need('eng.shilstone.wf.binder_adjust.points');
  const wfPer = need('eng.shilstone.wf.binder_adjust.per_kg');
  const wfAbove = need('eng.shilstone.wf.binder_adjust.above_kg');
  const finesMax = need('eng.fines.max_pct_75um');
  const nmas = snap.request.nmasMm;
  const nmasKey = String(nmas);
  const wfBound = (k: string): number | null => {
    const v = rv('ENGINEERING', k);
    if (num(v)) return v;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const x = (v as Record<string, unknown>)[nmasKey];
      return num(x) ? x : null;
    }
    return null;
  };
  const wfMin = wfBound('eng.shilstone.wf.min');
  const wfMax = wfBound('eng.shilstone.wf.max');
  if (wfMin === null || wfMax === null)
    add({
      key: 'eng.shilstone.wf',
      kind: 'parameter_missing',
      reported: null,
      recomputed: 'bounds for this NMAS',
    });
  const pumpMin =
    snap.request.pumpable === true ? need('eng.pumpable.min_passing_0_3mm_pct') : null;
  if (out.some((m) => m.kind === 'parameter_missing') || nmas === null) return finish();

  // ---------------------------------------------------------- combined measurements (exact)
  const pts = (id: string) => prop(mats.get(id), 'sieve_analysis') as Point[] | undefined;
  const total = aggs.reduce((a, l) => a.add(l.kg), ZERO);
  const combined = (s: number): Rat | null => {
    let acc = ZERO;
    for (const l of aggs) {
      const p = passAt(pts(l.id), s);
      if (p === null) return null;
      acc = acc.add(l.kg.mul(p));
    }
    return total.isZero() ? null : acc.div(total);
  };
  const finesOf = (id: string): Rat | null => {
    const p = passAt(pts(id), 0.075);
    if (p !== null) return p;
    const f = prop(mats.get(id), 'finer_75um_pct');
    return num(f) ? R(f) : null;
  };
  const finesCombined = (): Rat | null => {
    let acc = ZERO;
    for (const l of aggs) {
      const f = finesOf(l.id);
      if (f === null) return null;
      acc = acc.add(l.kg.mul(f));
    }
    return total.isZero() ? null : acc.div(total);
  };
  const binder = [...cat('cement'), ...cat('scm')].reduce((a, l) => a.add(l.kg), ZERO);
  const dmax = SIEVES.find((s) => s > nmas) ?? nmas;
  const g = rec.guardrails;
  const cmp = (key: string, reported: number | null, exact: Rat | null) => {
    if (exact === null)
      return add({
        key,
        kind: 'guardrail',
        reported,
        recomputed: null,
        detail: 'cannot be recomputed from the sieve analyses',
      });
    const v = exact.toNumber();
    if (reported === null || Math.abs(reported - v) > TOL)
      add({ key, kind: 'guardrail', reported, recomputed: v });
  };
  if (g.dmaxMm !== dmax)
    add({ key: 'guardrails.dmax', kind: 'guardrail', reported: g.dmaxMm, recomputed: dmax });

  const allowed = band - margin;
  for (const s of SIEVES.filter((x) => x >= 0.15 && x < dmax)) {
    const p = combined(s);
    const t = 100 * Math.pow(s / dmax, exponent);
    const row = g.gradingSieves.find((r) => r.sieve_mm === s);
    if (!row)
      add({
        key: `grading@${s}`,
        kind: 'guardrail',
        reported: null,
        recomputed: p?.toNumber() ?? null,
        detail: 'sieve missing from the report',
      });
    else {
      cmp(`grading@${s}`, row.passing_pct, p);
      if (Math.abs(row.target_pct - t) > TOL)
        add({
          key: `grading.target@${s}`,
          kind: 'guardrail',
          reported: row.target_pct,
          recomputed: t,
        });
    }
    if (p !== null && Math.abs(p.toNumber() - t) > allowed + TOL)
      add({
        key: `grading@${s}`,
        kind: 'guardrail',
        reported: p.toNumber(),
        recomputed: `${t.toFixed(3)} ± ${allowed}`,
        detail: 'the combined grading is outside the band',
      });
  }
  const p95 = combined(9.5);
  const p236 = combined(2.36);
  const p03 = combined(0.3);
  const fines = finesCombined();
  if (p95 && p236) {
    const ret = R(100).sub(p236);
    const cf = ret.isZero() ? null : R(100).sub(p95).div(ret).mul(R(100));
    cmp('guardrails.cf', g.coarsenessFactor, cf);
    if (cf && (cf.toNumber() < cfMin - TOL || cf.toNumber() > cfMax + TOL))
      add({
        key: 'cf',
        kind: 'guardrail',
        reported: cf.toNumber(),
        recomputed: `${cfMin}–${cfMax}`,
        detail: 'coarseness factor is outside its band',
      });
    const over = binder.sub(R(wfAbove));
    const adj = over.gt(ZERO) ? R(wfPts).mul(over).div(R(wfPer)) : ZERO;
    const wfAdj = p236.sub(adj);
    cmp('guardrails.wf', g.workabilityFactor, p236);
    cmp('guardrails.wf_adjusted', g.workabilityFactorAdjusted, wfAdj);
    if (
      wfMin !== null &&
      wfMax !== null &&
      (wfAdj.toNumber() < wfMin - TOL || wfAdj.toNumber() > wfMax + TOL)
    )
      add({
        key: 'wf',
        kind: 'guardrail',
        reported: wfAdj.toNumber(),
        recomputed: `${wfMin}–${wfMax}`,
        detail: 'workability factor is outside its band',
      });
  } else
    add({
      key: 'guardrails.shilstone',
      kind: 'guardrail',
      reported: null,
      recomputed: null,
      detail: 'sieve data are missing',
    });
  cmp('guardrails.fines', g.finesPct, fines);
  if (fines && fines.toNumber() > finesMax + TOL)
    add({
      key: 'fines',
      kind: 'guardrail',
      reported: fines.toNumber(),
      recomputed: finesMax,
      detail: 'fines exceed the cap',
    });
  if (pumpMin !== null && (p03 === null || p03.toNumber() < pumpMin - TOL))
    add({
      key: 'pumpable',
      kind: 'guardrail',
      reported: p03?.toNumber() ?? null,
      recomputed: pumpMin,
      detail: 'passing 0.3 mm is below the pumpable minimum',
    });

  // individual aggregate acceptance (every selected code; the tightest applies)
  const codes = snap.mode === 'BOTH' ? ['ACI', 'JS'] : [snap.mode];
  for (const l of aggs) {
    const key = l.m?.category === 'fine_agg' ? 'grading.fine.limits' : 'grading.coarse.limits';
    for (const code of codes) {
      const lim = limitsOf(rv(code, key));
      if (lim === null) {
        add({
          key: `${code}:${key}`,
          kind: 'parameter_missing',
          reported: null,
          recomputed: 'limits on file',
        });
        continue;
      }
      for (const x of lim) {
        const p = passAt(pts(l.id), x.sieve_mm);
        if (p === null || p.toNumber() < x.min_pct - TOL || p.toNumber() > x.max_pct + TOL)
          add({
            key: `grading.individual.${l.id}@${x.sieve_mm}`,
            kind: 'guardrail',
            reported: p?.toNumber() ?? null,
            recomputed: `${x.min_pct}–${x.max_pct}`,
            detail: `${code} limit`,
          });
      }
    }
  }

  // ---------------------------------------------------------- the engineering w/cm ceiling (baseline − margin)
  // It yields only to a user value that itself pins w/cm above it (fixed or minimum w/cm, or a fixed binder with a
  // fixed free water, whose ratio IS w/cm); otherwise a candidate above it was not produced by a sound search.
  const wcmFig = rec.report.figures['ratio.wcm'];
  const baselineWc = rec.report.strengthAdequacy.baselineWc;
  const wcmMargin = rn('eng.margin.wcm');
  if (typeof wcmFig === 'number' && baselineWc !== null && wcmMargin !== null) {
    const hard = rec.report.checks.find((c) => c.id === 'max_wcm')?.limit;
    const ceiling =
      Math.min(baselineWc, typeof hard === 'number' ? hard : Number.POSITIVE_INFINITY) - wcmMargin;
    if (wcmFig > ceiling + TOL) {
      const cs = snap.characteristics;
      const at = (k: string) => cs.find((c) => c.key === k && c.sub === null)?.spec;
      const w = at('wcm');
      const b = at('binder_kg');
      const wa = at('water_kg');
      const floors: number[] = [];
      if (w?.mode === 'fixed' && num(w.value)) floors.push(w.value);
      if (w?.mode === 'range' && num(w.min)) floors.push(w.min);
      if (
        b?.mode === 'fixed' &&
        wa?.mode === 'fixed' &&
        num(b.value) &&
        num(wa.value) &&
        b.value > 0
      )
        floors.push(wa.value / b.value);
      if (!floors.some((f) => f > ceiling + TOL))
        add({
          key: 'wcm.ceiling',
          kind: 'guardrail',
          reported: wcmFig,
          recomputed: ceiling,
          detail: 'w/cm is above the engineering ceiling and no user value pins it there',
        });
    }
  }

  // ---------------------------------------------------------- characteristics the evaluator cannot read
  const eRows = new Map(rec.report.characteristics.rows.map((r) => [r.key, r]));
  const tol = snap.settings.roundingTolerance;
  for (const row of rec.characteristics) {
    const spec = snap.characteristics.find(
      (c) => (c.sub === null ? c.key : `${c.key}.${c.sub}`) === row.key,
    );
    if (!spec) {
      add({
        key: row.key,
        kind: 'characteristic',
        reported: row.key,
        recomputed: null,
        detail: 'not a requested characteristic',
      });
      continue;
    }
    const evalRow = eRows.get(row.key);
    let achieved: number | null = null;
    if (spec.key === 'shilstone.cf' && p95 && p236 && !R(100).sub(p236).isZero())
      achieved = R(100).sub(p95).div(R(100).sub(p236)).mul(R(100)).toNumber();
    else if (spec.key === 'shilstone.wf' && p236) {
      const over = binder.sub(R(wfAbove));
      achieved = p236.sub(over.gt(ZERO) ? R(wfPts).mul(over).div(R(wfPer)) : ZERO).toNumber();
    } else if (spec.key === 'fines_max_pct' && fines) achieved = fines.toNumber();
    else if (spec.key === 'admixture') {
      const a = cat('admixture')[0];
      achieved = a && binder.gt(ZERO) ? a.kg.div(binder).mul(R(100)).toNumber() : null;
    }
    if (achieved === null) {
      if (evalRow && JSON.stringify(evalRow.achieved) !== JSON.stringify(row.achieved))
        add({
          key: row.key,
          kind: 'characteristic',
          reported: row.achieved,
          recomputed: evalRow.achieved,
          detail: 'differs from the evaluator row',
        });
      continue;
    }
    if (typeof row.achieved !== 'number' || Math.abs(row.achieved - achieved) > TOL)
      add({ key: row.key, kind: 'characteristic', reported: row.achieved, recomputed: achieved });
    const t = Math.max(tol[spec.key] ?? 0, 1e-6);
    const s = spec.spec;
    let ok = true;
    if (spec.key === 'admixture') ok = true;
    else if (s.mode === 'fixed' && num(s.value)) ok = Math.abs(achieved - s.value) <= t + TOL;
    else if (s.mode === 'range')
      ok =
        (!num(s.min) || achieved >= s.min - t - TOL) &&
        (!num(s.max) || achieved <= s.max + t + TOL);
    if (!ok)
      add({
        key: row.key,
        kind: 'characteristic',
        reported: row.status,
        recomputed: 'deviated',
        detail: `${achieved} is outside the request`,
      });
    if (ok && row.status !== 'met' && s.mode !== 'target')
      add({ key: row.key, kind: 'characteristic', reported: row.status, recomputed: 'met' });
  }
  for (const row of rec.characteristics)
    if (row.status !== 'met') {
      const spec = snap.characteristics.find(
        (c) => (c.sub === null ? c.key : `${c.key}.${c.sub}`) === row.key,
      );
      if (spec && spec.spec.mode !== 'target')
        add({
          key: row.key,
          kind: 'characteristic',
          reported: row.status,
          recomputed: 'met',
          detail: 'a non-target characteristic is not met',
        });
    }

  // ---------------------------------------------------------- cost, evidence, configuration
  if (rec.report.cost.state !== 'complete' || rec.costJodPerM3 !== rec.report.cost.totalJodPerM3)
    add({
      key: 'cost',
      kind: 'cost',
      reported: rec.costJodPerM3,
      recomputed: rec.report.cost.totalJodPerM3,
      detail: "the candidate cost is not the evaluator's complete total",
    });
  for (const e of ['TRIAL_REQUIRED', 'MODEL_BASELINE'] as const)
    if (!rec.evidence.includes(e))
      add({ key: `evidence.${e}`, kind: 'evidence', reported: rec.evidence, recomputed: e });
  const shortfall = rec.report.strengthAdequacy.comparison === 'design_above_baseline';
  if (shortfall !== rec.evidence.includes('MODEL_PREDICTS_SHORTFALL'))
    add({
      key: 'evidence.shortfall',
      kind: 'evidence',
      reported: rec.evidence.includes('MODEL_PREDICTS_SHORTFALL'),
      recomputed: shortfall,
    });
  if (rec.requiresAuthorization !== shortfall)
    add({
      key: 'authorization',
      kind: 'evidence',
      reported: rec.requiresAuthorization,
      recomputed: shortfall,
    });
  const cfg = rec.configuration;
  if (!lines.some((l) => l.id === cfg.cementId))
    add({
      key: 'configuration.cement',
      kind: 'configuration',
      reported: cfg.cementId,
      recomputed: lines.map((l) => l.id),
    });
  if (cfg.scmId !== null) {
    const s = lines.find((l) => l.id === cfg.scmId);
    const pct = s && binder.gt(ZERO) ? s.kg.div(binder).mul(R(100)).toNumber() : null;
    if (pct === null || Math.abs(pct - cfg.scmPct) > 2.5)
      add({
        key: 'configuration.scm',
        kind: 'configuration',
        reported: cfg.scmPct,
        recomputed: pct,
      });
  } else if (cat('scm').length > 0)
    add({
      key: 'configuration.scm',
      kind: 'configuration',
      reported: null,
      recomputed: 'SCM present',
    });
  return finish();
}
