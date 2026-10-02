// From a solver result to a candidate a person could batch: round to practical quantities, rebalance the
// volume, then RE-EVALUATE FROM SCRATCH with the evaluator (and the injected independent validator) and
// re-measure every guardrail on the rounded numbers. A candidate that fails anything after rounding is
// rejected with its reason; the solver's optimum is never reported as is.
import { evaluate } from '../evaluate/evaluate';
import type {
  CandidateRecord,
  CharacteristicRow,
  EvaluationReport,
  EvaluationSnapshot,
  EvidenceStatus,
  SnapshotLine,
} from '../evaluate/types';
import { propOf } from '../evaluate/util';
import { idOf } from '../characteristics/resolve';
import type { ConfigSpec } from './enumerate';
import { measure, type AggMass } from './measure';
import type { Prepared } from './prepare';
import type { Solved } from './solve';
import type { Candidate, CandidateMargins, Configuration } from './types';

/** The independent candidate validator (packages/validator), injected so the engine never imports it. */
export type ValidateFn = (record: CandidateRecord) => boolean | Promise<boolean>;

export type Rejection = { reason: string; detail: string };

type Mode = 'up' | 'nearest' | 'down';
const snap = (x: number, step: number, mode: Mode) => {
  const q = x / step;
  const n =
    mode === 'up' ? Math.ceil(q - 1e-9) : mode === 'down' ? Math.floor(q + 1e-9) : Math.round(q);
  return Math.round(n * step * 1e6) / 1e6;
};

export const kgText = (x: number) => (Math.round(x * 1000) / 1000).toFixed(3);

interface Grid {
  binder: Mode;
  water: Mode;
  topUps: number;
}

/** Rounding attempts in order: the stated default (binder up, water nearest), then rescues. */
const GRIDS: Grid[] = [
  { binder: 'up', water: 'nearest', topUps: 0 },
  { binder: 'up', water: 'up', topUps: 0 },
  { binder: 'up', water: 'down', topUps: 0 },
  { binder: 'nearest', water: 'nearest', topUps: 0 },
  { binder: 'down', water: 'nearest', topUps: 0 },
  { binder: 'up', water: 'nearest', topUps: 1 },
  { binder: 'up', water: 'nearest', topUps: 2 },
  { binder: 'up', water: 'nearest', topUps: 3 },
];

export function roundingTolerance(p: Prepared): Record<string, number> {
  const tol: Record<string, number> = { ...p.input.settings.roundingTolerance };
  for (const c of p.chars) {
    if (
      !['binder_kg', 'cement_kg', 'water_kg', 'agg_kg', 'fresh_density_kg_m3', 'paste_l'].includes(
        c.key,
      )
    )
      continue;
    const v = [c.spec.value, c.spec.min, c.spec.max].filter(
      (x): x is number => typeof x === 'number',
    );
    const rel = 0.01 * Math.max(0, ...v);
    tol[c.key] = Math.max(tol[c.key] ?? 0, rel);
  }
  return tol;
}

export function toLines(parts: { id: string; kg: number }[]): SnapshotLine[] {
  return parts.map((x) => ({ materialId: x.id, kgPerM3: kgText(x.kg) }));
}

