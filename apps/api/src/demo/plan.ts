// Deterministic synthetic demo data (Appendix C). Pure: the same seed always yields the same plan.
// Everything it names carries the word SYNTHETIC so demo records can never be mistaken for real ones.
import { createHash } from 'node:crypto';

export const DEMO_SEED = 20261001;
export const SYNTHETIC = 'SYNTHETIC';
export const DEMO_MARKER_CODE = 'DEMO-AMM01-C25';

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DemoMaterial {
  key: string;
  category: 'cement' | 'scm' | 'fine_agg' | 'coarse_agg' | 'water' | 'admixture';
  nameAr: string;
  nameEn: string;
  plant: 'AMM-01' | 'AQB-01' | null;
  supplier: string;
  properties: Record<string, unknown>;
  source: 'supplier_datasheet' | 'lab_report' | 'user_declared';
  /** Days before today the test was done. */
  testedDaysAgo: number;
}
export interface DemoPrice {
  material: string;
  plant: 'AMM-01' | 'AQB-01';
  supplier: string;
  price: string;
  unit: 'JOD/ton' | 'JOD/kg' | 'JOD/L' | 'JOD/m3';
  wave1: string;
  /** Second wave (new price 10 days ago); null leaves the first price in place (a deliberately stale cell). */
  wave2: string | null;
}
export interface DemoPlan {
  seed: number;
  plants: {
    code: 'AMM-01' | 'AQB-01';
    nameEn: string;
    nameAr: string;
    city: string;
    ambientProfile: 'hot' | 'moderate';
  }[];
  suppliers: { nameEn: string; nameAr: string }[];
  materials: DemoMaterial[];
  prices: DemoPrice[];
  legacyCsv: string;
  designs: { code: string; plant: 'AMM-01' | 'AQB-01'; attest: boolean; avgMonthly: number }[];
  settings: { stalePriceDays: number; testAgeLimitDays: number };
}

const grad = (rows: [number, number][]) =>
  [[150, 100] as [number, number], [75, 100] as [number, number], ...rows].map(([s, p]) => ({
    sieve_mm: s,
    passing_pct: p,
  }));
const dec = (n: number, p = 3) => n.toFixed(p);

