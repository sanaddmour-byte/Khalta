// Test helpers: the real ACI/JS/shared/engineering seeds and a small synthetic design (SYNTHETIC: not a
// real plant design). Hand-checkable numbers; see the fixtures for the expected values.
import { loadSeeds } from '@khalta/rules/loader';
import type { EvaluationSnapshot, SnapshotMaterial } from '../evaluate/types';
import { selectRules } from '../evaluate/select';

export const ALL_RULES = loadSeeds().rules;

export const gradation = (rows: Record<string, number>) =>
  Object.entries(rows).map(([sieve, p]) => ({ sieve_mm: Number(sieve), passing_pct: p }));

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

export const MATERIALS: SnapshotMaterial[] = [
  {
    id: 'cem',
    category: 'cement',
    nameEn: 'CEM I 42.5N',
    nameAr: null,
    test: test({ sg: 3.15, c3a_pct: 7.5 }),
    price: price('75'),
  },
  {
    id: 'sand',
    category: 'fine_agg',
    nameEn: 'Raml',
    nameAr: null,
    test: test({
      sg_ssd: 2.6,
      absorption_pct: 1.5,
      chlorides_pct: 0.01,
      sieve_analysis: gradation({
        '9.5': 100,
        '4.75': 98,
        '2.36': 80,
        '1.18': 55,
        '0.6': 35,
        '0.3': 15,
        '0.15': 5,
      }),
    }),
    price: price('8'),
  },
  {
    id: 'coarse',
    category: 'coarse_agg',
    nameEn: 'Fooliyyeh',
    nameAr: null,
    test: test({
      sg_ssd: 2.65,
      absorption_pct: 1.0,
      chlorides_pct: 0.005,
      sieve_analysis: gradation({
        '25': 100,
        '19': 95,
        '12.5': 40,
        '9.5': 15,
        '4.75': 3,
        '2.36': 0,
      }),
    }),
    price: price('7'),
  },
  {
    id: 'water',
    category: 'water',
    nameEn: 'Water',
    nameAr: null,
    test: test({ sg: 1.0, sg_confirmed: true, chloride_mg_l: 200 }),
    price: price('0.5'),
  },
  {
    id: 'sp',
    category: 'admixture',
    nameEn: 'SP Type F',
    nameAr: null,
    test: test({
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
    }),
    price: price('1.2', 'JOD/kg'),
  },
];

export const LINES = [
  { materialId: 'cem', kgPerM3: '350.000' },
  { materialId: 'water', kgPerM3: '175.000' },
  { materialId: 'sp', kgPerM3: '3.500' },
  { materialId: 'sand', kgPerM3: '780.000' },
  { materialId: 'coarse', kgPerM3: '1035.000' },
];

export function makeSnapshot(over: Partial<EvaluationSnapshot> = {}): EvaluationSnapshot {
  const base: EvaluationSnapshot = {
    schema: 1,
    design: { id: 'd1', code: 'SYN-C30', name: 'Synthetic C30', plantId: 'plant' },
    mode: 'ACI',
    evaluationDate: '2026-10-02',
    priceBasis: { kind: 'live', date: '2026-10-02', snapshotId: null },
    request: {
      fcMpa: 30,
      basis: 'cylinder',
      testAgeDays: 28,
      exposure: ['F0', 'S0', 'W0', 'C1'],
      s3Option: null,
      slumpMm: 100,
      nmasMm: 19,
      pumpable: true,
      airPct: 2,
    },
    projectOverrides: [],
    tablePolicy: {},
    rules: [],
    lines: LINES,
    materials: MATERIALS,
    settings: {
      nearLimitPct: null,
      safetyMarginMpa: null,
      yieldTolerance: 0.005,
      roundingTolerance: {},
    },
    characteristics: [],
    strengthRecords: null,
  };
  const s = { ...base, ...over };
  if (!over.rules) s.rules = selectRules(ALL_RULES, s.mode, s.request);
  return s;
}
