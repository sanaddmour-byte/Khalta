// Optimizer test world. SYNTHETIC: every number below is invented for tests, labelled as such, and is NOT a
// plant material, a code value or an engineering recommendation. The shipped seeds leave the grading band,
// Shilstone WF bounds, fines cap, pumpable minimum and the ASTM C33 limits empty on purpose (a QC manager must
// supply them), so real requests are blocked and named; these values let the optimizer be exercised.
import type { RuleRecord } from '@khalta/rules';
import type { EvaluationSnapshot, SnapshotMaterial } from '../evaluate/types';
import { selectRules } from '../evaluate/select';
import {
  DEFAULT_OPTIMIZER_SETTINGS,
  type OptimizerInput,
  type OptimizerSettings,
} from '../optimizer/types';
import { ALL_RULES, gradation } from './synthetic';

export const SYNTHETIC_PARAMS: Record<string, unknown> = {
  'eng.grading.target.band_pct': 12,
  'eng.shilstone.wf.min': 28,
  'eng.shilstone.wf.max': 45,
  'eng.fines.max_pct_75um': 6,
  'eng.pumpable.min_passing_0_3mm_pct': 10,
  'grading.fine.limits': [
    { sieve_mm: 9.5, min_pct: 100, max_pct: 100 },
    { sieve_mm: 4.75, min_pct: 90, max_pct: 100 },
    { sieve_mm: 2.36, min_pct: 65, max_pct: 100 },
    { sieve_mm: 1.18, min_pct: 40, max_pct: 90 },
    { sieve_mm: 0.6, min_pct: 20, max_pct: 70 },
    { sieve_mm: 0.3, min_pct: 8, max_pct: 40 },
    { sieve_mm: 0.15, min_pct: 0, max_pct: 15 },
  ],
  'grading.coarse.limits': [
    { sieve_mm: 4.75, min_pct: 0, max_pct: 20 },
    { sieve_mm: 2.36, min_pct: 0, max_pct: 6 },
  ],
};

/**
 * The seeds with the SYNTHETIC parameter set filled in (all still `verified: false`). `extra` keys are a rule
 * key (every ruleset) or `RULESET:key`. With `mirrorJs`, every JS value that is empty is copied from the ACI
 * rule with the same requirement and conditions: a test world in which the Jordanian code is defined, NOT a
 * statement of what the Jordanian code says.
 */
export function syntheticRules(
  base: readonly RuleRecord[] = ALL_RULES,
  extra: Record<string, unknown> = {},
  opts: { mirrorJs?: boolean } = {},
): RuleRecord[] {
  const values = { ...SYNTHETIC_PARAMS, ...extra };
  const aci = new Map(
    base
      .filter((r) => r.ruleset === 'ACI')
      .map((r) => [`${r.requirement}|${JSON.stringify(r.applies_to ?? null)}`, r]),
  );
  return base.map((r) => {
    const own = `${r.ruleset}:${r.key}`;
    if (own in values) return { ...r, value: values[own] ?? null };
    if (r.key in values) return { ...r, value: values[r.key] ?? null };
    if (opts.mirrorJs && r.ruleset === 'JS' && r.value === null && r.kind !== 'table') {
      const twin = aci.get(`${r.requirement}|${JSON.stringify(r.applies_to ?? null)}`);
      if (twin && twin.value !== null) return { ...r, value: twin.value };
    }
    return r;
  });
}

const price = (p: string, unit: 'JOD/ton' | 'JOD/kg' = 'JOD/ton') =>
  ({
    status: 'ok',
    priceId: 'p',
    price: p,
    unit,
    supplierId: 's1',
    includesDelivery: true,
    effectiveFrom: '2026-09-01',
    staleness: 'fresh',
    ageDays: 31,
  }) as const;
const test = (properties: Record<string, unknown>): SnapshotMaterial['test'] => ({
  id: 't',
  version: 1,
  source: 'lab_report',
  fieldSources: {},
  testedAt: '2026-08-01',
  validUntil: null,
  freshness: 'fresh',
  properties,
});
const mat = (
  id: string,
  category: SnapshotMaterial['category'],
  props: Record<string, unknown>,
  p: ReturnType<typeof price>,
): SnapshotMaterial => ({ id, category, nameEn: id, nameAr: null, test: test(props), price: p });

