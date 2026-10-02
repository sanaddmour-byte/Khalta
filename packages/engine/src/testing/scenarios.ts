// A broad set of snapshots that exercises every branch of the evaluator. Used to prove the independent
// validator agrees with the evaluator across all of them, and for determinism / trace-completeness tests.
import type { RuleRecord } from '@khalta/rules';
import type { ResolvedCharacteristic } from '../characteristics/resolve';
import { selectRules } from '../evaluate/select';
import type { EvaluationSnapshot, SnapshotMaterial } from '../evaluate/types';
import { ALL_RULES, LINES, MATERIALS, makeSnapshot } from './synthetic';

export interface Scenario {
  name: string;
  snapshot: EvaluationSnapshot;
}

const baseReq = makeSnapshot().request;
const req = (o: Partial<EvaluationSnapshot['request']>) => ({ ...baseReq, ...o });
const patchMat = (id: string, props: Record<string, unknown>) =>
  MATERIALS.map((m) =>
    m.id === id && m.test
      ? {
          ...m,
          test: {
            ...m.test,
            properties: Object.fromEntries(
              Object.entries({ ...m.test.properties, ...props }).filter(([, v]) => v !== undefined),
            ),
          },
        }
      : m,
  );
const withLines = (o: Record<string, string | null>) =>
  LINES.flatMap((l) =>
    o[l.materialId] === null ? [] : [{ ...l, kgPerM3: o[l.materialId] ?? l.kgPerM3 }],
  );
const scm = (id: string, type: string | undefined, sg = 2.2): SnapshotMaterial => ({
  id,
  category: 'scm',
  nameEn: id,
  nameAr: null,
  test: { ...MATERIALS[0]!.test!, properties: type ? { scm_type: type, sg } : { sg } },
  price: {
    status: 'ok',
    priceId: 'p',
    price: '30',
    unit: 'JOD/ton',
    supplierId: 's',
    includesDelivery: true,
    effectiveFrom: '2026-09-01',
    staleness: 'stale',
    ageDays: 400,
  },
});
const C = (
  key: string,
  spec: Record<string, unknown>,
  sub: string | null = null,
): ResolvedCharacteristic => ({
  key,
  sub,
  spec: spec as ResolvedCharacteristic['spec'],
  origin: 'request',
});
const jsValues = (r: RuleRecord): RuleRecord => {
  const v: Record<string, number> = {
    'fcr.no_data.lower_threshold_mpa': 21,
    'fcr.threshold_mpa': 35,
    'fcr.no_data.lt21.add': 8,
    'fcr.no_data.mid.add': 9.5,
    'fcr.no_data.gt35.factor': 1.15,
    'fcr.no_data.gt35.add': 6,
    'durability.S1.max_wcm': 0.48,
    'durability.F1.max_wcm': 0.5,
    'air.tolerance_pct': 1,
  };
  return r.ruleset === 'JS' && r.key in v ? { ...r, value: v[r.key]! } : r;
};

