// Turns an optimizer request into a prepared search context: which materials are usable (and why the others
// are not), the governing limits, the baselines and the characteristics. Every gap is a named blocker.
import { resolve, type Context, type ResolveResult } from '@khalta/rules';
import { fineModulus, type GradationPoint } from '../materials/gradation';
import { toJodPerKg } from '../prices/convert';
import { entrappedAir, strengthAdequacy, tableWater } from '../evaluate/baselines';
import { passingAt } from '../evaluate/blend';
import { computeStrength } from '../evaluate/strength';
import { evaluationContext } from '../evaluate/select';
import type { SnapshotMaterial, StrengthBlock } from '../evaluate/types';
import { isNum, numProp, propOf, RuleIndex, sgField, Tracer } from '../evaluate/util';
import type { ResolvedCharacteristic } from '../characteristics/resolve';
import { dmaxFor, finesOf, gradingSieves } from './measure';
import { readGuardrails, type GuardrailParams } from './params';
import type { OptimizerBlocker, OptimizerInput } from './types';

export interface Mat {
  id: string;
  name: string;
  category: SnapshotMaterial['category'];
  m: SnapshotMaterial;
  sg: number;
  /** JOD per kg delivered. */
  jodPerKg: number;
}

export interface AdmixLevel {
  /** Dosage, % of cementitious mass. */
  dosagePct: number;
  waterReductionPct: number;
  /** 1-based level of the product's water-reduction table. */
  level: number;
}
export interface AdmixMat extends Mat {
  solidsPct: number;
  countsAsWater: boolean;
  chloridePct: number | null;
  levels: AdmixLevel[];
}
export interface AggMat extends Mat {
  kind: 'fine' | 'coarse';
  points: GradationPoint[];
  rho: number; // kg per m³ of solid volume (SG × 1000)
  chloridePct: number | null;
  finer75Pct: number | null;
  /** Fineness modulus of this aggregate on the FM series (null when the series is not covered). */
  fm: number | null;
  /** Dry-rodded unit weight, kg/m³ (null when not on file). */
  druw: number | null;
}
export interface CementMat extends Mat {
  c3a: number | null;
}
export interface ScmMat extends Mat {
  type: string;
}

export interface ScmLimits {
  /** Highest SCM % this product may take (min over every applicable limit), or null when none is on file. */
  maxPct: number | null;
  /** Names of the limits that apply, for the report. */
  governing: string[];
}

export interface Prepared {
  input: OptimizerInput;
  rules: RuleIndex;
  ctx: Context;
  resolved: ResolveResult;
  strength: StrengthBlock;
  /** ACI 211.1 w/c for f'cr (information baseline; used as a ceiling when it is the tighter one). */
  baselineWc: number;
  /** Tightest durability max w/cm, or null when the exposure sets none. */
  durabilityWcm: number | null;
  /** Ceiling the LP uses: min(baseline, durability) − robustness margin. */
  wcmCeiling: number;
  baseWaterKg: Map<number, number>;
  slumpMm: number;
  pumpable: boolean;
  water: Mat;
  cements: CementMat[];
  scms: ScmMat[];
  admixtures: AdmixMat[];
  fines: AggMat[];
  coarses: AggMat[];
  nmasList: number[];
  airByNmas: Map<number, number>;
  chlorideLimitPct: number | null;
  scmRequired: string[] | null;
  guard: GuardrailParams;
  chars: ResolvedCharacteristic[];
  excluded: { materialId: string; reason: string }[];
  notes: { code: string; detail: string }[];
  scmLimits: (scm: ScmMat) => ScmLimits;
}

const RANK = { none: 0, moderate: 1, high: 2 } as const;
type Klass = keyof typeof RANK;

const SCM_LIMIT_KEYS: [string, string[]][] = [
  ['scm.max.total_pct', ['fly_ash', 'natural_pozzolan', 'ggbs', 'silica_fume']],
  ['scm.max.fly_ash_pozzolan_pct', ['fly_ash', 'natural_pozzolan']],
  ['scm.max.slag_pct', ['ggbs']],
  ['scm.max.silica_fume_pct', ['silica_fume']],
  ['scm.max.fly_ash_silica_fume_pct', ['fly_ash', 'natural_pozzolan', 'silica_fume']],
];

export type PrepareResult =
  | { ok: true; prepared: Prepared }
  | { ok: false; blockers: OptimizerBlocker[]; excluded: { materialId: string; reason: string }[] };

