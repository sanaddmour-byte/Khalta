// Independent validator (safety contract: solver output is not an approved mix; this second implementation
// must agree with the evaluator before any number is shown as verified). It recomputes every figure, check
// status, strength value, baseline, cost line and characteristic row from the snapshot with its own
// arithmetic, compares them with the report and its trace, and reports any difference as a hard failure.
// It never imports optimizer code or the evaluator's calculation modules (enforced by lint, depcruise and a test).
import type {
  EvaluationReport,
  EvaluationSnapshot,
  ValidatorMismatch,
  ValidatorResult,
} from '@khalta/engine';
import { recompute, type Expected, type Fig } from './recompute';

export const VALIDATOR_API_VERSION = 1;
export const VALIDATOR_VERSION = '1.0.0';

/** Numbers are reported to 6 decimal places; anything further apart than this is a real difference. */
const TOL = 1.0e-6;

type Mismatch = ValidatorMismatch;

const close = (a: unknown, b: unknown): boolean => {
  if (a === null || b === null || a === undefined || b === undefined)
    return (a ?? null) === (b ?? null);
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= TOL;
  return a === b;
};

const sameSet = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function validateEvaluation(
  snapshot: EvaluationSnapshot,
  report: EvaluationReport,
): ValidatorResult {
  const mismatches: Mismatch[] = [];
  const add = (m: Mismatch) => mismatches.push(m);
  const result = (checked: ValidatorResult['checked']): ValidatorResult => ({
    validatorVersion: VALIDATOR_VERSION,
    status: mismatches.length === 0 ? 'pass' : 'fail',
    mismatches,
    checked,
  });

  let exp: Expected;
  try {
    if (snapshot?.schema !== 1) throw new Error('unsupported snapshot schema');
    exp = recompute(snapshot);
  } catch (e) {
    add({
      key: 'snapshot',
      kind: 'snapshot_invalid',
      reported: null,
      recomputed: null,
      detail: (e as Error).message,
    });
    return result({ figures: 0, checks: 0, trace: 0 });
  }

  // ---- metadata
  if (report?.schema !== 1)
    add({ key: 'schema', kind: 'metadata_mismatch', reported: report?.schema, recomputed: 1 });
  if (report?.mode !== snapshot.mode)
    add({
      key: 'mode',
      kind: 'metadata_mismatch',
      reported: report?.mode,
      recomputed: snapshot.mode,
    });
  if (report?.evaluationDate !== snapshot.evaluationDate)
    add({
      key: 'evaluationDate',
      kind: 'metadata_mismatch',
      reported: report?.evaluationDate,
      recomputed: snapshot.evaluationDate,
    });

  // ---- figures
  const figs = report.figures ?? {};
  for (const [key, want] of exp.figures) {
    if (!(key in figs)) {
      add({ key, kind: 'missing_figure', reported: undefined, recomputed: want });
      continue;
    }
    if (!close(figs[key], want as Fig))
      add({ key, kind: 'figure_mismatch', reported: figs[key], recomputed: want });
  }
  for (const key of Object.keys(figs))
    if (!exp.figures.has(key))
      add({ key, kind: 'unexpected_figure', reported: figs[key], recomputed: undefined });

  // ---- trace: one entry per figure, same value, with a formula and named inputs
  const traceByKey = new Map<string, EvaluationReport['trace'][number]>();
  for (const t of report.trace ?? []) {
    if (traceByKey.has(t.key))
      add({
        key: t.key,
        kind: 'trace_mismatch',
        reported: 'duplicate',
        recomputed: 'one entry',
        detail: 'duplicate trace key',
      });
    traceByKey.set(t.key, t);
  }
  for (const key of exp.figures.keys()) {
    const t = traceByKey.get(key);
    if (!t) {
      add({ key, kind: 'missing_trace', reported: undefined, recomputed: exp.figures.get(key) });
      continue;
    }
    if (!close(t.value, exp.figures.get(key) as Fig))
      add({ key, kind: 'trace_mismatch', reported: t.value, recomputed: exp.figures.get(key) });
    if (
      !t.formula ||
      typeof t.formula !== 'string' ||
      typeof t.inputs !== 'object' ||
      t.inputs === null
    )
      add({
        key,
        kind: 'trace_mismatch',
        reported: 'no formula or inputs',
        recomputed: 'formula and inputs',
      });
  }
  for (const key of traceByKey.keys())
    if (!exp.figures.has(key))
      add({
        key,
        kind: 'trace_mismatch',
        reported: 'trace entry without a figure',
        recomputed: undefined,
      });

  // ---- checks
  const reportChecks = new Map((report.checks ?? []).map((c) => [c.id, c]));
  for (const [id, want] of exp.checks) {
    const got = reportChecks.get(id);
    if (!got) {
      add({ key: id, kind: 'missing_check', reported: undefined, recomputed: want.status });
      continue;
    }
    if (got.status !== want.status)
      add({
        key: id,
        kind: 'check_mismatch',
        reported: got.status,
        recomputed: want.status,
        detail: 'status',
      });
    if (!close(got.value, want.value))
      add({
        key: id,
        kind: 'check_mismatch',
        reported: got.value,
        recomputed: want.value,
        detail: 'value',
      });
    const limitOk = Array.isArray(want.limit)
      ? sameSet(got.limit, want.limit)
      : close(got.limit, want.limit);
    if (!limitOk)
      add({
        key: id,
        kind: 'check_mismatch',
        reported: got.limit,
        recomputed: want.limit,
        detail: 'limit',
      });
    if ((got.warning ?? null) !== want.warning)
      add({
        key: id,
        kind: 'check_mismatch',
        reported: got.warning,
        recomputed: want.warning,
        detail: 'warning',
      });
    if (got.traceKey !== null && !traceByKey.has(got.traceKey))
      add({
        key: id,
        kind: 'missing_trace',
        reported: got.traceKey,
        recomputed: 'trace entry',
        detail: 'check points at a trace key that does not exist',
      });
  }
  for (const id of reportChecks.keys())
    if (!exp.checks.has(id))
      add({
        key: id,
        kind: 'unexpected_check',
        reported: reportChecks.get(id)!.status,
        recomputed: undefined,
      });

  // ---- verdict and provisional flag
  if (report.verdict !== exp.verdict)
    add({
      key: 'verdict',
      kind: 'verdict_mismatch',
      reported: report.verdict,
      recomputed: exp.verdict,
    });
  if (exp.unverifiedUsed && !report.provisional)
    add({
      key: 'provisional',
      kind: 'verdict_mismatch',
      reported: false,
      recomputed: true,
      detail: 'rules in use are unverified, so the result is provisional',
    });
  if (exp.unverifiedUsed && !(report.evidence ?? []).includes('RULE_UNVERIFIED'))
    add({
      key: 'evidence',
      kind: 'verdict_mismatch',
      reported: report.evidence,
      recomputed: 'RULE_UNVERIFIED',
      detail: 'unverified rules in use are not flagged',
    });

  // ---- strength
  const st = report.strength;
  if (!close(st?.cylinderMpa, exp.strength.cylinderMpa))
    add({
      key: 'strength.cylinderMpa',
      kind: 'strength_mismatch',
      reported: st?.cylinderMpa,
      recomputed: exp.strength.cylinderMpa,
    });
  if (!close(st?.fcrMpa, exp.strength.fcrMpa))
    add({
      key: 'strength.fcrMpa',
      kind: 'strength_mismatch',
      reported: st?.fcrMpa,
      recomputed: exp.strength.fcrMpa,
    });
  if ((st?.governingRuleset ?? null) !== exp.strength.governing)
    add({
      key: 'strength.governingRuleset',
      kind: 'strength_mismatch',
      reported: st?.governingRuleset,
      recomputed: exp.strength.governing,
    });
  for (const b of st?.branches ?? [])
    if (!close(b.value, exp.strength.branches.get(b.ruleset) ?? null))
      add({
        key: `strength.branch.${b.ruleset}`,
        kind: 'strength_mismatch',
        reported: b.value,
        recomputed: exp.strength.branches.get(b.ruleset) ?? null,
      });
  const adq = report.strengthAdequacy;
  if (!close(adq?.baselineWc, exp.adequacy.baselineWc))
    add({
      key: 'strengthAdequacy.baselineWc',
      kind: 'strength_mismatch',
      reported: adq?.baselineWc,
      recomputed: exp.adequacy.baselineWc,
    });
  if ((adq?.comparison ?? null) !== exp.adequacy.comparison)
    add({
      key: 'strengthAdequacy.comparison',
      kind: 'strength_mismatch',
      reported: adq?.comparison,
      recomputed: exp.adequacy.comparison,
    });
  if (adq?.label !== 'not_a_compliance_result')
    add({
      key: 'strengthAdequacy.label',
      kind: 'strength_mismatch',
      reported: adq?.label,
      recomputed: 'not_a_compliance_result',
      detail: 'strength adequacy must never be presented as compliance',
    });
  const wb = report.waterBaseline;
  if (!close(wb?.baseWaterKg, exp.water.baseWaterKg))
    add({
      key: 'waterBaseline.baseWaterKg',
      kind: 'strength_mismatch',
      reported: wb?.baseWaterKg,
      recomputed: exp.water.baseWaterKg,
    });
  if (!close(wb?.baselineWaterKg, exp.water.baselineWaterKg))
    add({
      key: 'waterBaseline.baselineWaterKg',
      kind: 'strength_mismatch',
      reported: wb?.baselineWaterKg,
      recomputed: exp.water.baselineWaterKg,
    });
  if (!close(wb?.admixtureReductionPct, exp.water.reductionPct))
    add({
      key: 'waterBaseline.admixtureReductionPct',
      kind: 'strength_mismatch',
      reported: wb?.admixtureReductionPct,
      recomputed: exp.water.reductionPct,
    });

  // ---- cost
  const cost = report.cost;
  if (cost?.state !== exp.cost.state)
    add({
      key: 'cost.state',
      kind: 'cost_mismatch',
      reported: cost?.state,
      recomputed: exp.cost.state,
    });
  if ((cost?.totalJodPerM3 ?? null) !== exp.cost.total)
    add({
      key: 'cost.total',
      kind: 'cost_mismatch',
      reported: cost?.totalJodPerM3,
      recomputed: exp.cost.total,
    });
  if (cost?.subtotalJodPerM3 !== exp.cost.subtotal)
    add({
      key: 'cost.subtotal',
      kind: 'cost_mismatch',
      reported: cost?.subtotalJodPerM3,
      recomputed: exp.cost.subtotal,
    });
  const costLines = new Map((cost?.lines ?? []).map((l) => [l.materialId, l]));
  for (const [id, want] of exp.cost.lines) {
    const got = costLines.get(id);
    if (!got || got.jod !== want.jod || got.state !== want.state)
      add({
        key: `cost.line.${id}`,
        kind: 'cost_mismatch',
        reported: got ? { jod: got.jod, state: got.state } : undefined,
        recomputed: want,
      });
  }
  const missingIds = (cost?.missing ?? []).map((m) => m.materialId).sort();
  const wantMissing = [...exp.cost.lines]
    .filter(([, v]) => v.jod === null)
    .map(([k]) => k)
    .sort();
  if (!sameSet(missingIds, wantMissing))
    add({
      key: 'cost.missing',
      kind: 'cost_mismatch',
      reported: missingIds,
      recomputed: wantMissing,
    });

  // ---- minimum data
  const md = report.minimumData;
  const missingMd = (md?.missing ?? []).map((m) => m.materialId).sort();
  if (!sameSet(missingMd, [...exp.minimumData.missing].sort()))
    add({
      key: 'minimumData.missing',
      kind: 'metadata_mismatch',
      reported: missingMd,
      recomputed: exp.minimumData.missing,
    });
  if (exp.minimumData.ok === false && md?.ok === true)
    add({ key: 'minimumData.ok', kind: 'metadata_mismatch', reported: true, recomputed: false });

  // ---- characteristics
  const rows = new Map((report.characteristics?.rows ?? []).map((r) => [r.key, r]));
  for (const [id, want] of exp.chars) {
    const got = rows.get(id);
    if (!got) {
      add({ key: id, kind: 'characteristic_mismatch', reported: undefined, recomputed: want });
      continue;
    }
    if (!close(got.achieved, want.achieved) || got.status !== want.status)
      add({
        key: id,
        kind: 'characteristic_mismatch',
        reported: { achieved: got.achieved, status: got.status },
        recomputed: want,
      });
  }
  for (const id of rows.keys())
    if (!exp.chars.has(id))
      add({ key: id, kind: 'characteristic_mismatch', reported: 'row', recomputed: undefined });

  return result({ figures: exp.figures.size, checks: exp.checks.size, trace: traceByKey.size });
}

export type { ValidatorMismatch, ValidatorResult } from '@khalta/engine';
export { validateCandidate } from './candidate';
