// Compliance checks: every resolved requirement that a design can be checked against, each with a tri-state
// result. A missing limit, test value or input is "not evaluated: <named blocker>", never a pass.
import { lookupTable, type ResolveResult, type ResolvedRequirement } from '@khalta/rules';
import type { Blend } from './blend';
import type {
  EvalBlocker,
  CheckResult,
  EvaluationSnapshot,
  EvidenceStatus,
  GoverningRef,
  QualityItem,
  RequirementRow,
  StrengthBlock,
  Tri,
} from './types';
import { isNum, numProp, propOf, round6, type RuleIndex, type Tracer } from './util';

export const EPS = 1e-9;

export interface CheckCtx {
  s: EvaluationSnapshot;
  resolved: ResolveResult;
  blend: Blend;
  strength: StrengthBlock;
  rules: RuleIndex;
  tr: Tracer;
}

const reqOf = (r: ResolveResult, name: string) =>
  r.requirements.find((x) => x.requirement === name);

function governingRef(r: ResolvedRequirement | undefined): GoverningRef | null {
  const g = r?.governing;
  return g
    ? {
        source: String(g.source),
        ruleKey: g.ruleKey,
        clause: g.clause_ref,
        requirementClass: g.requirement_class,
        verified: g.verified,
      }
    : null;
}

/** Why a requirement cannot be used as a limit (null = usable). */
function unusable(r: ResolvedRequirement): EvalBlocker | null {
  if (r.value !== null && r.status !== 'blocked') return null;
  const issue = r.issues[0];
  const code: EvalBlocker['code'] =
    issue?.code === 'value_missing' || issue?.code === 'other_side_missing' || !issue
      ? 'rule_not_on_file'
      : issue.code === 'context_missing'
        ? 'context_missing'
        : 'rule_blocked';
  return { code, detail: issue?.message ?? `${r.requirement}: no value on file` };
}

function evidenceFor(
  r: ResolvedRequirement | undefined,
  status: Tri,
  blocker: EvalBlocker | null,
): EvidenceStatus[] {
  const out: EvidenceStatus[] = [];
  if (r?.governing) {
    if (String(r.governing.source) === 'PROJECT') out.push('PROJECT_VERIFIED');
    else out.push(r.verified ? 'CODE_VERIFIED' : 'RULE_UNVERIFIED');
  }
  if (status === 'not_evaluated' && blocker && blocker.code !== 'not_applicable_here')
    out.push('INPUT_MISSING');
  return [...new Set(out)];
}

interface Spec {
  id: string;
  requirement: string;
  req: ResolvedRequirement | undefined;
  units: string;
  op: CheckResult['op'];
  value: number | string | null;
  limit: CheckResult['limit'];
  pass: boolean | null;
  blocker?: EvalBlocker | null;
  traceKey?: string | null;
  note?: string;
  nearLimitPct: number | null;
  /** For numeric limits: how close to the limit counts as "near". */
  near?: boolean | null;
}

function make(sp: Spec): CheckResult {
  let blocker = sp.blocker ?? null;
  let status: Tri;
  if (sp.pass === null) {
    status = 'not_evaluated';
    blocker ??= { code: 'input_missing', detail: 'a value needed for this check is missing' };
  } else status = sp.pass ? 'pass' : 'fail';
  const r = sp.req;
  return {
    id: sp.id,
    requirement: sp.requirement,
    status,
    value: sp.value,
    limit: sp.limit,
    op: sp.op,
    units: sp.units,
    governing: governingRef(r),
    provisional: r ? r.status !== 'resolved' || !r.verified : false,
    evidence: evidenceFor(r, status, blocker),
    blocker: status === 'not_evaluated' ? blocker : null,
    warning: status === 'pass' && sp.nearLimitPct !== null && sp.near ? 'near_limit' : null,
    traceKey: sp.traceKey ?? null,
    ...(sp.note ? { note: sp.note } : {}),
  };
}

const num = (v: unknown) => (isNum(v) ? v : null);

/** Cement properties → sulfate-resistance class by C₃A (mill property, never the label). */
const RANK = { none: 0, moderate: 1, high: 2 } as const;
type Klass = keyof typeof RANK;