export async function finalizeOne(
  p: Prepared,
  s: Solved,
  grid: Grid,
  validate: ValidateFn | undefined,
): Promise<{ ok: true; candidate: Omit<Candidate, 'rank'> } | { ok: false; rej: Rejection }> {
  const { cfg, x, model } = s;
  const frac = cfg.scmPct / 100;
  const B = x['B'] ?? 0;
  const cementKg = snap((1 - frac) * B, 5, grid.binder) + 5 * grid.topUps;
  const scmKg = cfg.scm ? snap(frac * B, 5, grid.binder) : 0;
  if (cfg.scm && scmKg <= 0)
    return { ok: false, rej: { reason: 'rounding', detail: 'the SCM rounds to zero' } };
  const binder = cementKg + scmKg;
  // Admixture: % of the rounded binder, kept inside the product's own dosage range.
  let admixKg = 0;
  if (cfg.admix && cfg.level) {
    const min = Number(propOf(cfg.admix.m, 'min_dosage_pct') ?? 0);
    const max = Number(propOf(cfg.admix.m, 'max_dosage_pct') ?? Infinity);
    admixKg = snap((cfg.level.dosagePct / 100) * binder, 0.01, 'nearest');
    if ((admixKg / binder) * 100 < min) admixKg = snap((min / 100) * binder, 0.01, 'up');
    if ((admixKg / binder) * 100 > max) admixKg = snap((max / 100) * binder, 0.01, 'down');
  }
  const k = cfg.admix && cfg.admix.countsAsWater ? admixKg * (1 - cfg.admix.solidsPct / 100) : 0;
  // Water: the LP's free water (added + admixture water) rounded, so the added line is the difference.
  const freeRaw =
    (x['W'] ?? 0) +
    (cfg.admix && cfg.admix.countsAsWater
      ? (cfg.level!.dosagePct / 100) * (1 - cfg.admix.solidsPct / 100) * B
      : 0);
  const waterKg = Math.max(0, snap(freeRaw - k, 1, grid.water));

  // Aggregates to 5 kg, the largest fine aggregate absorbs the volume residual (to 1 kg).
  const aggs = model.aggs;
  const kgs = new Map<string, number>();
  for (const a of aggs) kgs.set(a.id, snap((x[`V:${a.id}`] ?? 0) * a.rho, 5, 'nearest'));
  const volOther =
    cementKg / (cfg.cement.sg * 1000) +
    (cfg.scm ? scmKg / (cfg.scm.sg * 1000) : 0) +
    (cfg.admix ? admixKg / (cfg.admix.sg * 1000) : 0) +
    waterKg / (p.water.sg * 1000);
  const target = 1 - cfg.airPct / 100;
  const fineByKg = p.fines
    .filter((f) => (kgs.get(f.id) ?? 0) > 0)
    .sort((a, b) => kgs.get(b.id)! - kgs.get(a.id)! || a.id.localeCompare(b.id));
  const rebalance = fineByKg[0] ?? p.fines[0]!;
  const volAggOther = aggs
    .filter((a) => a.id !== rebalance.id)
    .reduce((acc, a) => acc + (kgs.get(a.id) ?? 0) / a.rho, 0);
  const residual = target - volOther - volAggOther;
  if (residual <= 0)
    return {
      ok: false,
      rej: {
        reason: 'rebalance',
        detail: 'rounding leaves no volume for the rebalancing aggregate',
      },
    };
  kgs.set(rebalance.id, snap(residual * rebalance.rho, 1, 'nearest'));

  const parts: { id: string; kg: number }[] = [
    { id: cfg.cement.id, kg: cementKg },
    ...(cfg.scm ? [{ id: cfg.scm.id, kg: scmKg }] : []),
    { id: p.water.id, kg: waterKg },
    ...(cfg.admix ? [{ id: cfg.admix.id, kg: admixKg }] : []),
    ...aggs.filter((a) => (kgs.get(a.id) ?? 0) > 0).map((a) => ({ id: a.id, kg: kgs.get(a.id)! })),
  ];
  const lines = toLines(parts);

  const baseline = p.airByNmas.get(cfg.nmas);
  const snapshot: EvaluationSnapshot = {
    ...p.input.base,
    lines,
    request: {
      ...p.input.base.request,
      nmasMm: cfg.nmas,
      airPct: Math.abs(cfg.airPct - (baseline ?? Number.NaN)) < 1e-9 ? null : cfg.airPct,
    },
    settings: { ...p.input.base.settings, roundingTolerance: roundingTolerance(p) },
  };
  const report = evaluate(snapshot);
  if (report.verdict !== 'pass' || !report.minimumData.ok) {
    const bad = report.checks.filter((c) => c.status !== 'pass').map((c) => c.id);
    return {
      ok: false,
      rej: {
        reason: 'evaluation',
        detail: `after rounding the evaluator reports ${report.verdict}: ${bad.join(', ') || 'incomplete data'}`,
      },
    };
  }

  // Guardrails re-measured on the rounded numbers, against the limits WITHOUT the rounding guard.
  const aggMass: AggMass[] = aggs
    .filter((a) => (kgs.get(a.id) ?? 0) > 0)
    .map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      kg: kgs.get(a.id)!,
      points: a.points,
      finer75Pct: a.finer75Pct,
    }));
  const wf = p.guard.forNmas(cfg.nmas);
  if ('blocker' in wf)
    return { ok: false, rej: { reason: 'parameter', detail: wf.blocker.detail } };
  const m = measure(aggMass, binder, cfg.nmas, p.guard.base, wf.wf);
  if (!m.ok) return { ok: false, rej: { reason: 'measure', detail: m.blocker.detail } };
  const gr = m.value;
  const g = p.guard.base;
  const allowed = g.gradingBandPct - g.gradingMarginPts;
  const E = 1e-6;
  const problems: string[] = [];
  for (const r of gr.gradingSieves)
    if (Math.abs(r.passing_pct - r.target_pct) > allowed + E)
      problems.push(
        `grading at ${r.sieve_mm} mm is ${r.passing_pct.toFixed(1)} % (target ${r.target_pct.toFixed(1)} ± ${allowed})`,
      );
  if (gr.coarsenessFactor < g.cfMin - E || gr.coarsenessFactor > g.cfMax + E)
    problems.push(`coarseness factor ${gr.coarsenessFactor.toFixed(1)}`);
  if (
    gr.workabilityFactorAdjusted < (wf.wf.min as number) - E ||
    gr.workabilityFactorAdjusted > (wf.wf.max as number) + E
  )
    problems.push(`workability factor ${gr.workabilityFactorAdjusted.toFixed(1)}`);
  if (gr.finesPct > g.finesMaxPct + E) problems.push(`fines ${gr.finesPct.toFixed(1)} %`);
  const wcmFinal = report.figures['ratio.wcm'] as number;
  if (!model.shortfallPath && wcmFinal > p.wcmCeiling + E)
    problems.push(
      `w/cm ${wcmFinal.toFixed(3)} is above the engineering ceiling ${p.wcmCeiling.toFixed(3)}`,
    );
  if (p.pumpable && g.pumpableMin03Pct !== null && (gr.passing03Pct ?? 0) < g.pumpableMin03Pct - E)
    problems.push(`passing 0.3 mm ${gr.passing03Pct?.toFixed(1)} %`);
  if (problems.length > 0)
    return {
      ok: false,
      rej: { reason: 'guardrail', detail: `after rounding: ${problems.join('; ')}` },
    };

  // Characteristics: the evaluator's rows, plus the keys it cannot judge (candidate layer).
  const rows = candidateRows(p, report, cfg, gr, (admixKg / binder) * 100);
  const failedChar = rows.filter((r) => r.status !== 'met' && !isTargetRow(p, r.key));
  if (failedChar.length > 0)
    return {
      ok: false,
      rej: {
        reason: 'characteristics',
        detail: `after rounding: ${failedChar.map((r) => `${r.key} ${r.achieved ?? '–'} (asked ${r.requested})`).join('; ')}`,
      },
    };

  const wcmLimit = p.durabilityWcm ?? p.baselineWc;
  const wcm = (report.figures['ratio.wcm'] as number) ?? 0;
  const margins: CandidateMargins = {
    wcmHeadroom: wcmLimit - wcm,
    wcmCeiling: wcmLimit,
    cfMargin: Math.min(gr.coarsenessFactor - g.cfMin, g.cfMax - gr.coarsenessFactor),
    wfMargin: Math.min(
      gr.workabilityFactorAdjusted - (wf.wf.min as number),
      (wf.wf.max as number) - gr.workabilityFactorAdjusted,
    ),
    finesMargin: g.finesMaxPct - gr.finesPct,
    gradingMarginPts: Math.min(
      ...gr.gradingSieves.map((r) => allowed - Math.abs(r.passing_pct - r.target_pct)),
      allowed,
    ),
  };

  const evidence = new Set<EvidenceStatus>(report.evidence);
  evidence.add('MODEL_BASELINE');
  evidence.add('TRIAL_REQUIRED');
  const notes: Candidate['notes'] = [];
  if (model.userWater) {
    const wr = report.figures['mass.water'] as number;
    if (wr < model.waterDemand - 1e-6) {
      evidence.add('USER_OVERRIDE');
      const below = ((model.waterDemand - wr) / model.waterDemand) * 100;
      notes.push({
        code: below > p.input.settings.waterOverrideWarnPct ? 'slump_at_risk' : 'water_below_model',
        detail: `free water ${wr.toFixed(0)} kg/m³ is ${below.toFixed(1)} % below the model estimate ${model.waterDemand.toFixed(0)} kg/m³${below > p.input.settings.waterOverrideWarnPct ? '; the slump is at risk' : ''}`,
      });
    }
  }
  if (report.strengthAdequacy.evidence.includes('MODEL_PREDICTS_SHORTFALL'))
    evidence.add('MODEL_PREDICTS_SHORTFALL');
  const cost = report.cost.totalJodPerM3;
  const deviations = rows
    .filter((r) => isTargetRow(p, r.key) && typeof r.achieved === 'number' && r.delta !== null)
    .map((r) => {
      const c = p.chars.find((x) => idOf(x) === r.key)!;
      const w =
        typeof c.spec['weight_jod_per_unit'] === 'number'
          ? (c.spec['weight_jod_per_unit'] as number)
          : p.input.settings.targetWeightJodPerUnit;
      return {
        key: r.key,
        requested: c.spec.value as number,
        achieved: r.achieved as number,
        weightedCostJod: Math.abs(r.delta!) * w,
      };
    });
  const configuration: Configuration = {
    cementId: cfg.cement.id,
    scmId: cfg.scm?.id ?? null,
    scmPct: cfg.scmPct,
    admixtureId: cfg.admix?.id ?? null,
    dosagePct: cfg.level?.dosagePct ?? 0,
    nmasMm: cfg.nmas,
    airPct: cfg.airPct,
  };
  const candidate: Omit<Candidate, 'rank'> = {
    configuration,
    lines,
    snapshot,
    report,
    guardrails: gr,
    margins,
    binding: s.binding,
    costJodPerM3: cost,
    objectiveValue: Number(cost ?? 0) + deviations.reduce((a, d) => a + d.weightedCostJod, 0),
    deviations,
    characteristics: rows,
    evidence: [...evidence].sort(),
    requiresAuthorization: evidence.has('MODEL_PREDICTS_SHORTFALL'),
    notes,
  };
  if (validate && !(await validate(candidateRecord(candidate, p.input.materials ?? {}))))
    return {
      ok: false,
      rej: {
        reason: 'validator',
        detail: 'the independent validator disagrees with the optimizer on this candidate',
      },
    };
  return { ok: true, candidate };
}