export const OPT_MATERIALS: SnapshotMaterial[] = [
  mat('cem-i', 'cement', { sg: 3.15, c3a_pct: 9 }, price('78')),
  mat('cem-sr', 'cement', { sg: 3.15, c3a_pct: 3.5 }, price('92')),
  mat('fly', 'scm', { sg: 2.2, scm_type: 'fly_ash' }, price('40')),
  mat('ggbs', 'scm', { sg: 2.9, scm_type: 'ggbs' }, price('55')),
  mat(
    'sand',
    'fine_agg',
    {
      sg_ssd: 2.62,
      chlorides_pct: 0.01,
      dry_rodded_unit_weight_kg_m3: 1650,
      sieve_analysis: gradation({
        '9.5': 100,
        '4.75': 98,
        '2.36': 85,
        '1.18': 66,
        '0.6': 46,
        '0.3': 22,
        '0.15': 7,
        '0.075': 3,
      }),
    },
    price('9'),
  ),
  mat(
    'crusher',
    'fine_agg',
    {
      sg_ssd: 2.68,
      chlorides_pct: 0.005,
      sieve_analysis: gradation({
        '9.5': 100,
        '4.75': 95,
        '2.36': 72,
        '1.18': 48,
        '0.6': 30,
        '0.3': 20,
        '0.15': 12,
        '0.075': 5,
      }),
    },
    price('7'),
  ),
  mat(
    'c20',
    'coarse_agg',
    {
      sg_ssd: 2.68,
      chlorides_pct: 0.005,
      dry_rodded_unit_weight_kg_m3: 1600,
      sieve_analysis: gradation({
        '25': 100,
        '19': 95,
        '12.5': 40,
        '9.5': 15,
        '4.75': 3,
        '2.36': 0,
        '0.075': 0,
      }),
    },
    price('8'),
  ),
  mat(
    'c10',
    'coarse_agg',
    {
      sg_ssd: 2.66,
      chlorides_pct: 0.005,
      dry_rodded_unit_weight_kg_m3: 1550,
      sieve_analysis: gradation({
        '12.5': 100,
        '9.5': 90,
        '4.75': 15,
        '2.36': 3,
        '1.18': 0,
        '0.075': 0,
      }),
    },
    price('8.5'),
  ),
  mat('water', 'water', { sg: 1, sg_confirmed: true, chloride_mg_l: 200 }, price('0.8')),
  mat(
    'sp',
    'admixture',
    {
      type: 'F',
      sg: 1.08,
      solids_pct: 40,
      min_dosage_pct: 0.4,
      max_dosage_pct: 1.5,
      water_convention: 'liquid_counts_as_water',
      chloride_pct: 0.05,
      water_reduction_table: [
        { dosage_pct: 0.4, water_reduction_pct: 8 },
        { dosage_pct: 0.8, water_reduction_pct: 14 },
        { dosage_pct: 1.5, water_reduction_pct: 22 },
      ],
    },
    price('1.2', 'JOD/kg'),
  ),
];

export function optimizerInput(
  over: {
    request?: Partial<EvaluationSnapshot['request']>;
    mode?: EvaluationSnapshot['mode'];
    characteristics?: EvaluationSnapshot['characteristics'];
    materials?: SnapshotMaterial[];
    rules?: RuleRecord[];
    mirrorJs?: boolean;
    extraRules?: Record<string, unknown>;
    objective?: OptimizerInput['objective'];
    settings?: Partial<OptimizerSettings>;
    include?: OptimizerInput['materials'];
    snapshot?: Partial<EvaluationSnapshot>;
  } = {},
): OptimizerInput {
  const request = {
    fcMpa: 30,
    basis: 'cylinder' as const,
    testAgeDays: 28,
    exposure: ['F0', 'S0', 'W0', 'C1'],
    s3Option: null,
    slumpMm: 100,
    nmasMm: 19,
    pumpable: false,
    airPct: null,
    ...over.request,
  };
  const mode = over.mode ?? 'ACI';
  const rules =
    over.rules ??
    selectRules(
      syntheticRules(ALL_RULES, over.extraRules ?? {}, { mirrorJs: over.mirrorJs ?? false }),
      mode,
      request,
    );
  const base: Omit<EvaluationSnapshot, 'lines'> = {
    schema: 1,
    design: { id: 'request', code: 'REQUEST', name: 'Optimizer request', plantId: 'plant' },
    mode,
    evaluationDate: '2026-10-02',
    priceBasis: { kind: 'live', date: '2026-10-02', snapshotId: null },
    request,
    projectOverrides: [],
    tablePolicy: {},
    rules,
    materials: over.materials ?? OPT_MATERIALS,
    settings: {
      nearLimitPct: null,
      safetyMarginMpa: null,
      yieldTolerance: 0.005,
      roundingTolerance: {},
    },
    characteristics: over.characteristics ?? [],
    strengthRecords: null,
    ...over.snapshot,
  };
  return {
    base,
    objective: over.objective ?? 'cheapest',
    ...(over.include ? { materials: over.include } : {}),
    settings: { ...DEFAULT_OPTIMIZER_SETTINGS, ...over.settings },
  };
}