export function buildDemoPlan(seed: number = DEMO_SEED): DemoPlan {
  const r = prng(seed);
  const jitter = (v: number, pct: number) => v * (1 + (r() * 2 - 1) * pct);
  const plants = [
    {
      code: 'AMM-01' as const,
      nameEn: `Amman (${SYNTHETIC})`,
      nameAr: `عمّان (${'تجريبي'})`,
      city: 'Amman',
      ambientProfile: 'moderate' as const,
    },
    {
      code: 'AQB-01' as const,
      nameEn: `Aqaba (${SYNTHETIC})`,
      nameAr: `العقبة (${'تجريبي'})`,
      city: 'Aqaba',
      ambientProfile: 'hot' as const,
    },
  ];
  const suppliers = [
    { nameEn: `Jordan Cement Co. (${SYNTHETIC})`, nameAr: 'شركة إسمنت الأردن (تجريبي)' },
    { nameEn: `North Aggregates (${SYNTHETIC})`, nameAr: 'ركام الشمال (تجريبي)' },
    { nameEn: `South Aggregates (${SYNTHETIC})`, nameAr: 'ركام الجنوب (تجريبي)' },
    { nameEn: `Admixture Supply (${SYNTHETIC})`, nameAr: 'مورد الإضافات (تجريبي)' },
  ];
  const S = (i: number) => suppliers[i]!.nameEn;
  const materials: DemoMaterial[] = [
    {
      key: 'cem1',
      category: 'cement',
      nameAr: 'إسمنت عادي (تجريبي)',
      nameEn: `CEM I 42.5N (${SYNTHETIC})`,
      plant: null,
      supplier: S(0),
      properties: {
        cement_type: 'CEM I 42.5N',
        sg: 3.15,
        mortar_strength_28d_mpa: 52,
        c3a_pct: 8.5,
        alkali_na2o_eq_pct: 0.6,
      },
      source: 'supplier_datasheet',
      testedDaysAgo: 40,
    },
    {
      key: 'cem2',
      category: 'cement',
      nameAr: 'إسمنت مقاوم للكبريتات (تجريبي)',
      nameEn: `CEM I 42.5N-SR3 (${SYNTHETIC})`,
      plant: null,
      supplier: S(0),
      properties: {
        cement_type: 'CEM I 42.5N-SR3',
        sg: 3.15,
        mortar_strength_28d_mpa: 50,
        c3a_pct: 2.8,
        alkali_na2o_eq_pct: 0.55,
      },
      source: 'supplier_datasheet',
      testedDaysAgo: 40,
    },
    {
      key: 'cem3',
      category: 'cement',
      nameAr: 'إسمنت بوزولاني (تجريبي)',
      nameEn: `CEM II/A-P 42.5N (${SYNTHETIC})`,
      plant: null,
      supplier: S(0),
      properties: {
        cement_type: 'CEM II/A-P 42.5N',
        sg: 3.08,
        mortar_strength_28d_mpa: 48,
        c3a_pct: 7.0,
        pozzolan_pct: 12,
        alkali_na2o_eq_pct: 0.7,
      },
      source: 'supplier_datasheet',
      testedDaysAgo: 40,
    },
    {
      key: 'poz',
      category: 'scm',
      nameAr: 'بوزولان طبيعي (تجريبي)',
      nameEn: `Natural pozzolan (${SYNTHETIC})`,
      plant: null,
      supplier: S(0),
      properties: { scm_type: 'natural_pozzolan', sg: 2.7, alkali_na2o_eq_pct: 1.1 },
      source: 'supplier_datasheet',
      testedDaysAgo: 60,
    },
    {
      key: 'water',
      category: 'water',
      nameAr: 'ماء الخلط (تجريبي)',
      nameEn: `Mixing water (${SYNTHETIC})`,
      plant: null,
      supplier: S(0),
      properties: { water_source: 'municipal', sg: 1, sg_confirmed: true, chloride_mg_l: 120 },
      source: 'user_declared',
      testedDaysAgo: 30,
    },
    {
      key: 'adm-f',
      category: 'admixture',
      nameAr: 'ملدّن عالي المدى (تجريبي)',
      nameEn: `Superplasticizer type F (${SYNTHETIC})`,
      plant: null,
      supplier: S(3),
      properties: {
        type: 'F',
        sg: 1.08,
        solids_pct: 38,
        min_dosage_pct: 0.4,
        max_dosage_pct: 1.6,
        water_reduction_table: [
          { dosage_pct: 0.4, water_reduction_pct: 8 },
          { dosage_pct: 0.8, water_reduction_pct: 16 },
          { dosage_pct: 1.2, water_reduction_pct: 22 },
          { dosage_pct: 1.6, water_reduction_pct: 25 },
        ],
      },
      source: 'supplier_datasheet',
      testedDaysAgo: 50,
    },
    {
      key: 'adm-d',
      category: 'admixture',
      nameAr: 'مؤخّر (تجريبي)',
      nameEn: `Retarder type D (${SYNTHETIC})`,
      plant: null,
      supplier: S(3),
      properties: {
        type: 'D',
        sg: 1.12,
        solids_pct: 30,
        min_dosage_pct: 0.2,
        max_dosage_pct: 1.0,
        water_reduction_table: [
          { dosage_pct: 0.2, water_reduction_pct: 4 },
          { dosage_pct: 0.4, water_reduction_pct: 7 },
          { dosage_pct: 0.7, water_reduction_pct: 9 },
          { dosage_pct: 1.0, water_reduction_pct: 10 },
        ],
      },
      source: 'supplier_datasheet',
      testedDaysAgo: 50,
    },
  ];
  // six aggregates per plant, Jordanian market names; Aqaba's carry a place suffix so names stay unique
  const aggs: {
    id: string;
    ar: string;
    en: string;
    cat: 'fine_agg' | 'coarse_agg';
    sg: number;
    abs: number;
    fines: number;
    rows: [number, number][];
  }[] = [
    {
      id: 'raml',
      ar: 'رمل',
      en: 'Raml (washed sand)',
      cat: 'fine_agg',
      sg: 2.62,
      abs: 1.3,
      fines: 2.2,
      rows: [
        [9.5, 100],
        [4.75, 97],
        [2.36, 82],
        [1.18, 62],
        [0.6, 40],
        [0.3, 17],
        [0.15, 4],
      ],
    },
    {
      id: 'naeema',
      ar: 'ناعمة',
      en: 'Naeema (crusher fines)',
      cat: 'fine_agg',
      sg: 2.68,
      abs: 1.9,
      fines: 9.0,
      rows: [
        [9.5, 100],
        [4.75, 95],
        [2.36, 70],
        [1.18, 48],
        [0.6, 33],
        [0.3, 22],
        [0.15, 12],
      ],
    },
    {
      id: 'simsimiyeh',
      ar: 'سمسمية',
      en: 'Simsimiyeh (4.75-9.5 mm)',
      cat: 'coarse_agg',
      sg: 2.66,
      abs: 1.1,
      fines: 0.9,
      rows: [
        [19, 100],
        [12.5, 100],
        [9.5, 90],
        [4.75, 18],
        [2.36, 3],
      ],
    },
    {
      id: 'adasiyeh',
      ar: 'عدسية',
      en: 'Adasiyeh (9.5-12.5 mm)',
      cat: 'coarse_agg',
      sg: 2.65,
      abs: 0.9,
      fines: 0.7,
      rows: [
        [19, 100],
        [12.5, 92],
        [9.5, 40],
        [4.75, 5],
        [2.36, 1],
      ],
    },
    {
      id: 'fuliyeh',
      ar: 'فولية',
      en: 'Fuliyeh (12.5-19 mm)',
      cat: 'coarse_agg',
      sg: 2.65,
      abs: 1.2,
      fines: 0.6,
      rows: [
        [25, 100],
        [19, 90],
        [12.5, 38],
        [9.5, 12],
        [4.75, 2],
      ],
    },
    {
      id: 'hummusiyeh',
      ar: 'حمصية',
      en: 'Hummusiyeh (19-25 mm)',
      cat: 'coarse_agg',
      sg: 2.64,
      abs: 1.0,
      fines: 0.5,
      rows: [
        [37.5, 100],
        [25, 90],
        [19, 40],
        [12.5, 8],
        [9.5, 2],
      ],
    },
  ];
  for (const plant of plants) {
    const north = plant.code === 'AMM-01';
    for (const a of aggs) {
      const suffix = north ? '' : ' العقبة';
      materials.push({
        key: `${a.id}-${plant.code}`,
        category: a.cat,
        nameAr: `${a.ar}${suffix}`,
        nameEn: `${a.en}${north ? '' : ' - Aqaba'} (${SYNTHETIC})`,
        plant: plant.code,
        supplier: north ? S(1) : S(2),
        properties: {
          sg_ssd: Number(jitter(a.sg, 0.005).toFixed(3)),
          absorption_pct: Number(jitter(a.abs, 0.08).toFixed(2)),
          finer_75um_pct: Number(jitter(a.fines, 0.1).toFixed(1)),
          sieve_analysis: grad(a.rows),
          ...(a.cat === 'fine_agg' ? {} : { la_abrasion_pct: Number(jitter(26, 0.1).toFixed(0)) }),
        },
        source: 'supplier_datasheet',
        testedDaysAgo: 20 + Math.floor(r() * 80),
      });
    }
  }
  // the one expired test (older than the demo test-age limit of 365 days)
  materials.find((m) => m.key === 'naeema-AQB-01')!.testedDaysAgo = 500;
  materials.find((m) => m.key === 'fuliyeh-AMM-01')!.source = 'lab_report';

  const base: Record<string, [number, DemoPrice['unit']]> = {
    cement: [78, 'JOD/ton'],
    scm: [45, 'JOD/ton'],
    fine_agg: [9, 'JOD/ton'],
    coarse_agg: [8, 'JOD/ton'],
    water: [0.9, 'JOD/m3'],
    admixture: [1.6, 'JOD/L'],
  };
  const prices: DemoPrice[] = [];
  for (const m of materials) {
    for (const plant of plants) {
      if (m.plant && m.plant !== plant.code) continue;
      if (m.key === 'hummusiyeh-AQB-01') continue; // deliberately unpriced at Aqaba
      const [b, unit] = base[m.category]!;
      const p1 = jitter(b * (plant.code === 'AQB-01' ? 1.06 : 1), 0.04);
      const raise = 1 + 0.03 + r() * 0.03;
      const stale = m.key === 'simsimiyeh-AMM-01'; // one stale cell: no second wave
      prices.push({
        material: m.key,
        plant: plant.code,
        supplier: m.supplier,
        price: dec(p1),
        unit,
        wave1: dec(p1),
        wave2: stale ? null : dec(p1 * raise),
      });
    }
  }
  // legacy designs: 3 per plant
  const header =
    'design_code,plant_code,design_name,fc_mpa,strength_basis,test_age_days,exposure_classes,slump_mm,nmas_mm,pumpable,material_name,material_category,quantity,unit,approval_reference,currently_in_production,avg_monthly_volume_m3';
  const lines: string[] = [header];
  const designs: DemoPlan['designs'] = [];
  const specs = [
    {
      code: 'C25',
      fc: 25,
      cem: 330,
      w: 180,
      slump: 100,
      nmas: 25,
      exp: 'F0;S0;W0;C0',
      pump: false,
      attest: true,
    },
    {
      code: 'C30',
      fc: 30,
      cem: 360,
      w: 175,
      slump: 125,
      nmas: 19,
      exp: 'F0;S0;W0;C1',
      pump: true,
      attest: true,
    },
    {
      code: 'C35',
      fc: 35,
      cem: 390,
      w: 170,
      slump: 150,
      nmas: 19,
      exp: 'F1;S1;W1;C1',
      pump: true,
      attest: false,
    },
  ];
  for (const plant of plants) {
    const tag = plant.code.replace('-', '');
    const suffix = plant.code === 'AMM-01' ? '' : ' العقبة';
    for (const s of specs) {
      const code = `DEMO-${tag}-${s.code}`;
      const avg = Math.round(jitter(s.code === 'C30' ? 2400 : s.code === 'C25' ? 1500 : 600, 0.1));
      designs.push({ code, plant: plant.code, attest: s.attest, avgMonthly: avg });
      const head = `${code},${plant.code},${s.code} ${plant.code} (${SYNTHETIC}),${s.fc},cylinder,28,${s.exp},${s.slump},${s.nmas},${s.pump},`;
      const tail = (ref: boolean) =>
        `,${ref ? `SYNTHETIC submittal ${tag}-${s.code}` : ''},true,${avg}`;
      const add = (name: string, cat: string, qty: number, unit = 'kg/m3') =>
        lines.push(`${head}${name},${cat},${qty},${unit}${tail(true)}`);
      const fine = Math.round(jitter(760, 0.04));
      const coarse = Math.round(2380 - s.cem - s.w - fine - 5);
      add('إسمنت عادي (تجريبي)', 'cement', s.cem);
      add('ماء الخلط (تجريبي)', 'water', s.w);
      add(`رمل${suffix}`, 'fine_agg', fine);
      add(`ناعمة${suffix}`, 'fine_agg', Math.round(fine * 0.25));
      add(`عدسية${suffix}`, 'coarse_agg', Math.round(coarse * 0.35));
      add(`فولية${suffix}`, 'coarse_agg', Math.round(coarse * 0.65 - fine * 0.25));
      add(
        'ملدّن عالي المدى (تجريبي)',
        'admixture',
        Number(((s.cem * 0.01) / 1.08).toFixed(2)),
        'L/m3',
      );
    }
  }
  return {
    seed,
    plants,
    suppliers,
    materials,
    prices,
    legacyCsv: lines.join('\n'),
    designs,
    settings: { stalePriceDays: 30, testAgeLimitDays: 365 },
  };
}

/** Stable fingerprint of a plan (used to prove determinism). */
export const planHash = (p: DemoPlan) =>
  createHash('sha256').update(JSON.stringify(p)).digest('hex');