export function buildChecks(c: CheckCtx): {
  checks: CheckResult[];
  requirements: RequirementRow[];
  quality: QualityItem[];
  assumptions: string[];
} {
  const { s, resolved, blend, strength, rules, tr } = c;
  const nearPct = s.settings.nearLimitPct;
  const checks: CheckResult[] = [];
  const quality: QualityItem[] = [];
  const assumptions: string[] = [];
  const checked = new Set<string>();
  const nearMax = (v: number, limit: number) =>
    nearPct !== null && v >= limit * (1 - nearPct / 100);
  const nearMin = (v: number, limit: number) =>
    nearPct !== null && v <= limit * (1 + nearPct / 100);

  const limitCheck = (
    id: string,
    requirement: string,
    dir: 'max' | 'min',
    units: string,
    value: number | null,
    blocker: EvalBlocker | null,
    traceKey: string | null,
    note?: string,
  ) => {
    const r = reqOf(resolved, requirement);
    if (!r) return;
    checked.add(requirement);
    const bad = unusable(r);
    const lim = num(r.value);
    if (bad || lim === null) {
      checks.push(
        make({
          id,
          requirement,
          req: r,
          units,
          op: dir === 'max' ? '<=' : '>=',
          value,
          limit: null,
          pass: null,
          blocker: bad ?? {
            code: 'rule_not_on_file',
            detail: `${requirement}: no numeric value on file`,
          },
          traceKey,
          nearLimitPct: nearPct,
          ...(note ? { note } : {}),
        }),
      );
      return;
    }
    const pass = value === null ? null : dir === 'max' ? value <= lim + EPS : value >= lim - EPS;
    checks.push(
      make({
        id,
        requirement,
        req: r,
        units,
        op: dir === 'max' ? '<=' : '>=',
        value,
        limit: lim,
        pass,
        blocker: value === null ? blocker : null,
        traceKey,
        nearLimitPct: nearPct,
        near: value === null ? null : dir === 'max' ? nearMax(value, lim) : nearMin(value, lim),
        ...(note ? { note } : {}),
      }),
    );
  };

  // ---- w/cm and specified strength
  limitCheck(
    'max_wcm',
    'max_wcm',
    'max',
    'ratio',
    blend.wcm,
    blend.waterBlocker ?? {
      code: 'input_missing',
      detail: 'no cementitious material in the design',
    },
    'ratio.wcm',
  );
  limitCheck(
    'min_fc',
    'min_fc',
    'min',
    'MPa',
    strength.cylinderMpa,
    strength.blocker,
    'strength.fc_cylinder',
    "specified f'c on the cylinder basis against the exposure minimum",
  );

  // ---- chlorides (water-soluble Cl⁻ as % of cementitious, from aggregates, water and admixtures)
  const clReq = ['max_cl_nonprestressed', 'max_cl_prestressed']
    .map((n) => reqOf(resolved, n))
    .filter(Boolean);
  if (clReq.length > 0) {
    const cl = chlorides(c);
    for (const name of ['max_cl_nonprestressed', 'max_cl_prestressed']) {
      const r = reqOf(resolved, name);
      if (!r) continue;
      checked.add(name);
      const lim = num(r.value);
      const bad = unusable(r);
      const id = name === 'max_cl_prestressed' ? 'cl.prestressed' : 'cl.nonprestressed';
      const note = 'cement and SCM chloride are not in the test schema and are not counted';
      if (bad || lim === null) {
        checks.push(
          make({
            id,
            requirement: name,
            req: r,
            units: '%',
            op: '<=',
            value: cl.pct,
            limit: null,
            pass: null,
            blocker: bad ?? {
              code: 'rule_not_on_file',
              detail: `${name}: no numeric value on file`,
            },
            traceKey: 'chloride.pct',
            nearLimitPct: nearPct,
            note,
          }),
        );
        continue;
      }
      // A partial sum already above the limit is a definite failure; below it, missing data keep it open.
      const known = cl.pct;
      if (known !== null && known > lim + EPS)
        checks.push(
          make({
            id,
            requirement: name,
            req: r,
            units: '%',
            op: '<=',
            value: known,
            limit: lim,
            pass: false,
            traceKey: 'chloride.pct',
            nearLimitPct: nearPct,
            note,
          }),
        );
      else
        checks.push(
          make({
            id,
            requirement: name,
            req: r,
            units: '%',
            op: '<=',
            value: known,
            limit: lim,
            pass: cl.blocker ? null : known === null ? null : true,
            blocker: cl.blocker,
            traceKey: 'chloride.pct',
            nearLimitPct: nearPct,
            near: known !== null && !cl.blocker ? nearMax(known, lim) : null,
            note,
          }),
        );
    }
  }

  // ---- SCM limits
  const scmFigure: Record<string, string> = {
    'scm.max.total_pct': 'scm.pct.total',
    'scm.max.fly_ash_pozzolan_pct': 'scm.pct.fly_ash_pozzolan',
    'scm.max.slag_pct': 'scm.pct.slag',
    'scm.max.silica_fume_pct': 'scm.pct.silica_fume',
    'scm.max.fly_ash_silica_fume_pct': 'scm.pct.fly_ash_silica_fume',
  };
  for (const [name, fig] of Object.entries(scmFigure)) {
    const v = c.tr.num(fig);
    const typed = blend.scmTypeMissing.length === 0;
    limitCheck(
      name,
      name,
      'max',
      '%',
      isNum(v) ? v : null,
      typed
        ? { code: 'input_missing', detail: 'the design has no cementitious material' }
        : {
            code: 'input_missing',
            detail: `SCM type is not recorded for ${blend.scmTypeMissing.join(', ')}`,
          },
      fig,
    );
  }

  // ---- cement properties for sulfate exposure
  const sulfate = reqOf(resolved, 'sulfate_cement');
  if (sulfate) {
    checked.add('sulfate_cement');
    const bad = unusable(sulfate);
    const allowed = Array.isArray(sulfate.value) ? (sulfate.value as string[]) : null;
    const moderate = rules.number('SHARED', 'cement.equivalence.moderate.max_c3a_pct');
    const high = rules.number('SHARED', 'cement.equivalence.high.max_c3a_pct');
    const cements = blend.lines.filter((l) => l.category === 'cement');
    let blocker: EvalBlocker | null = bad;
    if (!blocker && (moderate === null || high === null))
      blocker = {
        code: 'rule_not_on_file',
        detail: 'cement.equivalence C3A limits are not on file',
      };
    if (!blocker && cements.length === 0)
      blocker = { code: 'input_missing', detail: 'the design has no cement' };
    let lowest: Klass | null = null;
    const noC3a: string[] = [];
    if (!blocker)
      for (const l of cements) {
        const c3a = numProp(l.material, 'c3a_pct');
        if (c3a === undefined) {
          noC3a.push(l.material?.nameEn ?? l.id);
          continue;
        }
        const k: Klass = c3a <= high! ? 'high' : c3a <= moderate! ? 'moderate' : 'none';
        if (lowest === null || RANK[k] < RANK[lowest]) lowest = k;
        tr.add(
          `cement.class.${l.id}`,
          k,
          'class',
          'C3A ≤ high limit → high; ≤ moderate limit → moderate; else none',
          {
            c3a,
            moderateMax: moderate,
            highMax: high,
          },
          { ruleKey: 'cement.equivalence.high.max_c3a_pct' },
        );
      }
    if (!blocker && noC3a.length > 0)
      blocker = { code: 'input_missing', detail: `C3A is not on file for ${noC3a.join(', ')}` };
    const minRank = allowed ? Math.min(...allowed.map((a) => RANK[a as Klass] ?? 3)) : null;
    checks.push(
      make({
        id: 'sulfate_cement',
        requirement: 'sulfate_cement',
        req: sulfate,
        units: 'class',
        op: 'in',
        value: lowest,
        limit: allowed,
        pass: blocker || lowest === null || minRank === null ? null : RANK[lowest] >= minRank,
        blocker,
        traceKey: null,
        nearLimitPct: nearPct,
        note: 'judged by C3A of every cement line, not by its label; a more resistant cement satisfies a lower class',
      }),
    );
  }
  const sc = reqOf(resolved, 'scm_required');
  if (sc) {
    checked.add('scm_required');
    const allowed = Array.isArray(sc.value) ? (sc.value as string[]) : null;
    const bad = unusable(sc);
    const present = new Set<string>();
    if (blend.scmByType['fly_ash'] || blend.scmByType['natural_pozzolan']) present.add('pozzolan');
    if (blend.scmByType['ggbs']) present.add('slag');
    const blocker =
      bad ??
      (blend.scmTypeMissing.length > 0
        ? {
            code: 'input_missing' as const,
            detail: `SCM type is not recorded for ${blend.scmTypeMissing.join(', ')}`,
          }
        : null);
    checks.push(
      make({
        id: 'scm_required',
        requirement: 'scm_required',
        req: sc,
        units: 'set',
        op: 'in',
        value: [...present].sort().join(',') || 'none',
        limit: allowed,
        pass: blocker || !allowed ? null : allowed.some((a) => present.has(a)),
        blocker,
        traceKey: null,
        nearLimitPct: nearPct,
        note: 'presence of the required SCM only; the performance test of the cement–SCM combination is not evaluated',
      }),
    );
  }

  // ---- calcium chloride prohibition
  const cacl = reqOf(resolved, 'cacl2_prohibited');
  if (cacl) {
    checked.add('cacl2_prohibited');
    const bad = unusable(cacl);
    const adm = blend.lines.filter((l) => l.category === 'admixture');
    const untyped = adm.filter((l) => propOf(l.material, 'type') === undefined);
    const acc = adm.filter((l) => ['C', 'E'].includes(String(propOf(l.material, 'type'))));
    const blocker =
      bad ??
      (untyped.length > 0
        ? {
            code: 'input_missing' as const,
            detail: `admixture type is not recorded for ${untyped.map((l) => l.material?.nameEn ?? l.id).join(', ')}`,
          }
        : null);
    checks.push(
      make({
        id: 'cacl2_prohibited',
        requirement: 'cacl2_prohibited',
        req: cacl,
        units: 'none',
        op: 'is',
        value: acc.length > 0 ? 'accelerating admixture present' : 'no accelerating admixture',
        limit: cacl.value === true ? true : cacl.value === false ? false : null,
        pass:
          blocker || typeof cacl.value !== 'boolean' ? null : cacl.value ? acc.length === 0 : true,
        blocker,
        traceKey: null,
        nearLimitPct: nearPct,
        note: 'accelerating admixtures (ASTM C494 Types C and E) may contain calcium chloride; their composition is not on file',
      }),
    );
  }

  // ---- air content
  const airReq = reqOf(resolved, 'air_target_pct');
  if (airReq) {
    checked.add('air_target_pct');
    checked.add('air_tolerance_pct');
    const tol = reqOf(resolved, 'air_tolerance_pct');
    const bad =
      unusable(airReq) ??
      (tol
        ? unusable(tol)
        : { code: 'rule_not_on_file' as const, detail: 'air tolerance is not on file' });
    let blocker: EvalBlocker | null = bad;
    let target: number | null = null;
    let tolerance: number | null = null;
    if (!blocker && s.request.nmasMm === null)
      blocker = { code: 'input_missing', detail: 'NMAS is not stated' };
    if (!blocker && s.request.airPct === null)
      blocker = { code: 'input_missing', detail: 'air content is not stated in the design' };
    if (!blocker) {
      const t = lookupTable(airReq.value as never, { col: s.request.nmasMm! });
      if (t.status !== 'ok')
        blocker = {
          code: t.status === 'out_of_domain' ? 'out_of_domain' : 'rule_not_on_file',
          detail: 'air target is not available for this NMAS',
        };
      else {
        target = t.value;
        tolerance = num(tol?.value);
        if (tolerance === null)
          blocker = { code: 'rule_not_on_file', detail: 'air tolerance is not on file' };
      }
    }
    if (target !== null && tolerance !== null) {
      tr.add(
        'air.target_pct',
        target,
        '%',
        'air target table at the NMAS, interpolated',
        { nmas: s.request.nmasMm },
        { ruleKey: airReq.governing?.ruleKey ?? 'air_target_pct' },
      );
      tr.add(
        'air.tolerance_pct',
        tolerance,
        '%',
        'air tolerance (±)',
        {},
        { ruleKey: tol?.governing?.ruleKey ?? 'air_tolerance_pct' },
      );
    }
    const v = s.request.airPct;
    const pass =
      blocker || v === null || target === null || tolerance === null
        ? null
        : Math.abs(v - target) <= tolerance + EPS;
    checks.push(
      make({
        id: 'air',
        requirement: 'air_target_pct',
        req: airReq,
        units: '%',
        op: 'abs<=',
        value: v,
        limit: target,
        pass,
        blocker,
        traceKey: 'air.target_pct',
        nearLimitPct: nearPct,
        near:
          pass && v !== null && target !== null && tolerance !== null
            ? Math.abs(v - target) >= tolerance * (1 - (nearPct ?? 0) / 100)
            : null,
        ...(tolerance !== null ? { note: `target ± ${round6(tolerance)} %` } : {}),
      }),
    );
  }

  // ---- yield and product dosage (engineering checks, no code rule behind them)
  const delta = blend.totalVolume === null ? null : blend.totalVolume - 1;
  checks.push(
    make({
      id: 'yield',
      requirement: 'yield',
      req: undefined,
      units: 'm3',
      op: 'abs<=',
      value: isNum(delta) ? delta : null,
      limit: s.settings.yieldTolerance,
      pass: isNum(delta) ? Math.abs(delta) <= s.settings.yieldTolerance + EPS : null,
      blocker:
        blend.missingMinimum.length > 0
          ? {
              code: 'input_missing',
              detail: `specific gravity is missing for ${blend.missingMinimum.map((m) => m.materialId).join(', ')}`,
            }
          : (blend.airBlocker ?? { code: 'input_missing', detail: 'volume could not be computed' }),
      traceKey: 'yield.delta',
      nearLimitPct: nearPct,
      near: isNum(delta) ? nearMax(Math.abs(delta), s.settings.yieldTolerance) : null,
    }),
  );
  for (const l of blend.lines.filter((x) => x.category === 'admixture')) {
    const dose = blend.dosagePct.get(l.id);
    const min = numProp(l.material, 'min_dosage_pct');
    const max = numProp(l.material, 'max_dosage_pct');
    const blocker: EvalBlocker | null =
      dose === undefined
        ? { code: 'input_missing', detail: 'no cementitious material to base the dosage on' }
        : min === undefined && max === undefined
          ? { code: 'input_missing', detail: 'the product dosage range is not on file' }
          : null;
    checks.push(
      make({
        id: `admixture_dosage.${l.id}`,
        requirement: 'admixture.dosage',
        req: undefined,
        units: '%',
        op: 'in',
        value: dose ?? null,
        limit: null,
        pass:
          blocker || dose === undefined
            ? null
            : (min === undefined || dose >= min - EPS) && (max === undefined || dose <= max + EPS),
        blocker,
        traceKey: `dosage.${l.id}`,
        nearLimitPct: nearPct,
        note: `product range ${min ?? '–'}–${max ?? '–'} %`,
      }),
    );
  }

  // ---- requirement rows (what the codes resolved to, and whether a design-stage check exists)
  const requirements: RequirementRow[] = [];
  const SKIP: [RegExp, string][] = [
    [/^accept\./, 'field_acceptance'],
    [/^(slump_tolerance_mm|tolerance\.slump\.)/, 'field_tolerance'],
    [/^nmas\.max_fraction\./, 'geometry_not_provided'],
    [/^grading\./, 'grading_envelope_not_evaluated'],
    [/^hot\./, 'placement_conditions_not_provided'],
  ];
  for (const r of resolved.requirements) {
    if (['parameter', 'value'].includes(r.kind)) continue;
    if (r.kind === 'table' && !checked.has(r.requirement)) continue;
    const skip =
      SKIP.find(([re]) => re.test(r.requirement))?.[1] ??
      (r.kind === 'info' ? 'information' : null);
    const isChecked = checked.has(r.requirement);
    requirements.push({
      requirement: r.requirement,
      kind: r.kind,
      units: r.units,
      value: r.value,
      status: r.status,
      governing: governingRef(r),
      verified: r.verified,
      issues: r.issues.map((i) => i.code),
      checked: isChecked,
      ...(!isChecked ? { skippedReason: skip ?? 'no_design_check' } : {}),
    });
    // A context gap on a requirement we do check is not hidden: the verdict cannot be a clean pass.
    if (isChecked && r.issues.some((i) => i.code === 'context_missing'))
      quality.push({
        code: 'context_missing',
        severity: 'blocker',
        detail: r.issues.find((i) => i.code === 'context_missing')!.message,
        evidence: ['INPUT_MISSING'],
      });
  }
  for (const i of resolved.issues)
    if (i.code === 'context_missing' && !checked.has(i.requirement))
      quality.push({ code: 'context_missing', severity: 'info', detail: i.message });

  // A check only points at a trace entry that exists (a blocked figure has none).
  for (const ck of checks)
    if (ck.traceKey !== null && !(ck.traceKey in tr.figures)) ck.traceKey = null;
  checks.sort((a, b) => a.id.localeCompare(b.id));
  return { checks, requirements, quality, assumptions };
}

