// Quantities derived from the given proportions: absolute volume, yield, binder, w/cm, SCM shares,
// admixture dosage, chlorides, combined gradation. Every figure is traced (formula + named inputs).
import { fineModulus, type GradationPoint } from '../materials/gradation';
import { DEFAULT_FM_SIEVES } from '../materials/sieves';
import type {
  EvalBlocker,
  DesignRequestInput,
  EvaluationSnapshot,
  QualityItem,
  SnapshotMaterial,
} from './types';
import { isNum, numProp, propOf, sgField, type RuleIndex, type Tracer } from './util';

export interface BlendLine {
  id: string;
  material: SnapshotMaterial | undefined;
  category: SnapshotMaterial['category'];
  kg: number;
  sg: number | null;
  volume: number | null;
}

export interface Blend {
  lines: BlendLine[];
  binderKg: number;
  cementKg: number;
  scmKg: number;
  scmByType: Record<string, number>;
  /** SCM lines whose type is not recorded (type-specific limits cannot be evaluated). */
  scmTypeMissing: string[];
  freeWaterKg: number | null;
  waterBlocker: EvalBlocker | null;
  wcm: number | null;
  totalVolume: number | null;
  airPct: number | null;
  airSource: 'design' | 'baseline' | null;
  airBlocker: EvalBlocker | null;
  freshDensity: number;
  aggregateKg: number;
  fineKg: number;
  dosagePct: Map<string, number>;
  missingMinimum: { materialId: string; field: string }[];
  quality: QualityItem[];
  assumptions: string[];
}

export function lineMap(s: EvaluationSnapshot) {
  const mats = new Map(s.materials.map((m) => [m.id, m]));
  return s.lines.map((l) => ({
    id: l.materialId,
    kg: Number(l.kgPerM3),
    m: mats.get(l.materialId),
  }));
}

/** ACI 211.1 entrapped air for the NMAS (information baseline; `null` when it cannot be read). */
export type AirBaseline = (
  nmas: number,
) => { value: number; clause: string | null } | { blocker: EvalBlocker };

