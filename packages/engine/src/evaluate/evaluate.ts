// The evaluate kernel (01-domain §3): resolve requirements, f'cr, absolute volume, checks, strength-adequacy
// block, water baseline, cost, data quality and requested-vs-achieved, each with a trace. Pure and
// deterministic: the same snapshot yields a byte-identical report. Never approves anything.
import { approvalBlockers, resolve } from '@khalta/rules';
import { achievedRows } from '../characteristics/achieved';
import type { ResolvedCharacteristic } from '../characteristics/resolve';
import { declaredKeyFields } from '../materials/readiness';
import type { Category, Properties } from '../materials/properties';
import { entrappedAir, strengthAdequacy, waterBaseline } from './baselines';
import { combinedFm, combinedPassing, computeBlend, fmSeries } from './blend';
import { buildChecks, verdictOf } from './checks';
import { computeCost } from './cost';
import { computeStrength } from './strength';
import { evaluationContext } from './select';
import {
  EVALUATOR_VERSION,
  type EvaluationReport,
  type EvaluationSnapshot,
  type EvidenceStatus,
  type QualityItem,
} from './types';
import { attachReasons } from './reasons';
import { RuleIndex, Tracer } from './util';

const fixedOf = (chars: readonly ResolvedCharacteristic[], key: string): number | null => {
  const c = chars.find((x) => x.key === key && x.spec.mode === 'fixed');
  return c && typeof c.spec.value === 'number' ? c.spec.value : null;
};

function materialQuality(s: EvaluationSnapshot, sulfateGoverns: boolean): QualityItem[] {
  const out: QualityItem[] = [];
  for (const l of s.lines) {
    const m = s.materials.find((x) => x.id === l.materialId);
    if (!m) {
      out.push({
        code: 'material_missing',
        severity: 'blocker',
        materialId: l.materialId,
        detail: 'material record not found',
        evidence: ['INPUT_MISSING'],
      });
      continue;
    }
    if (!m.test) {
      out.push({
        code: 'test_missing',
        severity: 'blocker',
        materialId: m.id,
        detail: 'no test data on file',
        evidence: ['INPUT_MISSING'],
      });
      continue;
    }
    if (m.test.freshness === 'expired')
      out.push({
        code: 'test_expired',
        severity: 'warning',
        materialId: m.id,
        detail: `test v${m.test.version} of ${m.test.testedAt} is past its validity`,
        evidence: ['INPUT_STALE'],
      });
    else if (m.test.freshness === 'not_configured')
      out.push({
        code: 'test_age_limit_not_configured',
        severity: 'info',
        materialId: m.id,
        detail: 'no test-age limit is configured, so test age is not judged',
      });
    const declared = declaredKeyFields(
      m.category as Category,
      m.test.properties as Properties,
      m.test.fieldSources,
      { sulfateGoverns },
    );
    if (declared.length > 0)
      out.push({
        code: 'declared_values',
        severity: 'warning',
        materialId: m.id,
        detail: `user-declared key values: ${declared.join(', ')}`,
        evidence: ['INPUT_USER_DECLARED'],
      });
  }
  return out;
}