/** Partial chloride sum from aggregates, water and admixtures; `pct` is null only when no cementitious exists. */
function chlorides(c: CheckCtx): { pct: number | null; blocker: EvalBlocker | null } {
  const { blend, tr } = c;
  let kg = 0;
  const missing: string[] = [];
  const inputs: Record<string, number | string | null> = {};
  for (const l of blend.lines) {
    if (l.category === 'fine_agg' || l.category === 'coarse_agg') {
      const p = numProp(l.material, 'chlorides_pct');
      if (p === undefined) missing.push(`${l.material?.nameEn ?? l.id}: chlorides_pct`);
      else {
        kg += (l.kg * p) / 100;
        inputs[`cl.${l.id}`] = (l.kg * p) / 100;
      }
    } else if (l.category === 'water') {
      const mgL = numProp(l.material, 'chloride_mg_l');
      if (mgL === undefined) missing.push(`${l.material?.nameEn ?? l.id}: chloride_mg_l`);
      else {
        const litres = l.kg / (l.sg ?? 1);
        kg += (mgL * litres) / 1e6;
        inputs[`cl.${l.id}`] = (mgL * litres) / 1e6;
      }
    } else if (l.category === 'admixture') {
      const p = numProp(l.material, 'chloride_pct');
      if (p === undefined) missing.push(`${l.material?.nameEn ?? l.id}: chloride_pct`);
      else {
        kg += (l.kg * p) / 100;
        inputs[`cl.${l.id}`] = (l.kg * p) / 100;
      }
    }
  }
  const pct = blend.binderKg > 0 ? (kg / blend.binderKg) * 100 : null;
  tr.add(
    'chloride.kg',
    kg,
    'kg/m3',
    'Σ water-soluble Cl⁻ from aggregates (mass × %), water (mg/L × L) and admixtures (mass × %)',
    inputs,
  );
  tr.add(
    'chloride.pct',
    pct,
    '%',
    'Cl⁻ kg ÷ (cement + SCM) × 100',
    { chloride: kg, binder: blend.binderKg },
    missing.length ? { evidence: ['INPUT_MISSING'] } : {},
  );
  return {
    pct,
    blocker:
      blend.binderKg <= 0
        ? { code: 'input_missing', detail: 'the design has no cementitious material' }
        : missing.length > 0
          ? { code: 'input_missing', detail: `chloride content not on file: ${missing.join('; ')}` }
          : null,
  };
}

export function verdictOf(
  checks: CheckResult[],
  quality: QualityItem[],
): 'fail' | 'incomplete' | 'pass' {
  if (checks.some((x) => x.status === 'fail')) return 'fail';
  if (checks.some((x) => x.status === 'not_evaluated')) return 'incomplete';
  if (quality.some((q) => q.code === 'context_missing' && q.severity === 'blocker'))
    return 'incomplete';
  return 'pass';
}
