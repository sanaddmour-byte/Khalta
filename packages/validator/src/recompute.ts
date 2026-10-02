// The validator's own implementation of the evaluation arithmetic, from the snapshot alone. It reads the
// snapshot's rules (resolved by the shared rules resolver) and recomputes every figure, check status,
// strength, baseline, cost and characteristic row with exact rationals. It imports nothing from the
// evaluator's calculation modules and nothing from the optimizer.
import {
  effectiveValue,
  resolve,
  type ResolvedRequirement,
  type RuleRecord,
  type TableDefinition,
} from '@khalta/rules';
import type { EvaluationSnapshot, SnapshotMaterial } from '@khalta/engine';
import { ONE, R, Rat, sum, ZERO } from './rat';
import { look1d, look2dBins } from './tables';
import { divide, multiply, parseDecimal, roundTo } from '@khalta/engine/decimal';

export type Fig = number | string | null;
export interface ExpectedCheck {
  status: 'pass' | 'fail' | 'not_evaluated';
  value: number | string | null;
  limit: number | string[] | boolean | null;
  warning: 'near_limit' | null;
}
export interface Expected {
  figures: Map<string, Fig>;
  checks: Map<string, ExpectedCheck>;
  verdict: 'fail' | 'incomplete' | 'pass';
  strength: {
    cylinderMpa: number | null;
    fcrMpa: number | null;
    governing: string | null;
    branches: Map<string, number | null>;
  };
  adequacy: { baselineWc: number | null; comparison: string | null };
  water: {
    baseWaterKg: number | null;
    baselineWaterKg: number | null;
    reductionPct: number | null;
  };
  cost: {
    state: 'complete' | 'incomplete';
    total: string | null;
    subtotal: string;
    lines: Map<string, { jod: string | null; state: string }>;
  };
  minimumData: { ok: boolean; missing: string[] };
  chars: Map<string, { achieved: Fig; status: string }>;
  unverifiedUsed: boolean;
}

const EPS = R('0.000000001');
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const AE = ['F1', 'F2', 'F3'];