export function evaluate(s: EvaluationSnapshot): EvaluationReport {
  const rules = new RuleIndex(s.rules);
  const tr = new Tracer();
  const chars = s.characteristics;
  const assumptions: string[] = [];

  // 1. strength (needs the cylinder basis for the rules context)
  const strength = computeStrength(
    {
      request: s.request,
      mode: s.mode,
      safetyMarginMpa: s.settings.safetyMarginMpa,
      extraMarginMpa: fixedOf(chars, 'extra_margin_mpa'),
      fixedFcrMpa: fixedOf(chars, 'fcr_mpa'),
      stats: s.strengthRecords,
    },
    rules,
    tr,
  );

  // 2. requirements from the selected rulesets, project overrides tighten only
  const ctx = evaluationContext(s.request, strength.cylinderMpa);
  const resolved = resolve(s.rules, {
    mode: s.mode,
    context: ctx,
    projectOverrides: s.projectOverrides,
    tablePolicy: s.tablePolicy,
  });

  // 3. quantities from the proportions
  const blend = computeBlend(s, rules, tr, (req) => {
    const a = entrappedAir(req, rules, ctx);
    return 'blocker' in a ? a : { value: a.value, clause: a.clause };
  });

  // combined gradation figures
  const series = fmSeries(rules);
  tr.add(
    'agg.fm_combined',
    combinedFm(blend, series),
    'none',
    'FM of the combined (mass-weighted) gradation on the FM series',
    {
      aggregateKg: blend.aggregateKg,
    },
  );
  for (const c of chars.filter((x) => x.key === 'passing_pct'))
    tr.add(
      `agg.passing.${c.sub}`,
      combinedPassing(blend, Number(c.sub)),
      '%',
      'mass-weighted % passing of the combined aggregate',
      {
        sieve: Number(c.sub),
      },
    );

  // 4. checks, strength adequacy, water baseline, cost
  const built = buildChecks({ s, resolved, blend, strength, rules, tr });
  const adequacy = strengthAdequacy(strength.fcrMpa, blend.wcm, rules, ctx, tr, {
    input: s.strengthModel,
    request: s.request,
  });
  const water = waterBaseline(s.request, blend, rules, ctx, tr);
  const cost = computeCost(s, tr);

  // 5. characteristics: requested vs achieved
  const rows = achievedRows(chars, s, tr.raw);

  // 6. data quality, evidence, verdict
  const sulfateGoverns = resolved.requirements.some((r) => r.requirement === 'sulfate_cement');
  const quality: QualityItem[] = [
    ...materialQuality(s, sulfateGoverns),
    ...blend.quality,
    ...cost.quality,
    ...built.quality,
  ];
  const blockers = approvalBlockers(resolved);
  const usedUnverified = [...rules.used.values()].some((v) => !v);
  const unverifiedCount = blockers.unverified.length + (usedUnverified ? 1 : 0);
  if (unverifiedCount > 0)
    quality.push({
      code: 'rules_unverified',
      severity: 'warning',
      detail: `${blockers.unverified.length} rule value(s) used by this evaluation are not yet verified by a QC manager`,
      evidence: ['RULE_UNVERIFIED'],
    });
  for (const o of resolved.rejectedOverrides)
    quality.push({
      code: 'override_rejected',
      severity: 'warning',
      detail: `project value for ${o.requirement} would loosen the code limit and was not applied (${o.message})`,
    });
  if (blockers.missing.length > 0)
    quality.push({
      code: 'rules_missing',
      severity: 'warning',
      detail: `${blockers.missing.length} applicable rule value(s) are not on file`,
      evidence: ['INPUT_MISSING'],
    });
  if (!strength.marginConfigured)
    quality.push({
      code: 'safety_margin_not_configured',
      severity: 'info',
      detail: "no f'cr safety margin is configured; 0 MPa was added",
    });
  if (s.settings.nearLimitPct === null)
    quality.push({
      code: 'near_limit_not_configured',
      severity: 'info',
      detail: 'no near-limit warning percentage is configured; near-limit warnings are off',
    });
  if (s.strengthRecords === null)
    quality.push({
      code: 'no_strength_records',
      severity: 'info',
      detail: "no strength records exist, so the f'cr no-data equations were used",
    });

  const evidence = new Set<EvidenceStatus>(['TRIAL_REQUIRED']);
  for (const c of built.checks) for (const e of c.evidence) evidence.add(e);
  for (const q of quality) for (const e of q.evidence ?? []) evidence.add(e);
  for (const e of adequacy.evidence) evidence.add(e);
  for (const e of water.block.evidence) if (water.block.baselineWaterKg !== null) evidence.add(e);
  for (const r of rows) for (const e of r.evidence) evidence.add(e);
  if (usedUnverified) evidence.add('RULE_UNVERIFIED');
  if (blend.airSource === 'baseline') evidence.add('MODEL_BASELINE');

  const verdict = verdictOf(built.checks, quality);
  const provisional =
    evidence.has('RULE_UNVERIFIED') ||
    built.requirements.some((r) => r.checked && r.status !== 'resolved');

  assumptions.push(...blend.assumptions, ...built.assumptions, ...water.assumptions);
  if (s.request.exposure.some((e) => ['F1', 'F2', 'F3'].includes(e)))
    assumptions.push(
      'Exposure F1–F3 implies an air-entrained design; the air-entrained ACI 211.1 tables are not on file, so baselines are unavailable.',
    );
  if (s.request.testAgeDays !== null && s.request.testAgeDays !== 28)
    assumptions.push(
      `Strength is specified at ${s.request.testAgeDays} days; the f'cr equations and baselines are 28-day values.`,
    );

  return attachReasons({
    schema: 1,
    evaluatorVersion: EVALUATOR_VERSION,
    mode: s.mode,
    evaluationDate: s.evaluationDate,
    figures: tr.figures,
    trace: tr.entries,
    strength,
    checks: built.checks,
    requirements: built.requirements,
    verdict,
    provisional,
    strengthAdequacy: adequacy,
    waterBaseline: water.block,
    cost: cost.block,
    dataQuality: quality,
    characteristics: { rows },
    evidence: [...evidence].sort(),
    assumptions,
    // Water without a test uses the stated default SG; every other line needs its own SG.
    minimumData: { ok: blend.missingMinimum.length === 0, missing: blend.missingMinimum },
  });
}