export function computeBlend(
  s: EvaluationSnapshot,
  rules: RuleIndex,
  tr: Tracer,
  entrappedAir: (
    req: DesignRequestInput,
  ) => { value: number; clause: string | null } | { blocker: EvalBlocker },
): Blend {
  const quality: QualityItem[] = [];
  const assumptions: string[] = [];
  const missingMinimum: Blend['missingMinimum'] = [];
  const lines: BlendLine[] = lineMap(s).map(({ id, kg, m }) => {
    const category = m?.category ?? 'cement';
    const field = sgField(category);
    let sg = numProp(m, field) ?? null;
    if (category === 'water' && sg === null) {
      sg = 1;
      quality.push({
        code: 'water_sg_defaulted',
        severity: 'warning',
        materialId: id,
        detail: 'water specific gravity is not on file; 1.000 was used and is not confirmed',
        evidence: ['INPUT_MISSING'],
      });
      assumptions.push(
        'Water specific gravity taken as 1.000 (not confirmed in the material record).',
      );
    } else if (sg === null) missingMinimum.push({ materialId: id, field });
    return { id, material: m, category, kg, sg, volume: sg === null ? null : kg / (sg * 1000) };
  });

  const sum = (f: (l: BlendLine) => boolean) => lines.filter(f).reduce((a, l) => a + l.kg, 0);
  const cementKg = sum((l) => l.category === 'cement');
  const scmKg = sum((l) => l.category === 'scm');
  const binderKg = cementKg + scmKg;
  const scmByType: Record<string, number> = {};
  const scmTypeMissing: string[] = [];
  for (const l of lines.filter((x) => x.category === 'scm')) {
    const t = propOf(l.material, 'scm_type');
    if (typeof t !== 'string') scmTypeMissing.push(l.id);
    else scmByType[t] = (scmByType[t] ?? 0) + l.kg;
  }

  // ---- free water (added water, plus admixture water where the product says it counts)
  let freeWater = sum((l) => l.category === 'water');
  const hasWater = lines.some((l) => l.category === 'water');
  let waterBlocker: EvalBlocker | null = null;
  const admixLines = lines.filter((l) => l.category === 'admixture');
  const admixInputs: Record<string, number | string | null> = {};
  for (const l of admixLines) {
    const convention = propOf(l.material, 'water_convention');
    if (convention === 'liquid_counts_as_water') {
      const solids = numProp(l.material, 'solids_pct');
      if (solids === undefined) {
        waterBlocker = {
          code: 'input_missing',
          detail: 'admixture solids content is not on file, so its water cannot be counted',
        };
      } else {
        const w = l.kg * (1 - solids / 100);
        freeWater += w;
        admixInputs[`admixtureWater.${l.id}`] = w;
      }
    } else if (convention === undefined) {
      quality.push({
        code: 'admixture_water_convention_missing',
        severity: 'warning',
        materialId: l.id,
        detail: 'the admixture water convention is not set; its water is not counted in w/cm',
        evidence: ['INPUT_MISSING'],
      });
    }
  }
  if (!hasWater && waterBlocker === null)
    waterBlocker = { code: 'input_missing', detail: 'the design has no water line' };
  const freeWaterKg = waterBlocker ? null : freeWater;
  tr.add(
    'mass.water',
    freeWaterKg,
    'kg/m3',
    'free water = water lines + admixture water where the product counts its liquid as water',
    { waterLines: sum((l) => l.category === 'water'), ...admixInputs },
  );
  tr.add('mass.cement', cementKg, 'kg/m3', 'Σ cement lines', {});
  tr.add('mass.scm', scmKg, 'kg/m3', 'Σ SCM lines', {});
  tr.add('mass.binder', binderKg, 'kg/m3', 'cement + SCM', { cement: cementKg, scm: scmKg });
  const wcm = freeWaterKg !== null && binderKg > 0 ? freeWaterKg / binderKg : null;
  tr.add('ratio.wcm', wcm, 'ratio', 'w/cm = free water ÷ (cement + SCM)', {
    water: freeWaterKg,
    binder: binderKg,
  });
  const fresh = lines.reduce((a, l) => a + l.kg, 0);
  tr.add('mass.fresh_density', fresh, 'kg/m3', 'Σ all lines (air has no mass)', {});

  // ---- air and absolute volume
  let airPct: number | null = null;
  let airSource: Blend['airSource'] = null;
  let airBlocker: EvalBlocker | null = null;
  if (s.request.airPct !== null) {
    airPct = s.request.airPct;
    airSource = 'design';
  } else {
    const base = entrappedAir(s.request);
    if ('blocker' in base) airBlocker = base.blocker;
    else {
      airPct = base.value;
      airSource = 'baseline';
      assumptions.push(
        `Air content ${base.value} % is the ACI 211.1 entrapped-air value for the NMAS (MODEL_BASELINE), not a measured value.`,
      );
    }
  }
  for (const l of lines)
    tr.add(
      `volume.${l.id}`,
      l.volume,
      'm3',
      'volume = kg ÷ (SG × 1000)',
      { kg: l.kg, sg: l.sg },
      l.sg === null ? { evidence: ['INPUT_MISSING'] } : {},
    );
  tr.add(
    'volume.air',
    airPct === null ? null : airPct / 100,
    'm3',
    'air volume = air % ÷ 100',
    { airPct },
    airSource === 'baseline'
      ? { evidence: ['MODEL_BASELINE'], ruleKey: 'prop.air_entrapped.non_ae' }
      : airPct === null
        ? { evidence: ['INPUT_MISSING'] }
        : {},
  );
  const complete = lines.every((l) => l.volume !== null) && airPct !== null;
  const total = complete
    ? lines.reduce((a, l) => a + (l.volume as number), 0) + (airPct as number) / 100
    : null;
  tr.add('volume.total', total, 'm3', 'Σ absolute volumes + air', {
    lines: lines.length,
    air: airPct === null ? null : airPct / 100,
  });
  tr.add('yield.delta', total === null ? null : total - 1, 'm3', 'total volume − 1.000', { total });

  // ---- SCM shares and admixture dosage
  const typesKnown = scmTypeMissing.length === 0 && binderKg > 0;
  const share = (kg: number) => (binderKg > 0 ? (kg / binderKg) * 100 : null);
  const t = (k: string) => scmByType[k] ?? 0;
  const pozz = t('fly_ash') + t('natural_pozzolan');
  tr.add(
    'scm.pct.total',
    typesKnown ? share(t('fly_ash') + t('natural_pozzolan') + t('ggbs') + t('silica_fume')) : null,
    '%',
    'SCM % of cementitious = (fly ash + pozzolan + slag + silica fume) ÷ (cement + SCM); limestone filler is not counted',
    {
      binder: binderKg,
    },
  );
  tr.add(
    'scm.pct.fly_ash_pozzolan',
    typesKnown ? share(pozz) : null,
    '%',
    '(fly ash + natural pozzolan) ÷ (cement + SCM)',
    { binder: binderKg },
  );
  tr.add(
    'scm.pct.slag',
    typesKnown ? share(t('ggbs')) : null,
    '%',
    'slag (GGBS) ÷ (cement + SCM)',
    { binder: binderKg },
  );
  tr.add(
    'scm.pct.silica_fume',
    typesKnown ? share(t('silica_fume')) : null,
    '%',
    'silica fume ÷ (cement + SCM)',
    { binder: binderKg },
  );
  tr.add(
    'scm.pct.fly_ash_silica_fume',
    typesKnown ? share(pozz + t('silica_fume')) : null,
    '%',
    '(fly ash + natural pozzolan + silica fume) ÷ (cement + SCM)',
    { binder: binderKg },
  );
  if (t('limestone_filler') > 0)
    quality.push({
      code: 'limestone_not_counted',
      severity: 'info',
      detail:
        'limestone filler is not counted as an SCM in the SCM limits; confirm this against the project specification',
    });

  for (const l of lines.filter((x) => x.category === 'scm'))
    tr.add(`scm.pct.line.${l.id}`, share(l.kg), '%', 'SCM line ÷ (cement + SCM) × 100', {
      kg: l.kg,
      binder: binderKg,
    });

  const dosagePct = new Map<string, number>();
  for (const l of admixLines) {
    if (binderKg > 0) {
      dosagePct.set(l.id, (l.kg / binderKg) * 100);
      tr.add(
        `dosage.${l.id}`,
        (l.kg / binderKg) * 100,
        '%',
        'dosage = admixture kg ÷ (cement + SCM) × 100',
        {
          kg: l.kg,
          binder: binderKg,
        },
      );
    }
  }

  // ---- aggregates
  const aggs = lines.filter((l) => l.category === 'fine_agg' || l.category === 'coarse_agg');
  const aggregateKg = aggs.reduce((a, l) => a + l.kg, 0);
  const fineKg = aggs.filter((l) => l.category === 'fine_agg').reduce((a, l) => a + l.kg, 0);
  tr.add('agg.total_kg', aggregateKg, 'kg/m3', 'Σ aggregate lines', {});
  const aggVol = aggs.reduce<number | null>(
    (a, l) => (a === null || l.volume === null ? null : a + l.volume),
    0,
  );
  tr.add(
    'agg.sand_ratio_mass_pct',
    aggregateKg > 0 ? (fineKg / aggregateKg) * 100 : null,
    '%',
    'fine aggregate mass ÷ total aggregate mass × 100',
    { fine: fineKg, total: aggregateKg },
  );
  const fineVol = aggs
    .filter((l) => l.category === 'fine_agg')
    .reduce<number | null>((a, l) => (a === null || l.volume === null ? null : a + l.volume), 0);
  tr.add(
    'agg.sand_ratio_volume_pct',
    aggVol && aggVol > 0 && fineVol !== null ? (fineVol / aggVol) * 100 : null,
    '%',
    'fine aggregate volume ÷ total aggregate volume × 100',
    { fine: fineVol, total: aggVol },
  );
  for (const l of aggs)
    tr.add(
      `agg.share_pct.${l.id}`,
      aggregateKg > 0 ? (l.kg / aggregateKg) * 100 : null,
      '%',
      'aggregate mass ÷ total aggregate mass × 100',
      { kg: l.kg, total: aggregateKg },
    );
  tr.add(
    'agg.paste_l',
    aggVol === null ? null : 1000 * (1 - aggVol),
    'L/m3',
    'paste (everything but aggregate) = 1000 × (1 − Σ aggregate volumes)',
    {
      aggregateVolume: aggVol,
    },
  );

  return {
    lines,
    binderKg,
    cementKg,
    scmKg,
    scmByType,
    scmTypeMissing,
    freeWaterKg,
    waterBlocker,
    wcm,
    totalVolume: total,
    airPct,
    airSource,
    airBlocker,
    freshDensity: fresh,
    aggregateKg,
    fineKg,
    dosagePct,
    missingMinimum,
    quality,
    assumptions,
  };
}