export function prepare(input: OptimizerInput): PrepareResult {
  const base = input.base;
  const blockers: OptimizerBlocker[] = [];
  const excluded: { materialId: string; reason: string }[] = [];
  const notes: Prepared['notes'] = [];
  const rules = new RuleIndex(base.rules);
  const req = base.request;
  const block = (b: OptimizerBlocker) => blockers.push(b);
  const stop = (): PrepareResult => ({ ok: false, blockers, excluded });

  // ---- request
  if (base.request.exposure.some((e) => ['F1', 'F2', 'F3'].includes(e)))
    block({
      code: 'not_supported',
      subject: 'exposure F1–F3',
      detail:
        'Air-entrained designs (exposure F1–F3) are not supported by the optimizer yet: the air-entrained ACI 211.1 tables are not on file',
    });
  if (req.slumpMm === null)
    block({ code: 'input_missing', subject: 'slump', detail: 'The request has no slump' });
  if (req.fcMpa === null || req.basis === null)
    block({
      code: 'input_missing',
      subject: 'specified strength',
      detail: 'The request has no specified strength or strength basis',
    });

  // ---- strength and baselines
  const tr = new Tracer();
  const strength = computeStrength(
    {
      request: req,
      mode: base.mode,
      safetyMarginMpa: base.settings.safetyMarginMpa,
      extraMarginMpa: fixedNum(base.characteristics, 'extra_margin_mpa'),
      fixedFcrMpa: fixedNum(base.characteristics, 'fcr_mpa'),
      stats: base.strengthRecords,
    },
    rules,
    tr,
  );
  if (strength.fcrMpa === null)
    block({
      code: 'input_missing',
      subject: "f'cr",
      detail: `The required average strength cannot be determined: ${strength.blocker?.detail ?? 'unknown reason'}`,
    });
  const ctx = evaluationContext(req, strength.cylinderMpa);
  const resolved = resolve(base.rules, {
    mode: base.mode,
    context: ctx,
    projectOverrides: base.projectOverrides,
    tablePolicy: base.tablePolicy,
  });

  let baselineWc = 0;
  if (strength.fcrMpa !== null) {
    const ad = strengthAdequacy(strength.fcrMpa, null, rules, ctx, new Tracer(), {
      input: base.strengthModel,
      request: base.request,
    });
    if (ad.baselineWc === null)
      block({
        code: ad.blocker?.code === 'out_of_domain' ? 'out_of_domain' : 'rule_not_on_file',
        subject: 'prop.wc_strength',
        detail: `The ACI 211.1 w/c baseline for f'cr is unavailable: ${ad.blocker?.detail ?? 'unknown reason'}`,
      });
    else baselineWc = ad.governingWc ?? ad.baselineWc;
  }

  // ---- limits that bind the mix; every one that applies must be usable
  const reqOf = (n: string) => resolved.requirements.find((r) => r.requirement === n);
  const usable = (n: string): unknown | undefined => {
    const r = reqOf(n);
    if (!r) return undefined;
    if (r.value === null || r.status === 'blocked') {
      block({
        code: 'rule_not_on_file',
        subject: n,
        detail: `${n}: ${r.issues[0]?.message ?? 'no value on file'}; the optimizer cannot respect a limit it does not have`,
      });
      return undefined;
    }
    return r.value;
  };
  let durabilityWcm: number | null = null;
  const mw = usable('max_wcm');
  if (isNum(mw)) durabilityWcm = mw;
  const minFc = usable('min_fc');
  if (isNum(minFc) && strength.cylinderMpa !== null && strength.cylinderMpa < minFc - 1e-9)
    block({
      code: 'request_infeasible',
      subject: 'min_fc',
      detail: `The specified strength (${strength.cylinderMpa} MPa on the cylinder basis) is below the ${minFc} MPa the exposure requires; no mix can fix that, so the request itself must change`,
    });
  let chlorideLimitPct: number | null = null;
  for (const n of ['max_cl_nonprestressed', 'max_cl_prestressed']) {
    const v = usable(n);
    if (isNum(v)) chlorideLimitPct = chlorideLimitPct === null ? v : Math.min(chlorideLimitPct, v);
  }
  const sulfate = usable('sulfate_cement');
  const scmReq = usable('scm_required');
  const cacl = usable('cacl2_prohibited');
  const scmCaps = new Map<string, number>();
  for (const [key] of SCM_LIMIT_KEYS) {
    const v = usable(key);
    if (isNum(v)) scmCaps.set(key, v);
  }

  // ---- engineering parameters
  const codes = base.mode === 'BOTH' ? (['ACI', 'JS'] as const) : ([base.mode] as const);
  const gp = readGuardrails(rules, { needPumpable: req.pumpable === true, codes });
  blockers.push(...gp.blockers);
  if (gp.params && gp.params.base.gradingBandPct - gp.params.base.gradingMarginPts <= 0)
    block({
      code: 'parameter_missing',
      subject: 'eng.grading.target.band_pct',
      detail:
        'The grading band is not wider than the grading margin, so no combined grading can qualify',
    });
  const wcmCapped = [baselineWc > 0 ? baselineWc : null, durabilityWcm].filter(
    (x): x is number => x !== null,
  );
  const wcmMargin = gp.params?.base.wcmMargin ?? 0;
  const wcmCeiling = (wcmCapped.length ? Math.min(...wcmCapped) : 0) - wcmMargin;
  if (wcmCapped.length && wcmCeiling <= 0)
    block({
      code: 'out_of_domain',
      subject: 'eng.margin.wcm',
      detail: 'The w/cm ceiling minus the robustness margin is not positive',
    });

  // ---- NMAS list
  const nmasChar = base.characteristics.find((c) => c.key === 'nmas_mm');
  let nmasList: number[] = [];
  if (req.nmasMm !== null) nmasList = [req.nmasMm];
  else if (nmasChar?.spec.mode === 'fixed' && isNum(nmasChar.spec.value))
    nmasList = [nmasChar.spec.value];
  else if (nmasChar?.spec['mode'] === 'list') nmasList = [...(nmasChar.spec['values'] as number[])];
  else
    block({
      code: 'input_missing',
      subject: 'NMAS',
      detail: 'The request states no nominal maximum aggregate size (and no allowed list)',
    });
  nmasList = [...new Set(nmasList)].sort((a, b) => a - b);

  // ---- baselines per NMAS
  const baseWaterKg = new Map<number, number>();
  const airByNmas = new Map<number, number>();
  if (req.slumpMm !== null)
    for (const n of nmasList) {
      const r2 = { ...req, nmasMm: n };
      const w = tableWater(r2, rules, ctx);
      if (!w.ok)
        block({
          code: w.blocker.code === 'out_of_domain' ? 'out_of_domain' : 'rule_not_on_file',
          subject: 'prop.water',
          detail: `ACI 211.1 mixing water at NMAS ${n} mm: ${w.blocker.detail}`,
        });
      else baseWaterKg.set(n, w.base);
      const a = entrappedAir(r2, rules, ctx);
      if ('blocker' in a)
        block({
          code: 'rule_not_on_file',
          subject: 'prop.air_entrapped',
          detail: `Entrapped air at NMAS ${n} mm: ${a.blocker.detail}`,
        });
      else airByNmas.set(n, a.value);
    }

  // ---- materials
  const allowed = (id: string) => {
    const m = input.materials;
    if (m?.exclude?.includes(id)) return 'excluded by the request';
    if (m?.include && m.include.length > 0 && !m.include.includes(id))
      return 'not in the request’s include list';
    return null;
  };
  const drop = (m: SnapshotMaterial, reason: string) => excluded.push({ materialId: m.id, reason });
  const priceOf = (m: SnapshotMaterial): number | string => {
    const p = m.price;
    if (p.status === 'unavailable') return 'no price in force at this plant';
    if (p.status === 'ambiguous')
      return 'several suppliers have a price; a preferred supplier is needed';
    const conv = toJodPerKg({
      price: p.price,
      unit: p.unit,
      sg: numProp(m, sgField(m.category)) ?? null,
    });
    if (!conv.ok) return `the price cannot be converted to JOD/kg (${conv.reason})`;
    return Number(conv.jodPerKg);
  };
  const sulfateAllowed = Array.isArray(sulfate) ? (sulfate as string[]) : null;
  const moderate = rules.number('SHARED', 'cement.equivalence.moderate.max_c3a_pct');
  const high = rules.number('SHARED', 'cement.equivalence.high.max_c3a_pct');
  const minRank = sulfateAllowed
    ? Math.min(...sulfateAllowed.map((a) => RANK[a as Klass] ?? 3))
    : null;
  if (sulfateAllowed && (moderate === null || high === null))
    block({
      code: 'rule_not_on_file',
      subject: 'cement.equivalence',
      detail: 'The C₃A limits that map a cement to a sulfate-resistance class are not on file',
    });

  const water: Mat[] = [];
  const cements: CementMat[] = [];
  const scms: ScmMat[] = [];
  const admixtures: AdmixMat[] = [];
  const fines: AggMat[] = [];
  const coarses: AggMat[] = [];
  const sieveNeeds = gp.params
    ? [
        ...new Set([
          ...gp.params.base.fmSieves,
          0.3,
          2.36,
          9.5,
          ...nmasList.flatMap((n) => gradingSieves(dmaxFor(n))),
        ]),
      ]
    : [];

  for (const m of base.materials) {
    const why = allowed(m.id);
    if (why) {
      drop(m, why);
      continue;
    }
    if (!['water', 'cement', 'scm', 'admixture', 'fine_agg', 'coarse_agg'].includes(m.category)) {
      drop(m, `${m.category} is not used by the optimizer`);
      continue;
    }
    if (!m.test) {
      drop(m, 'no test data on file');
      continue;
    }
    if (m.test.freshness === 'expired') {
      drop(m, `test v${m.test.version} is past its validity`);
      continue;
    }
    const price = priceOf(m);
    if (typeof price === 'string') {
      drop(m, price);
      continue;
    }
    const sg = m.category === 'water' ? (numProp(m, 'sg') ?? 1) : numProp(m, sgField(m.category));
    if (sg === undefined) {
      drop(m, `${sgField(m.category)} is not on file`);
      continue;
    }
    const mat: Mat = { id: m.id, name: m.nameEn, category: m.category, m, sg, jodPerKg: price };
    switch (m.category) {
      case 'water': {
        if (chlorideLimitPct !== null && numProp(m, 'chloride_mg_l') === undefined) {
          drop(m, 'chloride (mg/L) is not on file and a chloride limit applies');
          break;
        }
        water.push(mat);
        break;
      }
      case 'cement': {
        const c3a = numProp(m, 'c3a_pct') ?? null;
        if (sulfateAllowed && minRank !== null && moderate !== null && high !== null) {
          if (c3a === null) {
            drop(m, 'C₃A is not on file and a sulfate exposure applies');
            break;
          }
          const k: Klass = c3a <= high ? 'high' : c3a <= moderate ? 'moderate' : 'none';
          if (RANK[k] < minRank) {
            drop(m, `C₃A ${c3a} % gives a ${k} sulfate-resistance class, below the required class`);
            break;
          }
        }
        cements.push({ ...mat, c3a });
        break;
      }
      case 'scm': {
        const t = propOf(m, 'scm_type');
        if (typeof t !== 'string') {
          drop(m, 'SCM type is not recorded');
          break;
        }
        if (t === 'limestone_filler') {
          drop(m, 'limestone filler is not counted as an SCM and is not optimized');
          break;
        }
        scms.push({ ...mat, type: t });
        break;
      }
      case 'admixture': {
        const solids = numProp(m, 'solids_pct');
        const conv = propOf(m, 'water_convention');
        const type = propOf(m, 'type');
        const table = propOf(m, 'water_reduction_table') as
          { dosage_pct: number; water_reduction_pct: number }[] | undefined;
        const cl = numProp(m, 'chloride_pct') ?? null;
        if (type === undefined) drop(m, 'admixture type is not recorded');
        else if (conv === undefined) drop(m, 'the water convention is not set');
        else if (conv === 'liquid_counts_as_water' && solids === undefined)
          drop(m, 'solids content is not on file, so its water cannot be counted');
        else if (!table || table.length < 1)
          drop(m, 'the dosage–water-reduction table is not on file');
        else if (chlorideLimitPct !== null && cl === null)
          drop(m, 'chloride is not on file and a chloride limit applies');
        else if (cacl === true && ['C', 'E'].includes(String(type)))
          drop(m, 'accelerating admixture (Type C/E) while calcium chloride is prohibited');
        else {
          const sorted = [...table].sort((a, b) => a.dosage_pct - b.dosage_pct);
          admixtures.push({
            ...mat,
            solidsPct: solids ?? 0,
            countsAsWater: conv === 'liquid_counts_as_water',
            chloridePct: cl,
            levels: sorted.map((p, i) => ({
              dosagePct: p.dosage_pct,
              waterReductionPct: p.water_reduction_pct,
              level: i + 1,
            })),
          });
        }
        break;
      }
      default: {
        const points = propOf(m, 'sieve_analysis') as GradationPoint[] | undefined;
        if (!points) {
          drop(m, 'sieve analysis is not on file');
          break;
        }
        const missing = sieveNeeds.filter((s) => passingAt(points, s) === null);
        if (missing.length > 0) {
          drop(m, `sieve analysis gives no % passing at ${missing.join(', ')} mm`);
          break;
        }
        const finer75 = numProp(m, 'finer_75um_pct') ?? null;
        const a: AggMat = {
          ...mat,
          kind: m.category === 'fine_agg' ? 'fine' : 'coarse',
          points,
          rho: sg * 1000,
          chloridePct: numProp(m, 'chlorides_pct') ?? null,
          finer75Pct: finer75,
          fm: null,
          druw: numProp(m, 'dry_rodded_unit_weight_kg_m3') ?? null,
        };
        if (gp.params) {
          const fmr = fineModulus(points, gp.params.base.fmSieves);
          a.fm = fmr.ok ? fmr.fm : null;
        }
        if (finesOf(a) === null) {
          drop(m, 'neither a 0.075 mm sieve nor finer-than-75-µm is on file');
          break;
        }
        if (chlorideLimitPct !== null && a.chloridePct === null) {
          drop(m, 'chloride is not on file and a chloride limit applies');
          break;
        }
        if (gp.params) {
          const limits =
            a.kind === 'fine' ? gp.params.base.fineLimits : gp.params.base.coarseLimits;
          const bad = limits.find((l) => {
            const p = passingAt(points, l.sieve_mm);
            return p === null || p < l.min_pct || p > l.max_pct;
          });
          if (bad) {
            drop(m, `does not meet the individual grading limits at ${bad.sieve_mm} mm`);
            break;
          }
        }
        (a.kind === 'fine' ? fines : coarses).push(a);
      }
    }
  }
  const byId = <T extends { id: string }>(xs: T[]) => xs.sort((a, b) => a.id.localeCompare(b.id));
  byId(cements);
  byId(scms);
  byId(admixtures);
  byId(fines);
  byId(coarses);
  if (water.length === 0)
    block({
      code: 'no_materials',
      subject: 'water',
      detail: 'No usable water material (tested, priced, in date)',
    });
  if (cements.length === 0)
    block({
      code: 'no_materials',
      subject: 'cement',
      detail: 'No usable cement (tested, priced, in date, sulfate class met)',
    });
  if (fines.length === 0)
    block({ code: 'no_materials', subject: 'fine aggregate', detail: 'No usable fine aggregate' });
  if (coarses.length === 0)
    block({
      code: 'no_materials',
      subject: 'coarse aggregate',
      detail: 'No usable coarse aggregate',
    });
  if (scmReq !== undefined && Array.isArray(scmReq)) {
    const ok = (t: string) =>
      (scmReq as string[]).some((a) =>
        a === 'pozzolan'
          ? t === 'fly_ash' || t === 'natural_pozzolan'
          : a === 'slag'
            ? t === 'ggbs'
            : false,
      );
    if (!scms.some((s) => ok(s.type)))
      block({
        code: 'no_materials',
        subject: 'scm_required',
        detail: `The exposure requires an SCM (${(scmReq as string[]).join(' or ')}) and none is usable`,
      });
  }
  if (coarses.some((c) => c.druw === null))
    notes.push({
      code: 'ca_volume_sanity_skipped',
      detail: `the ACI 211.1 coarse-volume sanity band is not applied: dry-rodded unit weight is missing for ${coarses
        .filter((c) => c.druw === null)
        .map((c) => c.name)
        .join(', ')}`,
    });
  if (water.length > 1) {
    notes.push({
      code: 'several_water',
      detail: `${water.length} water materials are usable; ${water[0]!.name} (first by id) is used`,
    });
  }
  if (blockers.length > 0 || !gp.params) return stop();

  const scmLimits = (scm: ScmMat): ScmLimits => {
    const applicable = SCM_LIMIT_KEYS.filter(
      ([k, types]) => scmCaps.has(k) && types.includes(scm.type),
    );
    return {
      maxPct: applicable.length ? Math.min(...applicable.map(([k]) => scmCaps.get(k)!)) : null,
      governing: applicable.map(([k]) => k),
    };
  };
  const prepared: Prepared = {
    input,
    rules,
    ctx,
    resolved,
    strength,
    baselineWc,
    durabilityWcm,
    wcmCeiling,
    baseWaterKg,
    slumpMm: req.slumpMm as number,
    pumpable: req.pumpable === true,
    water: byId(water)[0]!,
    cements,
    scms,
    admixtures,
    fines,
    coarses,
    nmasList,
    airByNmas,
    chlorideLimitPct,
    scmRequired: Array.isArray(scmReq) ? (scmReq as string[]) : null,
    guard: gp.params,
    chars: [...base.characteristics],
    excluded,
    notes,
    scmLimits,
  };
  return { ok: true, prepared };
}

function fixedNum(chars: readonly ResolvedCharacteristic[], key: string): number | null {
  const c = chars.find((x) => x.key === key && x.spec.mode === 'fixed');
  return c && typeof c.spec.value === 'number' ? c.spec.value : null;
}