export function scenarios(): Scenario[] {
  const out: Scenario[] = [];
  const add = (name: string, over: Partial<EvaluationSnapshot> = {}) =>
    out.push({ name, snapshot: makeSnapshot(over) });
  const settings = makeSnapshot().settings;

  add('base ACI');
  add('base BOTH', { mode: 'BOTH' });
  add('base JS', { mode: 'JS' });
  for (const fc of [15, 20, 21, 35, 36, 50]) add(`fc ${fc}`, { request: req({ fcMpa: fc }) });
  add('cube 37', { request: req({ fcMpa: 37, basis: 'cube' }) });
  add('cube not on map', { request: req({ fcMpa: 38, basis: 'cube' }) });
  add('b-grade 300', { request: req({ fcMpa: 300, basis: 'b_grade' }) });
  add('b-grade ambiguous', { request: req({ fcMpa: 350, basis: 'b_grade' }) });
  add('no basis', { request: req({ basis: null }) });
  add('no fc', { request: req({ fcMpa: null }) });
  add('statistical 30', { strengthRecords: { n: 30, sdMpa: 3, fcMpa: 30 } });
  add('statistical 20 tests', { strengthRecords: { n: 20, sdMpa: 3, fcMpa: 30 } });
  add('statistical fc 40', {
    request: req({ fcMpa: 40 }),
    strengthRecords: { n: 30, sdMpa: 3, fcMpa: 40 },
  });
  add('statistical too few', { strengthRecords: { n: 10, sdMpa: 3, fcMpa: 30 } });
  add('margins', { settings: { ...settings, safetyMarginMpa: 1.5, nearLimitPct: 5 } });
  {
    const request = req({ exposure: ['S1'] });
    add('JS values, BOTH', {
      mode: 'BOTH',
      request,
      rules: selectRules(ALL_RULES.map(jsValues), 'BOTH', request),
    });
    add('JS values, JS', {
      mode: 'JS',
      request,
      rules: selectRules(ALL_RULES.map(jsValues), 'JS', request),
    });
    const f1 = req({ exposure: ['F1'], airPct: 5.2 });
    add('JS values, F1 air', {
      mode: 'BOTH',
      request: f1,
      rules: selectRules(ALL_RULES.map(jsValues), 'BOTH', f1),
      settings: { ...settings, nearLimitPct: 10 },
    });
  }
  for (const [name, c] of [
    ['extra margin', C('extra_margin_mpa', { mode: 'fixed', value: 2 })],
    ['fixed fcr', C('fcr_mpa', { mode: 'fixed', value: 45 })],
    ['low fixed fcr', C('fcr_mpa', { mode: 'fixed', value: 20 })],
  ] as const)
    add(name, { characteristics: [c] });

  // volume / water / air
  add('lean yield', { lines: withLines({ coarse: '1000.000' }) });
  add('loose yield tolerance', {
    lines: withLines({ coarse: '1000.000' }),
    settings: { ...settings, yieldTolerance: 0.02, nearLimitPct: 50 },
  });
  add('missing sand SG', { materials: patchMat('sand', { sg_ssd: undefined }) });
  add('water sg default', { materials: patchMat('water', { sg: undefined }) });
  add('no water', { lines: withLines({ water: null }) });
  add('no cement', { lines: withLines({ cem: null }) });
  add('admixture ignored', { materials: patchMat('sp', { water_convention: 'liquid_ignored' }) });
  add('admixture convention unset', { materials: patchMat('sp', { water_convention: undefined }) });
  add('admixture no solids', { materials: patchMat('sp', { solids_pct: undefined }) });
  add('air baseline', { request: req({ airPct: null }) });
  add('air baseline interpolated', { request: req({ airPct: null, nmasMm: 22 }) });
  add('air baseline out of domain', { request: req({ airPct: null, nmasMm: 100 }) });
  add('air baseline no nmas', { request: req({ airPct: null, nmasMm: null }) });
  add('air-entrained no air', { request: req({ airPct: null, exposure: ['F2'] }) });
  add('slump between bins', { request: req({ slumpMm: 125 }) });
  add('slump in bin', { request: req({ slumpMm: 90 }) });
  add('slump out of domain', { request: req({ slumpMm: 300 }) });
  add('no slump', { request: req({ slumpMm: null }) });
  add('nmas 22', { request: req({ nmasMm: 22 }) });
  add('no nmas', { request: req({ nmasMm: null }) });
  add('no admixture', { lines: withLines({ sp: null }) });
  add('admixture over dose', { lines: withLines({ sp: '7.000' }) });
  add('admixture under dose', { lines: withLines({ sp: '1.000' }) });
  add('admixture no range', {
    materials: patchMat('sp', { min_dosage_pct: undefined, max_dosage_pct: undefined }),
  });
  add('admixture no table', { materials: patchMat('sp', { water_reduction_table: undefined }) });
  add('admixture table too narrow', {
    materials: patchMat('sp', {
      water_reduction_table: [
        { dosage_pct: 2, water_reduction_pct: 20 },
        { dosage_pct: 3, water_reduction_pct: 25 },
      ],
    }),
  });
  add('two admixtures', {
    materials: [...MATERIALS, { ...MATERIALS[4]!, id: 'sp2' }],
    lines: [...LINES, { materialId: 'sp2', kgPerM3: '3.500' }],
  });
  add('baseline out of domain f′cr', { request: req({ fcMpa: 45 }) });
  add('lean water', { lines: withLines({ water: '120.000' }) });

  // exposure classes
  for (const e of [
    ['S1'],
    ['S2'],
    ['C2'],
    ['F1'],
    ['F2'],
    ['F3'],
    ['W2'],
    ['S0', 'W1', 'C0'],
    ['S2', 'C2', 'F2'],
  ])
    add(`exposure ${e.join('+')}`, {
      request: req({
        exposure: e,
        fcMpa: e.includes('F3') ? 40 : 30,
        airPct: e.some((x) => x.startsWith('F')) ? 5 : 2,
      }),
    });
  add('S3 without option', { request: req({ exposure: ['S3'], fcMpa: 35 }) });
  for (const opt of [1, 2] as const)
    add(`S3 option ${opt}`, { request: req({ exposure: ['S3'], s3Option: opt, fcMpa: 35 }) });
  {
    const fa = scm('fa', 'fly_ash');
    const slag = scm('slag', 'ggbs', 2.9);
    const sf = scm('sf', 'silica_fume', 2.2);
    const np = scm('np', 'natural_pozzolan');
    const lime = scm('lime', 'limestone_filler', 2.7);
    const untyped = scm('mystery', undefined);
    const f3 = req({ exposure: ['F3'], fcMpa: 40, airPct: 6 });
    const s3 = req({ exposure: ['S3'], s3Option: 1, fcMpa: 35 });
    const mix = (extra: [SnapshotMaterial, string][], request = f3) => ({
      request,
      materials: [...MATERIALS, ...extra.map(([m]) => m)],
      lines: [...LINES, ...extra.map(([m, kg]) => ({ materialId: m.id, kgPerM3: kg }))],
    });
    add('F3 fly ash 30%', mix([[fa, '120.000']]));
    add('F3 slag 55%', mix([[slag, '220.000']]));
    add(
      'F3 silica fume + fly ash',
      mix([
        [sf, '40.000'],
        [fa, '90.000'],
      ]),
    );
    add('F3 natural pozzolan', mix([[np, '60.000']]));
    add('F3 limestone', mix([[lime, '30.000']]));
    add('F3 untyped SCM', mix([[untyped, '50.000']]));
    add('S3 with fly ash', mix([[fa, '60.000']], s3));
    add('S3 with slag', mix([[slag, '60.000']], s3));
    add('S3 untyped SCM', mix([[untyped, '60.000']], s3));
    add('S3 none', { request: s3 });
  }

  // cement, accelerators, chlorides
  for (const c3a of [3, 5, 6, 8, 9])
    add(`S2 cement C3A ${c3a}`, {
      request: req({ exposure: ['S2'], fcMpa: 31 }),
      materials: patchMat('cem', { c3a_pct: c3a }),
    });
  add('S1 cement no C3A', {
    request: req({ exposure: ['S1'] }),
    materials: patchMat('cem', { c3a_pct: undefined }),
  });
  add('S1 equivalence not on file', {
    request: req({ exposure: ['S1'] }),
    rules: selectRules(
      ALL_RULES.map((r) =>
        r.key === 'cement.equivalence.high.max_c3a_pct' ? { ...r, value: null } : r,
      ),
      'ACI',
      req({ exposure: ['S1'] }),
    ),
  });
  for (const type of ['C', 'E', 'F', undefined])
    add(`S2 admixture ${String(type)}`, {
      request: req({ exposure: ['S2'], fcMpa: 31 }),
      materials: patchMat('sp', { type }),
    });
  add('S2 no admixture', {
    request: req({ exposure: ['S2'], fcMpa: 31 }),
    lines: withLines({ sp: null }),
  });
  add('C2 salty sand', {
    request: req({ exposure: ['C2'], fcMpa: 40 }),
    materials: patchMat('sand', { chlorides_pct: 0.1 }),
  });
  add('C2 no aggregate chloride', {
    request: req({ exposure: ['C2'], fcMpa: 40 }),
    materials: patchMat('sand', { chlorides_pct: undefined }),
  });
  add('C2 no water chloride', {
    request: req({ exposure: ['C2'], fcMpa: 40 }),
    materials: patchMat('water', { chloride_mg_l: undefined }),
  });
  add('C2 no admixture chloride', {
    request: req({ exposure: ['C2'], fcMpa: 40 }),
    materials: patchMat('sp', { chloride_pct: undefined }),
  });
  add('C2 no cement', {
    request: req({ exposure: ['C2'], fcMpa: 40 }),
    lines: withLines({ cem: null }),
  });
  add('C1 near limit', {
    request: req({ exposure: ['C1'] }),
    settings: { ...settings, nearLimitPct: 90 },
  });

  // project overrides
  add('override tightens', {
    request: req({ exposure: ['S1'] }),
    projectOverrides: [{ requirement: 'max_wcm', value: 0.45 }],
  });
  add('override loosens', {
    request: req({ exposure: ['S1'] }),
    projectOverrides: [{ requirement: 'max_wcm', value: 0.6 }],
  });
  add('override new requirement', {
    request: req({ exposure: ['F0'] }),
    projectOverrides: [
      {
        requirement: 'max_wcm',
        value: 0.45,
        kind: 'limit_max',
        units: 'ratio',
        clause_ref: 'Project spec §4',
      },
    ],
  });

  // cost
  const ok = MATERIALS[0]!.price as Extract<SnapshotMaterial['price'], { status: 'ok' }>;
  const priced = (price: SnapshotMaterial['price'], id = 'coarse') =>
    MATERIALS.map((m) => (m.id === id ? { ...m, price } : m));
  add('price unavailable', { materials: priced({ status: 'unavailable' }) });
  add('price ambiguous', { materials: priced({ status: 'ambiguous', supplierIds: ['a', 'b'] }) });
  add('price per m3', { materials: priced({ ...ok, unit: 'JOD/m3' }) });
  add('price per litre', { materials: priced({ ...ok, price: '2', unit: 'JOD/L' }) });
  add('price per kg', { materials: priced({ ...ok, price: '0.007', unit: 'JOD/kg' }) });
  add('price bad format', { materials: priced({ ...ok, price: '1.2345', unit: 'JOD/kg' }) });
  add('price stale', { materials: priced({ ...ok, staleness: 'stale', ageDays: 300 }) });
  add('price age unconfigured', { materials: priced({ ...ok, staleness: 'not_configured' }) });
  add('no test', { materials: MATERIALS.map((m) => (m.id === 'sand' ? { ...m, test: null } : m)) });
  add('expired test', {
    materials: MATERIALS.map((m) =>
      m.id === 'sand' && m.test ? { ...m, test: { ...m.test, freshness: 'expired' as const } } : m,
    ),
  });
  add('unknown material line', { lines: [...LINES, { materialId: 'ghost', kgPerM3: '1.000' }] });

  // characteristics of every key
  const sp = 'sp';
  const chars: ResolvedCharacteristic[] = [
    C('wcm', { mode: 'range', max: 0.45 }),
    C('binder_kg', { mode: 'fixed', value: 350 }),
    C('cement_kg', { mode: 'range', min: 330, max: 380 }),
    C('scm', { mode: 'fixed', product: 'fa', pct: 20 }),
    C('water_kg', { mode: 'target', value: 170 }),
    C('air_pct', { mode: 'range', min: 1, max: 3 }),
    C('admixture', { mode: 'fixed', product: sp, dosage_pct: 1 }),
    C('sand_ratio_pct', { mode: 'target', value: 44, basis: 'mass' }),
    C('sand_ratio_pct', { mode: 'range', max: 50, basis: 'volume' }),
    C('agg_share_pct', { mode: 'range', min: 40, max: 45 }, 'sand'),
    C('agg_kg', { mode: 'fixed', value: 780 }, 'sand'),
    C('agg_kg', { mode: 'fixed', value: 1 }, 'ghost'),
    C('paste_l', { mode: 'range', max: 300 }),
    C('fm_combined', { mode: 'range', min: 4, max: 6 }),
    C('passing_pct', { mode: 'range', min: 40, max: 60 }, '4.75'),
    C('passing_pct', { mode: 'range', min: 1, max: 60 }, '0.075'),
    C('fresh_density_kg_m3', { mode: 'range', min: 2300 }),
    C('slump_mm', { mode: 'fixed', value: 100 }),
    C('nmas_mm', { mode: 'list', values: [19, 25] }),
    C('extra_margin_mpa', { mode: 'fixed', value: 1 }),
    C('max_cost_jod_m3', { mode: 'range', max: 40 }),
    C('shilstone.cf', { mode: 'range', min: 45 }),
  ];
  add('every characteristic', {
    characteristics: chars,
    materials: [...MATERIALS, scm('fa', 'fly_ash')],
    settings: { ...settings, roundingTolerance: { wcm: 0.1, binder_kg: 1 } },
  });
  add('characteristics, unpriced', {
    characteristics: [
      C('max_cost_jod_m3', { mode: 'range', max: 40 }),
      C('scm', { mode: 'range', product: 'fa', max: 20 }),
    ],
    materials: priced({ status: 'unavailable' }),
  });
  return out;
}