// ---------------------------------------------------------------- combined gradation

/** % passing at `sieve` for one aggregate: entered, or forced by the data (see `fineModulus`). */
export function passingAt(points: readonly GradationPoint[], sieve: number): number | null {
  const exact = points.find((p) => p.sieve_mm === sieve);
  if (exact) return exact.passing_pct;
  if (points.some((p) => p.sieve_mm < sieve && p.passing_pct === 100)) return 100;
  if (points.some((p) => p.sieve_mm > sieve && p.passing_pct === 0)) return 0;
  return null;
}

export function combinedPassing(blend: Blend, sieve: number): number | null {
  const aggs = blend.lines.filter((l) => l.category === 'fine_agg' || l.category === 'coarse_agg');
  if (aggs.length === 0 || blend.aggregateKg <= 0) return null;
  let acc = 0;
  for (const l of aggs) {
    const pts = propOf(l.material, 'sieve_analysis') as GradationPoint[] | undefined;
    const p = pts ? passingAt(pts, sieve) : null;
    if (p === null) return null;
    acc += l.kg * p;
  }
  return acc / blend.aggregateKg;
}

export function combinedFm(blend: Blend, series: readonly number[]): number | null {
  const pts: GradationPoint[] = [];
  for (const s of series) {
    const p = combinedPassing(blend, s);
    if (p !== null) pts.push({ sieve_mm: s, passing_pct: p });
  }
  const fm = fineModulus(pts, series);
  return fm.ok ? fm.fm : null;
}

export const fmSeries = (rules: RuleIndex): readonly number[] => {
  const v = rules.value('ENGINEERING', 'eng.fm.sieves', false);
  return Array.isArray(v) && v.every(isNum) ? (v as number[]) : DEFAULT_FM_SIEVES;
};
