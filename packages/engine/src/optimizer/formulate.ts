// The linear program for one configuration (docs/formulation-m3.1.md). Variables: B (binder kg/m³), W (added
// water kg/m³) and one volume V_j (m³/m³) per aggregate. Every row is linear in them; the only non-linear
// term (the binder-dependent workability-factor adjustment) is frozen at an estimate and iterated by the
// caller. Rows are classed CODE / ENGINEERING / USER / PHYSICAL so a conflict names who owns each limit.
import { passingAt } from '../evaluate/blend';
import { lookupTable, type TableDefinition } from '@khalta/rules';
import { isNum } from '../evaluate/util';
import type { SpecObject } from '../characteristics/schema';
import type { ResolvedCharacteristic } from '../characteristics/resolve';
import { idOf } from '../characteristics/resolve';
import type { ConfigSpec } from './enumerate';
import { dmaxFor, gradingSieves, targetPassing, wfAdjustment } from './measure';
import type { AggMat, Prepared } from './prepare';
import type { LpProblem, LpRow, LpVar } from './types';

export type RowClass = 'CODE' | 'ENGINEERING' | 'USER' | 'PHYSICAL';
export interface RowMeta {
  klass: RowClass;
  /** For a CODE row: whether the limit comes from the project's own requirements. */
  source?: 'code' | 'project';
  id: string;
  unit: string;
  /** For user rows: the characteristic key and the bound this row enforces. */
  charKey?: string;
  bound?: 'min' | 'max' | 'fixed' | 'target';
  value?: number;
}

/** A linear form: Σ coef·var + c. */
export class Lin {
  readonly t = new Map<string, number>();
  constructor(public c = 0) {}
  add(v: string, k: number): this {
    if (k !== 0) this.t.set(v, (this.t.get(v) ?? 0) + k);
    return this;
  }
  plus(o: Lin, k = 1): this {
    for (const [v, x] of o.t) this.add(v, x * k);
    this.c += o.c * k;
    return this;
  }
  scaled(k: number): Lin {
    return new Lin(0).plus(this, k);
  }
  value(x: Record<string, number>): number {
    let a = this.c;
    for (const [v, k] of this.t) a += k * (x[v] ?? 0);
    return a;
  }
}

export interface Quantity {
  num: Lin;
  /** Denominator for ratio quantities; null = the numerator is the quantity itself. */
  den: Lin | null;
  unit: string;
}

export interface Model {
  problem: LpProblem;
  meta: Map<string, RowMeta>;
  devs: { id: string; plus: string; minus: string; weight: number; key: string }[];
  elastic: { row: string; plus: string; minus: string }[];
  /** Equalities counted for the degrees-of-freedom report. */
  fixed: string[];
  aggs: AggMat[];
  /** The model's own water demand (before any user override), kg/m³ of free water. */
  waterDemand: number;
  userWater: boolean;
  /** True when the user pinned w/cm above the engineering ceiling (the shortfall path). */
  shortfallPath: boolean;
  quantity(key: string, sub: string | null, spec: SpecObject): Quantity | null;
  cost: Lin;
  free: Lin;
  binder: Lin;
  totalMass: Lin;
  aggVolume: Lin;
}

export interface FormOpts {
  binderEst: number;
  aggMassEst: number;
  /** Mass-weighted FM of the fine aggregates at the previous iteration (for the ACI coarse-volume sanity band). */
  fmFineEst: number | null;
  /** 'none' = the ordinary model; 'user' = USER rows get slacks; 'all' = every non-PHYSICAL row does. */
  elastic: 'none' | 'user' | 'all';
  /** Extra row (stage 2 of closest-to-targets): total weighted deviation cap. */
  deviationCap?: number;
}

const GUARD = (p: Prepared) => p.input.settings.guardrailGuard;