/** The plain-data record the independent candidate validator checks. */
export function candidateRecord(
  c: Omit<Candidate, 'rank'>,
  materials: { include?: string[]; exclude?: string[]; prefer?: string[] },
): CandidateRecord {
  return {
    schema: 1,
    snapshot: c.snapshot,
    report: c.report,
    configuration: c.configuration,
    guardrails: c.guardrails,
    characteristics: c.characteristics,
    costJodPerM3: c.costJodPerM3,
    evidence: c.evidence,
    requiresAuthorization: c.requiresAuthorization,
    materials: {
      ...(materials.include ? { include: materials.include } : {}),
      ...(materials.exclude ? { exclude: materials.exclude } : {}),
    },
  };
}

const isTargetRow = (p: Prepared, id: string) =>
  p.chars.find((c) => idOf(c) === id)?.spec.mode === 'target';

/** Evaluator rows plus candidate-layer rows for characteristics the evaluator does not judge. */
function candidateRows(
  p: Prepared,
  report: EvaluationReport,
  cfg: ConfigSpec,
  gr: ReturnType<typeof measure> extends infer R
    ? R extends { ok: true; value: infer V }
      ? V
      : never
    : never,
  dosagePct: number,
): CharacteristicRow[] {
  const tol = report.characteristics.rows.length ? roundingTolerance(p) : {};
  return report.characteristics.rows.map((r) => {
    const c = p.chars.find((x) => idOf(x) === r.key)!;
    const own = ownAchieved(c.key, gr, cfg, dosagePct);
    if (own === undefined) return r;
    const t = Math.max(tol[c.key] ?? 0, 1e-6);
    let status: CharacteristicRow['status'] = 'met';
    let delta: number | null = 0;
    const want = c.spec.value;
    if (c.key === 'admixture') {
      const lvl = c.spec['dosage_level'] as number | undefined;
      const lvlPct =
        lvl !== undefined
          ? p.admixtures.find((a) => a.id === cfg.admix?.id)?.levels[lvl - 1]?.dosagePct
          : undefined;
      const wantPct = (c.spec['dosage_pct'] as number | undefined) ?? lvlPct;
      if (c.spec.mode === 'fixed' && wantPct !== undefined) delta = own - wantPct;
      status = delta === null || Math.abs(delta) <= Math.max(t, 0.01) ? 'met' : 'deviated';
    } else if (c.spec.mode === 'fixed' || c.spec.mode === 'target') {
      delta = own - (want as number);
      status = Math.abs(delta) <= t ? 'met' : 'deviated';
    } else if (c.spec.mode === 'range') {
      const below = c.spec.min !== undefined && own < c.spec.min - t;
      const above = c.spec.max !== undefined && own > c.spec.max + t;
      delta = below ? own - c.spec.min! : above ? own - c.spec.max! : 0;
      status = below || above ? 'deviated' : 'met';
    }
    return {
      ...r,
      achieved: own,
      delta: delta === null ? null : Math.round(delta * 1e6) / 1e6,
      status,
      blocker: null,
    };
  });
}

function ownAchieved(
  key: string,
  gr: { coarsenessFactor: number; workabilityFactorAdjusted: number; finesPct: number },
  cfg: ConfigSpec,
  dosagePct: number,
): number | undefined {
  if (key === 'shilstone.cf') return gr.coarsenessFactor;
  if (key === 'shilstone.wf') return gr.workabilityFactorAdjusted;
  if (key === 'fines_max_pct') return gr.finesPct;
  if (key === 'admixture') return cfg.admix ? dosagePct : undefined;
  return undefined;
}

export { GRIDS };