export function recompute(s: EvaluationSnapshot): Expected {
  const figures = new Map<string, Fig>();
  const fig = (k: string, v: Rat | string | null) => {
    figures.set(k, v === null ? null : typeof v === 'string' ? v : v.toNumber());
    return v;
  };
  const byRef = new Map<string, RuleRecord>(s.rules.map((r) => [`${r.ruleset}:${r.key}`, r]));
  const usedUnverified = { v: false };
  const rv = (rs: string, key: string): unknown | null => {
    const r = byRef.get(`${rs}:${key}`);
    if (!r) return null;
    const v = effectiveValue(r, byRef);
    if (v !== null && !r.verified) usedUnverified.v = true;
    return v;
  };
  const rn = (rs: string, key: string): Rat | null => {
    const v = rv(rs, key);
    return num(v) ? R(v) : null;
  };

  const mats = new Map<string, SnapshotMaterial>(s.materials.map((m) => [m.id, m]));
  const prop = (m: SnapshotMaterial | undefined, f: string): unknown => {
    const v = m?.test?.properties[f];
    return v === undefined || v === null || v === '' ? undefined : v;
  };
  const pn = (m: SnapshotMaterial | undefined, f: string): Rat | null => {
    const v = prop(m, f);
    return num(v) ? R(v) : null;
  };

  // ------------------------------------------------------------ strength basis and f'cr
  const rq = s.request;
  let cyl: Rat | null = null;
  if (rq.fcMpa !== null && rq.basis !== null) {
    if (rq.basis === 'cylinder') cyl = R(rq.fcMpa);
    else {
      const map = rv('SHARED', 'strength.basis_map');
      if (Array.isArray(map)) {
        const rows = map as { cylinder_mpa: number; cube_mpa: number; b_grade: string | null }[];
        const hit =
          rq.basis === 'cube'
            ? rows.find((r) => r.cube_mpa === rq.fcMpa)
            : rows.find((r) => r.b_grade === `B${rq.fcMpa}`);
        if (hit) cyl = R(hit.cylinder_mpa);
      }
    }
  }
  if (cyl !== null) fig('strength.fc_cylinder', cyl);

  const codes = s.mode === 'BOTH' ? ['ACI', 'JS'] : [s.mode];
  const branches = new Map<string, number | null>();
  const fcrByCode = new Map<string, Rat>();
  if (cyl !== null)
    for (const rs of codes) {
      let value: Rat | null = null;
      const st = s.strengthRecords;
      const minTests = rn(rs, 'fcr.statistical.min_tests');
      const window = rn(rs, 'fcr.statistical.fc_window_mpa');
      const thr = rn(rs, 'fcr.threshold_mpa');
      if (
        st &&
        minTests &&
        window &&
        R(st.n).gte(minTests) &&
        R(st.fcMpa).sub(cyl).abs().cmp(window) <= 0 &&
        thr
      ) {
        const table = rv(rs, 'fcr.statistical.n_factor') as TableDefinition | null;
        const nf = look1d(table, R(st.n));
        const le = cyl.cmp(thr) <= 0;
        const k = (n: string) => rn(rs, `fcr.statistical.${le ? 'le35' : 'gt35'}.${n}`);
        const k1 = k('k1');
        const k2 = k('k2');
        const third = le ? k('offset') : k('factor');
        if (nf.s === 'ok' && k1 && k2 && third) {
          const sd = R(st.sdMpa).mul(nf.v);
          const a = cyl.add(k1.mul(sd));
          const b = le ? cyl.add(k2.mul(sd)).sub(third) : third.mul(cyl).add(k2.mul(sd));
          value = a.gt(b) ? a : b;
        }
      }
      if (value === null) {
        const lower = rn(rs, 'fcr.no_data.lower_threshold_mpa');
        const upper = rn(rs, 'fcr.threshold_mpa');
        const lt = rn(rs, 'fcr.no_data.lt21.add');
        const mid = rn(rs, 'fcr.no_data.mid.add');
        const gf = rn(rs, 'fcr.no_data.gt35.factor');
        const ga = rn(rs, 'fcr.no_data.gt35.add');
        if (lower && upper && lt && mid && gf && ga)
          value =
            cyl.cmp(lower) < 0
              ? cyl.add(lt)
              : cyl.cmp(upper) <= 0
                ? cyl.add(mid)
                : gf.mul(cyl).add(ga);
      }
      branches.set(rs, value === null ? null : value.toNumber());
      if (value !== null) {
        fcrByCode.set(rs, value);
        fig(`fcr.${rs}`, value);
      }
    }
  const fixedOf = (key: string): Rat | null => {
    const c = s.characteristics.find((x) => x.key === key && x.spec.mode === 'fixed');
    return c && num(c.spec.value) ? R(c.spec.value) : null;
  };
  let fcrTotal: Rat | null = null;
  let governing: string | null = null;
  if (fcrByCode.size > 0) {
    let best: Rat | null = null;
    for (const [rs, v] of fcrByCode) {
      if (best === null || v.gt(best)) {
        best = v;
        governing = rs;
      }
    }
    const margin = s.settings.safetyMarginMpa === null ? ZERO : R(s.settings.safetyMarginMpa);
    const extra = fixedOf('extra_margin_mpa') ?? ZERO;
    const code = best!.add(margin).add(extra);
    const fixed = fixedOf('fcr_mpa');
    fcrTotal = fixed && fixed.gt(code) ? fixed : code;
    fig('fcr.governing', best);
    fig('fcr.total', fcrTotal);
  }

  // ------------------------------------------------------------ requirements
  const exposure = rq.exposure;
  const airEntrained = exposure.some((e) => AE.includes(e));
  const context: Record<string, unknown> = { exposure, air_entrained: airEntrained };
  if (rq.s3Option !== null) context['s3_option'] = rq.s3Option;
  if (rq.slumpMm !== null) context['slump_mm'] = rq.slumpMm;
  if (rq.nmasMm !== null) context['nmas_mm'] = rq.nmasMm;
  if (cyl !== null) context['fc_mpa'] = cyl.toNumber();
  const resolved = resolve(s.rules, {
    mode: s.mode,
    context,
    projectOverrides: s.projectOverrides,
    tablePolicy: s.tablePolicy,
  });
  const req = (n: string): ResolvedRequirement | undefined =>
    resolved.requirements.find((r) => r.requirement === n);
  const usable = (r: ResolvedRequirement | undefined) =>
    !!r && r.value !== null && r.status !== 'blocked';

  // ------------------------------------------------------------ blend
  type L = {
    id: string;
    m: SnapshotMaterial | undefined;
    cat: string;
    kg: Rat;
    sg: Rat | null;
    vol: Rat | null;
  };
  const lines: L[] = s.lines.map((l) => {
    const m = mats.get(l.materialId);
    const cat = m?.category ?? 'cement';
    const field = cat === 'fine_agg' || cat === 'coarse_agg' ? 'sg_ssd' : 'sg';
    let sg = pn(m, field);
    if (cat === 'water' && sg === null) sg = ONE;
    const kg = R(l.kgPerM3);
    return { id: l.materialId, m, cat, kg, sg, vol: sg === null ? null : kg.div(sg.mul(R(1000))) };
  });
  const missingMinimum = lines.filter((l) => l.sg === null).map((l) => l.id);
  const kgOf = (f: (l: L) => boolean) => sum(lines.filter(f).map((l) => l.kg));
  const cement = kgOf((l) => l.cat === 'cement');
  const scm = kgOf((l) => l.cat === 'scm');
  const binder = cement.add(scm);
  const scmBy: Record<string, Rat> = {};
  const scmUntyped: string[] = [];
  for (const l of lines.filter((x) => x.cat === 'scm')) {
    const t = prop(l.m, 'scm_type');
    if (typeof t !== 'string') scmUntyped.push(l.id);
    else scmBy[t] = (scmBy[t] ?? ZERO).add(l.kg);
  }

  let water = kgOf((l) => l.cat === 'water');
  let waterBlocked = false;
  const hasWaterLine = lines.some((l) => l.cat === 'water');
  const adm = lines.filter((l) => l.cat === 'admixture');
  for (const l of adm) {
    if (prop(l.m, 'water_convention') === 'liquid_counts_as_water') {
      const solids = pn(l.m, 'solids_pct');
      if (solids === null) waterBlocked = true;
      else water = water.add(l.kg.mul(ONE.sub(solids.div(R(100)))));
    }
  }
  if (!hasWaterLine) waterBlocked = true;
  const freeWater = waterBlocked ? null : water;
  fig('mass.water', freeWater);
  fig('mass.cement', cement);
  fig('mass.scm', scm);
  fig('mass.binder', binder);
  const wcm = freeWater !== null && binder.gt(ZERO) ? freeWater.div(binder) : null;
  fig('ratio.wcm', wcm);
  fig(
    'mass.fresh_density',
    kgOf(() => true),
  );

  // air
  const tableAt = (prefix: string): { def: TableDefinition | null; key: string | null } => {
    const cands = s.rules.filter(
      (r) => r.ruleset === 'ACI' && r.key.startsWith(prefix) && applies(r),
    );
    const r = cands[0];
    return r
      ? { def: rv('ACI', r.key) as TableDefinition | null, key: r.key }
      : { def: null, key: null };
  };
  const applies = (r: RuleRecord): boolean =>
    Object.entries(r.applies_to).every(([f, cond]) => {
      const v = context[f];
      if (v === undefined) return false; // undetermined is not "yes"
      if (Array.isArray(cond))
        return Array.isArray(v) ? v.some((x) => cond.includes(x)) : cond.includes(v);
      if (cond !== null && typeof cond === 'object') {
        if (typeof v !== 'number') return false;
        const c = cond as Record<string, number>;
        return (
          (c['gt'] === undefined || v > c['gt']) &&
          (c['gte'] === undefined || v >= c['gte']) &&
          (c['lt'] === undefined || v < c['lt']) &&
          (c['lte'] === undefined || v <= c['lte'])
        );
      }
      return cond === v;
    });
  let air: Rat | null = null;
  if (rq.airPct !== null) {
    air = R(rq.airPct);
  } else if (rq.nmasMm !== null) {
    const t = tableAt('prop.air_entrapped.');
    const r = look1d(t.def, R(rq.nmasMm));
    if (r.s === 'ok') air = r.v;
  }
  for (const l of lines) fig(`volume.${l.id}`, l.vol);
  fig('volume.air', air === null ? null : air.div(R(100)));
  const total =
    lines.every((l) => l.vol !== null) && air !== null
      ? sum(lines.map((l) => l.vol!)).add(air.div(R(100)))
      : null;
  fig('volume.total', total);
  fig('yield.delta', total === null ? null : total.sub(ONE));

  // SCM shares
  const typed = scmUntyped.length === 0 && binder.gt(ZERO);
  const pct = (kg: Rat) => kg.div(binder).mul(R(100));
  const t = (k: string) => scmBy[k] ?? ZERO;
  const pozz = t('fly_ash').add(t('natural_pozzolan'));
  fig('scm.pct.total', typed ? pct(pozz.add(t('ggbs')).add(t('silica_fume'))) : null);
  fig('scm.pct.fly_ash_pozzolan', typed ? pct(pozz) : null);
  fig('scm.pct.slag', typed ? pct(t('ggbs')) : null);
  fig('scm.pct.silica_fume', typed ? pct(t('silica_fume')) : null);
  fig('scm.pct.fly_ash_silica_fume', typed ? pct(pozz.add(t('silica_fume'))) : null);
  for (const l of lines.filter((x) => x.cat === 'scm'))
    fig(`scm.pct.line.${l.id}`, binder.gt(ZERO) ? pct(l.kg) : null);
  const dosage = new Map<string, Rat>();
  for (const l of adm)
    if (binder.gt(ZERO)) {
      const d = pct(l.kg);
      dosage.set(l.id, d);
      fig(`dosage.${l.id}`, d);
    }

  // aggregates
  const aggs = lines.filter((l) => l.cat === 'fine_agg' || l.cat === 'coarse_agg');
  const aggKg = sum(aggs.map((l) => l.kg));
  const fineKg = sum(aggs.filter((l) => l.cat === 'fine_agg').map((l) => l.kg));
  fig('agg.total_kg', aggKg);
  fig('agg.sand_ratio_mass_pct', aggKg.gt(ZERO) ? fineKg.div(aggKg).mul(R(100)) : null);
  const aggVol = aggs.every((l) => l.vol !== null) ? sum(aggs.map((l) => l.vol!)) : null;
  const fineVol = aggs.filter((l) => l.cat === 'fine_agg').every((l) => l.vol !== null)
    ? sum(aggs.filter((l) => l.cat === 'fine_agg').map((l) => l.vol!))
    : null;
  fig(
    'agg.sand_ratio_volume_pct',
    aggVol && aggVol.gt(ZERO) && fineVol ? fineVol.div(aggVol).mul(R(100)) : null,
  );
  for (const l of aggs)
    fig(`agg.share_pct.${l.id}`, aggKg.gt(ZERO) ? l.kg.div(aggKg).mul(R(100)) : null);
  fig('agg.paste_l', aggVol === null ? null : ONE.sub(aggVol).mul(R(1000)));

  // combined gradation
  type Pt = { sieve_mm: number; passing_pct: number };
  const passAt = (pts: Pt[], sv: number): Rat | null => {
    const e = pts.find((p) => p.sieve_mm === sv);
    if (e) return R(e.passing_pct);
    if (pts.some((p) => p.sieve_mm < sv && p.passing_pct === 100)) return R(100);
    if (pts.some((p) => p.sieve_mm > sv && p.passing_pct === 0)) return ZERO;
    return null;
  };
  const combined = (sv: number): Rat | null => {
    if (aggs.length === 0 || !aggKg.gt(ZERO)) return null;
    let acc = ZERO;
    for (const l of aggs) {
      const pts = prop(l.m, 'sieve_analysis') as Pt[] | undefined;
      const p = pts ? passAt(pts, sv) : null;
      if (p === null) return null;
      acc = acc.add(l.kg.mul(p));
    }
    return acc.div(aggKg);
  };
  const seriesRaw = rv('ENGINEERING', 'eng.fm.sieves');
  const series =
    Array.isArray(seriesRaw) && seriesRaw.every(num)
      ? (seriesRaw as number[])
      : [150, 75, 37.5, 19, 9.5, 4.75, 2.36, 1.18, 0.6, 0.3, 0.15];
  const known: Pt[] = [];
  for (const sv of series) {
    const p = combined(sv);
    if (p !== null) known.push({ sieve_mm: sv, passing_pct: p.toNumber() });
  }
  let fm: Rat | null = ZERO;
  for (const sv of series) {
    const hit = known.find((p) => p.sieve_mm === sv);
    if (hit) {
      fm = fm.add(R(100).sub(combined(sv)!));
      continue;
    }
    if (known.some((p) => p.sieve_mm < sv && p.passing_pct === 100)) continue;
    if (known.some((p) => p.sieve_mm > sv && p.passing_pct === 0)) {
      fm = fm.add(R(100));
      continue;
    }
    fm = null;
    break;
  }
  fig('agg.fm_combined', fm === null ? null : fm.div(R(100)));
  for (const c of s.characteristics.filter((x) => x.key === 'passing_pct'))
    fig(`agg.passing.${c.sub}`, combined(Number(c.sub)));

  // ------------------------------------------------------------ checks
  const near = s.settings.nearLimitPct === null ? null : R(s.settings.nearLimitPct);
  const nearMax = (v: Rat, lim: Rat) => near !== null && v.gte(lim.mul(ONE.sub(near.div(R(100)))));
  const nearMin = (v: Rat, lim: Rat) =>
    near !== null && v.cmp(lim.mul(ONE.add(near.div(R(100))))) <= 0;
  const checks = new Map<string, ExpectedCheck>();
  const lim = (r: ResolvedRequirement | undefined): Rat | null =>
    usable(r) && num(r!.value) ? R(r!.value as number) : null;
  const setCheck = (id: string, c: ExpectedCheck) => checks.set(id, c);
  const limitCheck = (id: string, name: string, dir: 'max' | 'min', value: Rat | null) => {
    const r = req(name);
    if (!r) return;
    const l = lim(r);
    if (l === null)
      return setCheck(id, {
        status: 'not_evaluated',
        value: value?.toNumber() ?? null,
        limit: null,
        warning: null,
      });
    if (value === null)
      return setCheck(id, {
        status: 'not_evaluated',
        value: null,
        limit: l.toNumber(),
        warning: null,
      });
    const pass = dir === 'max' ? value.lte(l.add(EPS)) : value.gte(l.sub(EPS));
    setCheck(id, {
      status: pass ? 'pass' : 'fail',
      value: value.toNumber(),
      limit: l.toNumber(),
      warning:
        pass && (dir === 'max' ? nearMax(value, l) : nearMin(value, l)) ? 'near_limit' : null,
    });
  };

  limitCheck('max_wcm', 'max_wcm', 'max', wcm);
  limitCheck('min_fc', 'min_fc', 'min', cyl);

  // chlorides
  if (req('max_cl_nonprestressed') || req('max_cl_prestressed')) {
    let kg = ZERO;
    let blocked = false;
    for (const l of lines) {
      if (l.cat === 'fine_agg' || l.cat === 'coarse_agg') {
        const p = pn(l.m, 'chlorides_pct');
        if (p === null) blocked = true;
        else kg = kg.add(l.kg.mul(p).div(R(100)));
      } else if (l.cat === 'water') {
        const mg = pn(l.m, 'chloride_mg_l');
        if (mg === null) blocked = true;
        else kg = kg.add(mg.mul(l.kg.div(l.sg ?? ONE)).div(R(1000000)));
      } else if (l.cat === 'admixture') {
        const p = pn(l.m, 'chloride_pct');
        if (p === null) blocked = true;
        else kg = kg.add(l.kg.mul(p).div(R(100)));
      }
    }
    const clPct = binder.gt(ZERO) ? kg.div(binder).mul(R(100)) : null;
    fig('chloride.kg', kg);
    fig('chloride.pct', clPct);
    const blockedAll = blocked || !binder.gt(ZERO);
    for (const [name, id] of [
      ['max_cl_nonprestressed', 'cl.nonprestressed'],
      ['max_cl_prestressed', 'cl.prestressed'],
    ] as const) {
      const r = req(name);
      if (!r) continue;
      const l = lim(r);
      if (l === null) {
        setCheck(id, {
          status: 'not_evaluated',
          value: clPct?.toNumber() ?? null,
          limit: null,
          warning: null,
        });
      } else if (clPct !== null && clPct.gt(l.add(EPS))) {
        setCheck(id, {
          status: 'fail',
          value: clPct.toNumber(),
          limit: l.toNumber(),
          warning: null,
        });
      } else if (blockedAll || clPct === null) {
        setCheck(id, {
          status: 'not_evaluated',
          value: clPct?.toNumber() ?? null,
          limit: l.toNumber(),
          warning: null,
        });
      } else {
        setCheck(id, {
          status: 'pass',
          value: clPct.toNumber(),
          limit: l.toNumber(),
          warning: nearMax(clPct, l) ? 'near_limit' : null,
        });
      }
    }
  }

  // SCM limits
  const scmFig: [string, string][] = [
    ['scm.max.total_pct', 'scm.pct.total'],
    ['scm.max.fly_ash_pozzolan_pct', 'scm.pct.fly_ash_pozzolan'],
    ['scm.max.slag_pct', 'scm.pct.slag'],
    ['scm.max.silica_fume_pct', 'scm.pct.silica_fume'],
    ['scm.max.fly_ash_silica_fume_pct', 'scm.pct.fly_ash_silica_fume'],
  ];
  for (const [name, key] of scmFig) {
    const v = figures.get(key);
    limitCheck(name, name, 'max', typeof v === 'number' ? exact(key) : null);
  }
  function exact(key: string): Rat {
    // Recompute exactly rather than from the rounded double.
    const m: Record<string, Rat> = {
      'scm.pct.total': pct(pozz.add(t('ggbs')).add(t('silica_fume'))),
      'scm.pct.fly_ash_pozzolan': pct(pozz),
      'scm.pct.slag': pct(t('ggbs')),
      'scm.pct.silica_fume': pct(t('silica_fume')),
      'scm.pct.fly_ash_silica_fume': pct(pozz.add(t('silica_fume'))),
    };
    return m[key]!;
  }

  // sulfate cement by C3A
  const sul = req('sulfate_cement');
  if (sul) {
    const mod = rn('SHARED', 'cement.equivalence.moderate.max_c3a_pct');
    const high = rn('SHARED', 'cement.equivalence.high.max_c3a_pct');
    const allowed = Array.isArray(sul.value) ? (sul.value as string[]) : null;
    const rank = { none: 0, moderate: 1, high: 2 } as Record<string, number>;
    const cements = lines.filter((l) => l.cat === 'cement');
    let lowest: string | null = null;
    let missing = false;
    if (usable(sul) && mod && high)
      for (const l of cements) {
        const c3a = pn(l.m, 'c3a_pct');
        if (c3a === null) {
          missing = true;
          continue;
        }
        const k = c3a.lte(high) ? 'high' : c3a.lte(mod) ? 'moderate' : 'none';
        figures.set(`cement.class.${l.id}`, k);
        if (lowest === null || rank[k]! < rank[lowest]!) lowest = k;
      }
    const minRank = allowed ? Math.min(...allowed.map((a) => rank[a] ?? 3)) : null;
    const ok =
      usable(sul) &&
      mod &&
      high &&
      cements.length > 0 &&
      !missing &&
      lowest !== null &&
      minRank !== null;
    setCheck('sulfate_cement', {
      status: !ok ? 'not_evaluated' : rank[lowest!]! >= minRank! ? 'pass' : 'fail',
      value: lowest,
      limit: allowed,
      warning: null,
    });
  }
  const scr = req('scm_required');
  if (scr) {
    const allowed = Array.isArray(scr.value) ? (scr.value as string[]) : null;
    const present = new Set<string>();
    if (scmBy['fly_ash'] || scmBy['natural_pozzolan']) present.add('pozzolan');
    if (scmBy['ggbs']) present.add('slag');
    const ok = usable(scr) && allowed !== null && scmUntyped.length === 0;
    setCheck('scm_required', {
      status: !ok ? 'not_evaluated' : allowed!.some((a) => present.has(a)) ? 'pass' : 'fail',
      value: [...present].sort().join(',') || 'none',
      limit: allowed,
      warning: null,
    });
  }
  const cac = req('cacl2_prohibited');
  if (cac) {
    const untyped = adm.filter((l) => prop(l.m, 'type') === undefined);
    const acc = adm.filter((l) => ['C', 'E'].includes(String(prop(l.m, 'type'))));
    const ok = usable(cac) && untyped.length === 0 && typeof cac.value === 'boolean';
    setCheck('cacl2_prohibited', {
      status: !ok
        ? 'not_evaluated'
        : cac.value === true
          ? acc.length === 0
            ? 'pass'
            : 'fail'
          : 'pass',
      value: acc.length > 0 ? 'accelerating admixture present' : 'no accelerating admixture',
      limit: typeof cac.value === 'boolean' ? cac.value : null,
      warning: null,
    });
  }

  // air
  const airReq = req('air_target_pct');
  if (airReq) {
    const tolReq = req('air_tolerance_pct');
    let target: Rat | null = null;
    let tol: Rat | null = null;
    if (usable(airReq) && usable(tolReq) && rq.nmasMm !== null && rq.airPct !== null) {
      const r = look1d(airReq.value as TableDefinition, R(rq.nmasMm));
      if (r.s === 'ok') {
        target = r.v;
        tol = lim(tolReq);
      }
    }
    if (target && tol) {
      fig('air.target_pct', target);
      fig('air.tolerance_pct', tol);
    }
    const v = rq.airPct === null ? null : R(rq.airPct);
    if (!v || !target || !tol)
      setCheck('air', {
        status: 'not_evaluated',
        value: rq.airPct,
        limit: target?.toNumber() ?? null,
        warning: null,
      });
    else {
      const dev = v.sub(target).abs();
      const pass = dev.lte(tol.add(EPS));
      setCheck('air', {
        status: pass ? 'pass' : 'fail',
        value: rq.airPct,
        limit: target.toNumber(),
        warning:
          pass && near !== null && dev.gte(tol.mul(ONE.sub(near.div(R(100)))))
            ? 'near_limit'
            : null,
      });
    }
  }

  // yield and admixture dosage
  const tolY = R(s.settings.yieldTolerance);
  const dy = total === null ? null : total.sub(ONE);
  setCheck('yield', {
    status: dy === null ? 'not_evaluated' : dy.abs().lte(tolY.add(EPS)) ? 'pass' : 'fail',
    value: dy?.toNumber() ?? null,
    limit: s.settings.yieldTolerance,
    warning:
      dy !== null &&
      dy.abs().lte(tolY.add(EPS)) &&
      near !== null &&
      dy.abs().gte(tolY.mul(ONE.sub(near.div(R(100)))))
        ? 'near_limit'
        : null,
  });
  for (const l of adm) {
    const d = dosage.get(l.id);
    const min = pn(l.m, 'min_dosage_pct');
    const max = pn(l.m, 'max_dosage_pct');
    const ok = d !== undefined && (min !== null || max !== null);
    setCheck(`admixture_dosage.${l.id}`, {
      status: !ok
        ? 'not_evaluated'
        : (min === null || d!.gte(min.sub(EPS))) && (max === null || d!.lte(max.add(EPS)))
          ? 'pass'
          : 'fail',
      value: d?.toNumber() ?? null,
      limit: null,
      warning: null,
    });
  }

  // ------------------------------------------------------------ baselines
  let baselineWc: Rat | null = null;
  let comparison: string | null = null;
  if (fcrTotal !== null) {
    const t2 = tableAt('prop.wc_strength.');
    const r = look1d(t2.def, fcrTotal);
    if (r.s === 'ok') {
      baselineWc = r.v;
      fig('baseline.wc', baselineWc);
      comparison =
        wcm === null
          ? null
          : wcm.gt(baselineWc.add(EPS))
            ? 'design_above_baseline'
            : 'design_at_or_below_baseline';
    }
  }
  let baseWater: Rat | null = null;
  let baselineWater: Rat | null = null;
  let reductionPct: Rat | null = null;
  if (rq.slumpMm !== null && rq.nmasMm !== null) {
    const t3 = tableAt('prop.water.');
    const slump = R(rq.slumpMm);
    const col = R(rq.nmasMm);
    const q = look2dBins(t3.def, slump, col);
    if (q.s === 'ok') baseWater = q.v;
    else if (q.s === 'between') {
      const a = look2dBins(t3.def, R(q.below[1]), col);
      const b = look2dBins(t3.def, R(q.above[0]), col);
      if (a.s === 'ok' && b.s === 'ok')
        baseWater = a.v.add(
          slump
            .sub(R(q.below[1]))
            .div(R(q.above[0]).sub(R(q.below[1])))
            .mul(b.v.sub(a.v)),
        );
    }
    if (baseWater !== null) {
      let remaining = ONE;
      let anyAdm = false;
      let fail = false;
      for (const l of adm) {
        const d = dosage.get(l.id);
        if (d === undefined) continue;
        const wr = reduction(
          prop(l.m, 'water_reduction_table') as
            { dosage_pct: number; water_reduction_pct: number }[] | undefined,
          d,
        );
        if (wr === null) {
          fail = true;
          break;
        }
        remaining = remaining.mul(ONE.sub(wr.div(R(100))));
        anyAdm = true;
      }
      if (!fail) {
        baselineWater = baseWater.mul(remaining);
        reductionPct = anyAdm ? ONE.sub(remaining).mul(R(100)) : ZERO;
        fig('baseline.water_kg', baselineWater);
      } else baseWater = null;
    }
  }

  // ------------------------------------------------------------ cost (exact decimals, own conversion)
  const costLines = new Map<string, { jod: string | null; state: string }>();
  let totalCost = 0n;
  let anyMissing = false;
  for (const l of s.lines) {
    const m = mats.get(l.materialId);
    const p = m?.price;
    let state = 'priced';
    let jod: string | null = null;
    if (!p || p.status !== 'ok') state = p?.status === 'ambiguous' ? 'ambiguous' : 'unavailable';
    else {
      // prices are stored with at most 3 decimals and 9 integer digits; anything else cannot be trusted
      const price = /^\d{1,9}(\.\d{1,3})?$/.test(p.price) ? parseDecimal(p.price) : null;
      let perKg: bigint | null = null;
      if (price !== null) {
        if (p.unit === 'JOD/kg') perKg = price;
        else if (p.unit === 'JOD/ton') perKg = divide(price, 1000n * 10n ** 9n);
        else if (p.unit === 'JOD/L') {
          const sgn = pn(
            m,
            m!.category === 'fine_agg' || m!.category === 'coarse_agg' ? 'sg_ssd' : 'sg',
          );
          const sgd = sgn === null ? null : parseDecimal(sgn.toFixed(6));
          if (sgd !== null && sgd > 0n) perKg = divide(price, sgd);
        }
      }
      const kg = parseDecimal(l.kgPerM3);
      if (perKg === null || kg === null) state = 'not_convertible';
      else {
        const exactCost = multiply(kg, perKg);
        totalCost += exactCost;
        jod = roundTo(exactCost, 3);
      }
    }
    if (jod === null) anyMissing = true;
    costLines.set(l.materialId, { jod, state });
    figures.set(`cost.${l.materialId}`, jod);
  }
  const costTotal = anyMissing ? null : roundTo(totalCost, 3);
  const costSubtotal = roundTo(totalCost, 3);
  figures.set('cost.total', costTotal);
  figures.set('cost.subtotal', costSubtotal);

  // ------------------------------------------------------------ characteristics
  const chars = new Map<string, { achieved: Fig; status: string }>();
  for (const c of s.characteristics) {
    const id = c.sub === null ? c.key : `${c.key}.${c.sub}`;
    const f = (k: string): Rat | null => {
      const v = figures.get(k);
      return typeof v === 'number' ? R(v) : null;
    };
    let a: Rat | null = null;
    switch (c.key) {
      case 'wcm':
        a = wcm;
        break;
      case 'binder_kg':
        a = binder;
        break;
      case 'cement_kg':
        a = cement;
        break;
      case 'water_kg':
        a = freeWater;
        break;
      case 'scm':
        a = f(`scm.pct.line.${c.spec['product']}`);
        break;
      case 'admixture':
        a = f(`dosage.${c.spec['product']}`);
        break;
      case 'air_pct':
        a = air;
        break;
      case 'sand_ratio_pct':
        a = f(
          c.spec['basis'] === 'volume' ? 'agg.sand_ratio_volume_pct' : 'agg.sand_ratio_mass_pct',
        );
        break;
      case 'agg_share_pct':
        a = f(`agg.share_pct.${c.sub}`);
        break;
      case 'agg_kg': {
        const l = s.lines.find((x) => x.materialId === c.sub);
        a = l ? R(l.kgPerM3) : null;
        break;
      }
      case 'paste_l':
        a = f('agg.paste_l');
        break;
      case 'fm_combined':
        a = f('agg.fm_combined');
        break;
      case 'passing_pct':
        a = f(`agg.passing.${c.sub}`);
        break;
      case 'fresh_density_kg_m3':
        a = kgOf(() => true);
        break;
      case 'slump_mm':
        a = rq.slumpMm === null ? null : R(rq.slumpMm);
        break;
      case 'nmas_mm':
        a = rq.nmasMm === null ? null : R(rq.nmasMm);
        break;
      case 'extra_margin_mpa':
        a = fcrTotal === null ? null : R(c.spec.value as number);
        break;
      case 'fcr_mpa':
        a = fcrTotal;
        break;
      case 'max_cost_jod_m3':
        a = costTotal === null ? null : R(costTotal);
        break;
      default:
        a = null;
    }
    const tolC = R(Math.max(s.settings.roundingTolerance[c.key] ?? 0, 1e-6));
    let status = 'not_evaluated';
    const sp = c.spec;
    if (a !== null) {
      const want =
        c.key === 'scm' ? sp['pct'] : c.key === 'admixture' ? sp['dosage_pct'] : sp.value;
      if ((sp.mode === 'fixed' || sp.mode === 'target') && num(want))
        status = a.sub(R(want)).abs().lte(tolC) ? 'met' : 'deviated';
      else if (sp.mode === 'range') {
        const below = num(sp.min) && a.cmp(R(sp.min).sub(tolC)) < 0;
        const above = num(sp.max) && a.gt(R(sp.max).add(tolC));
        status = below || above ? 'deviated' : 'met';
      } else if (sp.mode === 'list')
        status = (sp['values'] as number[]).some((v) => R(v).cmp(a!) === 0) ? 'met' : 'deviated';
    }
    chars.set(id, { achieved: a === null ? null : a.toNumber(), status });
  }

  // ------------------------------------------------------------ verdict
  const ctxBlocking =
    resolved.requirements.some(
      (r) => checks.has(r.requirement) && r.issues.some((i) => i.code === 'context_missing'),
    ) ||
    [...checks.keys()].some((k) => {
      const name =
        k === 'cl.nonprestressed'
          ? 'max_cl_nonprestressed'
          : k === 'cl.prestressed'
            ? 'max_cl_prestressed'
            : k === 'air'
              ? 'air_target_pct'
              : k;
      const r = req(name);
      return !!r && r.issues.some((i) => i.code === 'context_missing');
    });
  const statuses = [...checks.values()].map((c) => c.status);
  const verdict = statuses.includes('fail')
    ? 'fail'
    : statuses.includes('not_evaluated') || ctxBlocking
      ? 'incomplete'
      : 'pass';

  return {
    figures,
    checks,
    verdict,
    strength: {
      cylinderMpa: cyl?.toNumber() ?? null,
      fcrMpa: fcrTotal?.toNumber() ?? null,
      governing,
      branches,
    },
    adequacy: { baselineWc: baselineWc?.toNumber() ?? null, comparison },
    water: {
      baseWaterKg: baseWater?.toNumber() ?? null,
      baselineWaterKg: baselineWater?.toNumber() ?? null,
      reductionPct: reductionPct?.toNumber() ?? null,
    },
    cost: {
      state: anyMissing ? 'incomplete' : 'complete',
      total: costTotal,
      subtotal: costSubtotal,
      lines: costLines,
    },
    minimumData: { ok: missingMinimum.length === 0, missing: missingMinimum },
    chars,
    unverifiedUsed: usedUnverified.v,
  };
}

function reduction(
  table: { dosage_pct: number; water_reduction_pct: number }[] | undefined,
  dose: Rat,
): Rat | null {
  if (!table || table.length === 0) return null;
  const pts = [...table].sort((a, b) => a.dosage_pct - b.dosage_pct);
  if (dose.cmp(R(pts[0]!.dosage_pct)) < 0 || dose.gt(R(pts[pts.length - 1]!.dosage_pct)))
    return null;
  const i = pts.findIndex((p) => R(p.dosage_pct).gte(dose));
  const b = pts[i]!;
  if (R(b.dosage_pct).cmp(dose) === 0) return R(b.water_reduction_pct);
  const a = pts[i - 1]!;
  const f = dose.sub(R(a.dosage_pct)).div(R(b.dosage_pct).sub(R(a.dosage_pct)));
  return R(a.water_reduction_pct).add(
    f.mul(R(b.water_reduction_pct).sub(R(a.water_reduction_pct))),
  );
}

export { Rat };