export function formulate(p: Prepared, cfg: ConfigSpec, o: FormOpts): Model {
  const g = p.guard.base;
  const aggs: AggMat[] = [...p.fines, ...p.coarses];
  const sgw = p.water.sg;
  const d = cfg.level?.dosagePct ?? 0;
  const k = cfg.admix && cfg.admix.countsAsWater ? (d / 100) * (1 - cfg.admix.solidsPct / 100) : 0;
  const frac = cfg.scmPct / 100;

  const vars: LpVar[] = [
    { name: 'B', lb: 0, ub: 5000, cost: 0 },
    { name: 'W', lb: 0, ub: 2000, cost: 0 },
    ...aggs.map((a): LpVar => ({ name: `V:${a.id}`, lb: 0, ub: 1, cost: 0 })),
  ];
  const rows: LpRow[] = [];
  const meta = new Map<string, RowMeta>();
  const elastic: Model['elastic'] = [];
  const devs: Model['devs'] = [];
  const fixed: string[] = [];

  // ---- linear forms
  const B = new Lin().add('B', 1);
  const free = new Lin().add('W', 1).add('B', k);
  const mass = (f: (a: AggMat) => number) => {
    const l = new Lin();
    for (const a of aggs) l.add(`V:${a.id}`, f(a) * a.rho);
    return l;
  };
  const vol = (f: (a: AggMat) => number) => {
    const l = new Lin();
    for (const a of aggs) l.add(`V:${a.id}`, f(a));
    return l;
  };
  const aggMass = mass(() => 1);
  const aggVolume = vol(() => 1);
  const admixKgPerB = d / 100;
  const totalMass = new Lin()
    .add('B', 1 + admixKgPerB)
    .add('W', 1)
    .plus(aggMass);
  const cementKg = new Lin().add('B', 1 - frac);

  const pc = cfg.cement.jodPerKg;
  const ps = cfg.scm?.jodPerKg ?? 0;
  const pa = cfg.admix?.jodPerKg ?? 0;
  const cost = new Lin()
    .add('B', (1 - frac) * pc + frac * ps + admixKgPerB * pa)
    .add('W', p.water.jodPerKg);
  for (const a of aggs) cost.add(`V:${a.id}`, a.rho * a.jodPerKg);

  const klassOf = (c: RowClass) => c;
  const addRow = (
    name: string,
    lin: Lin,
    lb: number | null,
    ub: number | null,
    m: Omit<RowMeta, 'id'> & { id?: string },
  ) => {
    const el =
      o.elastic === 'all'
        ? m.klass !== 'PHYSICAL'
        : o.elastic === 'user'
          ? m.klass === 'USER'
          : false;
    // Elastic rows are normalised so one unit of slack means the same everywhere (diagnostics only).
    const scale = el ? 1 / Math.max(1e-9, ...[...lin.t.values()].map(Math.abs)) : 1;
    const lo = lb === null ? null : (lb - lin.c) * scale;
    const hi = ub === null ? null : (ub - lin.c) * scale;
    const row: LpRow = {
      name,
      terms: [...lin.t.entries()].map(([v, c]): [string, number] => [v, c * scale]),
      lb: lo,
      ub: hi,
    };
    rows.push(row);
    meta.set(name, { ...m, id: m.id ?? name });
    if (el) {
      const plus = `s+:${name}`;
      const minus = `s-:${name}`;
      vars.push({ name: plus, lb: 0, ub: 1e7, cost: 0 }, { name: minus, lb: 0, ub: 1e7, cost: 0 });
      row.terms.push([plus, 1], [minus, -1]);
      elastic.push({ row: name, plus, minus });
    }
  };

  // ---- C1 volume balance
  const a0 =
    (1 - frac) / (cfg.cement.sg * 1000) +
    (cfg.scm ? frac / (cfg.scm.sg * 1000) : 0) +
    (cfg.admix ? admixKgPerB / (cfg.admix.sg * 1000) : 0);
  const volume = new Lin()
    .add('B', a0)
    .add('W', 1 / (1000 * sgw))
    .plus(aggVolume);
  const volRhs = 1 - cfg.airPct / 100;
  addRow('P:volume', volume, volRhs, volRhs, { klass: 'PHYSICAL', unit: 'm3' });

  // ---- C2 w/cm ceilings
  if (p.durabilityWcm !== null)
    addRow('C:wcm_limit', new Lin().plus(free).add('B', -p.durabilityWcm), null, 0, {
      klass: klassOf('CODE'),
      ...(p.durabilityWcmSource ? { source: p.durabilityWcmSource } : {}),
      unit: 'ratio',
    });
  // The engineering w/cm ceiling (baseline − margin) yields to an explicit user choice that pins w/cm above
  // it: a fixed or minimum w/cm, or a fixed binder together with a fixed water (their ratio IS w/cm).
  const wcmChar = p.chars.find((c) => c.key === 'wcm');
  const num = (c: ResolvedCharacteristic | undefined, f: 'value' | 'min'): number | undefined =>
    c && isNum(c.spec[f]) ? (c.spec[f] as number) : undefined;
  const binderChar = p.chars.find((c) => c.key === 'binder_kg');
  const waterC = p.chars.find((c) => c.key === 'water_kg');
  const floors = [
    wcmChar?.spec.mode === 'fixed' ? num(wcmChar, 'value') : num(wcmChar, 'min'),
    binderChar?.spec.mode === 'fixed' && waterC?.spec.mode === 'fixed'
      ? (num(waterC, 'value') as number) / (num(binderChar, 'value') as number)
      : undefined,
  ].filter((x): x is number => x !== undefined && Number.isFinite(x));
  const floor = floors.length ? Math.max(...floors) : 0;
  const shortfallPath = floor > p.wcmCeiling + 1e-9;
  if (!shortfallPath)
    addRow('E:wcm_ceiling', new Lin().plus(free).add('B', -p.wcmCeiling), null, 0, {
      klass: 'ENGINEERING',
      unit: 'ratio',
    });

  // ---- C4 water demand
  const base = p.baseWaterKg.get(cfg.nmas)!;
  const demand = base * (1 - (cfg.level?.waterReductionPct ?? 0) / 100);
  const waterChar = p.chars.find((c) => c.key === 'water_kg');
  const userWater = waterChar?.spec.mode === 'fixed' || waterChar?.spec.mode === 'range';
  if (!userWater)
    addRow('E:water_demand', new Lin().plus(free), demand, null, {
      klass: 'ENGINEERING',
      unit: 'kg/m3',
    });

  // ---- chlorides (tightest limit)
  if (p.chlorideLimitPct !== null) {
    const l = new Lin();
    for (const a of aggs) l.add(`V:${a.id}`, (a.rho * (a.chloridePct ?? 0)) / 100);
    const mgL = Number(p.water.m.test?.properties['chloride_mg_l'] ?? 0);
    l.add('W', mgL / sgw / 1e6);
    if (cfg.admix) l.add('B', admixKgPerB * ((cfg.admix.chloridePct ?? 0) / 100));
    l.add('B', -p.chlorideLimitPct / 100);
    addRow('C:chloride', l, null, 0, { klass: 'CODE', unit: '%' });
  }

  // ---- C5 combined grading (0.45-power curve ± (band − margin)), C6/C7 Shilstone, C8 fines and pumpability
  const guard = GUARD(p);
  const dmax = dmaxFor(cfg.nmas);
  const band = g.gradingBandPct - g.gradingMarginPts - guard;
  const wf = p.guard.forNmas(cfg.nmas);
  const pAt = (a: AggMat, s: number) => passingAt(a.points, s) as number;
  for (const s of gradingSieves(dmax)) {
    const t = targetPassing(s, dmax, g.gradingExponent);
    addRow(
      `E:grading@${s}:max`,
      mass((a) => pAt(a, s) - (t + band)),
      null,
      0,
      {
        klass: 'ENGINEERING',
        unit: '%',
      },
    );
    addRow(
      `E:grading@${s}:min`,
      mass((a) => pAt(a, s) - (t - band)),
      0,
      null,
      {
        klass: 'ENGINEERING',
        unit: '%',
      },
    );
  }
  const cfRow = (cf: number) => mass((a) => 100 * (100 - pAt(a, 9.5)) - cf * (100 - pAt(a, 2.36)));
  addRow('E:cf:min', cfRow(g.cfMin + guard), 0, null, { klass: 'ENGINEERING', unit: 'none' });
  addRow('E:cf:max', cfRow(g.cfMax - guard), null, 0, { klass: 'ENGINEERING', unit: 'none' });
  const adj = wfAdjustment(g, o.binderEst);
  if ('wf' in wf) {
    const wmin = wf.wf.min as number;
    const wmax = wf.wf.max as number;
    addRow(
      'E:wf:min',
      mass((a) => pAt(a, 2.36) - (wmin + guard + adj)),
      0,
      null,
      {
        klass: 'ENGINEERING',
        unit: 'none',
      },
    );
    addRow(
      'E:wf:max',
      mass((a) => pAt(a, 2.36) - (wmax - guard + adj)),
      null,
      0,
      {
        klass: 'ENGINEERING',
        unit: 'none',
      },
    );
  }
  addRow(
    'E:fines',
    mass((a) => (passingAt(a.points, 0.075) ?? a.finer75Pct ?? 0) - (g.finesMaxPct - guard)),
    null,
    0,
    { klass: 'ENGINEERING', unit: '%' },
  );
  if (p.pumpable && g.pumpableMin03Pct !== null)
    addRow(
      'E:pumpable',
      mass((a) => pAt(a, 0.3) - (g.pumpableMin03Pct as number) - guard),
      0,
      null,
      {
        klass: 'ENGINEERING',
        unit: '%',
      },
    );

  // ---- guard against the degenerate all-paste solution, and the ACI 211.1 coarse-volume sanity band
  addRow('P:aggregate_volume', aggVolume, p.input.settings.minAggregateVolume, null, {
    klass: 'PHYSICAL',
    unit: 'm3',
  });
  const caDef = p.rules.value('ACI', 'prop.ca_volume', false) as TableDefinition | null;
  if (caDef && o.fmFineEst !== null && p.coarses.every((c) => c.druw !== null)) {
    const t = lookupTable(caDef, { row: cfg.nmas, col: o.fmFineEst });
    if (t.status === 'ok') {
      const band = g.caVolumeSanityBandPct / 100;
      const bulk = new Lin();
      for (const a of p.coarses) bulk.add(`V:${a.id}`, a.rho / (a.druw as number));
      addRow('E:ca_volume:min', bulk, t.value * (1 - band), null, {
        klass: 'ENGINEERING',
        unit: 'm3',
      });
      addRow('E:ca_volume:max', bulk, null, t.value * (1 + band), {
        klass: 'ENGINEERING',
        unit: 'm3',
      });
    }
  }

  // ---- quantities for characteristics
  const fmOf = (a: AggMat) => g.fmSieves.reduce((acc, s) => acc + (100 - pAt(a, s)) / 100, 0);
  const quantity = (key: string, sub: string | null, spec: SpecObject): Quantity | null => {
    switch (key) {
      case 'wcm':
        return { num: new Lin().plus(free), den: B, unit: 'ratio' };
      case 'binder_kg':
        return { num: B, den: null, unit: 'kg/m3' };
      case 'cement_kg':
        return { num: cementKg, den: null, unit: 'kg/m3' };
      case 'water_kg':
        return { num: new Lin().plus(free), den: null, unit: 'kg/m3' };
      case 'sand_ratio_pct':
        return spec['basis'] === 'volume'
          ? {
              num: vol((a) => (a.kind === 'fine' ? 100 : 0)),
              den: aggVolume,
              unit: '%',
            }
          : { num: mass((a) => (a.kind === 'fine' ? 100 : 0)), den: aggMass, unit: '%' };
      case 'agg_share_pct': {
        const a = aggs.find((x) => x.id === sub);
        return a ? { num: mass((x) => (x.id === a.id ? 100 : 0)), den: aggMass, unit: '%' } : null;
      }
      case 'agg_kg': {
        const a = aggs.find((x) => x.id === sub);
        return a ? { num: mass((x) => (x.id === a.id ? 1 : 0)), den: null, unit: 'kg/m3' } : null;
      }
      case 'paste_l':
        return { num: new Lin(1000).plus(aggVolume, -1000), den: null, unit: 'L/m3' };
      case 'fm_combined':
        return { num: mass(fmOf), den: aggMass, unit: 'none' };
      case 'passing_pct': {
        const s = Number(sub);
        return aggs.every((a) => passingAt(a.points, s) !== null)
          ? { num: mass((a) => pAt(a, s)), den: aggMass, unit: '%' }
          : null;
      }
      case 'fresh_density_kg_m3':
        return { num: totalMass, den: null, unit: 'kg/m3' };
      case 'max_cost_jod_m3':
        return { num: cost, den: null, unit: 'JOD/m3' };
      case 'shilstone.cf':
        return {
          num: mass((a) => 100 * (100 - pAt(a, 9.5))),
          den: mass((a) => 100 - pAt(a, 2.36)),
          unit: 'none',
        };
      case 'shilstone.wf':
        return { num: mass((a) => pAt(a, 2.36) - adj), den: aggMass, unit: 'none' };
      case 'fines_max_pct':
        return {
          num: mass((a) => passingAt(a.points, 0.075) ?? a.finer75Pct ?? 0),
          den: aggMass,
          unit: '%',
        };
      default:
        return null;
    }
  };

  // ---- characteristic rows (USER). A ratio row is `num − bound·den`; a target adds deviation variables.
  const denEst = (q: Quantity, key: string): number => {
    if (q.den === null) return 1;
    if (key === 'wcm') return o.binderEst;
    if (key === 'shilstone.cf') return o.aggMassEst * 0.3;
    return o.aggMassEst;
  };
  const targetWeight = (spec: SpecObject) =>
    typeof spec['weight_jod_per_unit'] === 'number'
      ? (spec['weight_jod_per_unit'] as number)
      : p.input.settings.targetWeightJodPerUnit;
  for (const c of p.chars) {
    if (
      [
        'scm',
        'admixture',
        'air_pct',
        'nmas_mm',
        'slump_mm',
        'extra_margin_mpa',
        'fcr_mpa',
      ].includes(c.key)
    )
      continue;
    if (c.spec.mode === 'auto') continue;
    const q = quantity(c.key, c.sub, c.spec);
    if (!q) continue;
    const id = idOf(c);
    const m = (bound: RowMeta['bound'], value: number): Omit<RowMeta, 'id'> => ({
      klass: 'USER',
      unit: q.unit,
      charKey: id,
      bound,
      value,
    });
    const rowFor = (b: number): Lin => {
      const l = new Lin().plus(q.num);
      if (q.den) l.plus(q.den, -b);
      else l.c -= b;
      return l;
    };
    if (c.spec.mode === 'fixed' && isNum(c.spec.value)) {
      addRow(`U:${id}`, rowFor(c.spec.value), 0, 0, { ...m('fixed', c.spec.value), id });
      fixed.push(id);
    } else if (c.spec.mode === 'range') {
      if (isNum(c.spec.min))
        addRow(`U:${id}:min`, rowFor(c.spec.min), 0, null, { ...m('min', c.spec.min), id });
      if (isNum(c.spec.max))
        addRow(`U:${id}:max`, rowFor(c.spec.max), null, 0, { ...m('max', c.spec.max), id });
    } else if (c.spec.mode === 'target' && isNum(c.spec.value)) {
      const plus = `d+:${id}`;
      const minus = `d-:${id}`;
      const w = targetWeight(c.spec);
      vars.push({ name: plus, lb: 0, ub: 1e7, cost: 0 }, { name: minus, lb: 0, ub: 1e7, cost: 0 });
      const l = rowFor(c.spec.value).scaled(1 / denEst(q, c.key));
      l.add(plus, -1).add(minus, 1);
      addRow(`U:${id}:target`, l, 0, 0, { ...m('target', c.spec.value), id });
      devs.push({ id, plus, minus, weight: w, key: c.key });
    }
  }

  // ---- objective
  for (const v of vars) {
    if (v.name === 'B') v.cost = cost.t.get('B') ?? 0;
    else if (v.name === 'W') v.cost = cost.t.get('W') ?? 0;
    else if (v.name.startsWith('V:')) v.cost = cost.t.get(v.name) ?? 0;
  }
  for (const dv of devs) {
    for (const nm of [dv.plus, dv.minus]) vars.find((v) => v.name === nm)!.cost = dv.weight;
  }
  if (o.deviationCap !== undefined) {
    const l = new Lin();
    for (const dv of devs) l.add(dv.plus, dv.weight).add(dv.minus, dv.weight);
    addRow('U:deviation_cap', l, null, o.deviationCap, { klass: 'USER', unit: 'JOD/m3' });
  }
  return {
    problem: { vars, rows },
    meta,
    devs,
    elastic,
    fixed,
    aggs,
    waterDemand: demand,
    userWater,
    shortfallPath,
    quantity,
    cost,
    free,
    binder: B,
    totalMass,
    aggVolume,
  };
}

/** Phase-1 variant: zero the real objective and charge only the slacks (diagnostics). */
export function asPhaseOne(model: Model, weights: Map<string, number>): LpProblem {
  const vars = model.problem.vars.map((v) => ({ ...v, cost: 0 }));
  for (const e of model.elastic) {
    const w = weights.get(e.row) ?? 1;
    for (const nm of [e.plus, e.minus]) vars.find((v) => v.name === nm)!.cost = w;
  }
  return { vars, rows: model.problem.rows };
}

export const isUserSpecified = (c: ResolvedCharacteristic) => c.spec.mode !== 'auto';
