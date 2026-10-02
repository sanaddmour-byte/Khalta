// Requested vs achieved for the characteristics a given set of proportions can be judged against
// (07 §4.5). USER_SPECIFIED rows: shown as the user's choice, never mixed with code compliance.
import { idOf, type ResolvedCharacteristic } from './resolve';
import type {
  CharacteristicRow,
  EvaluationSnapshot,
  Figures,
  EvidenceStatus,
} from '../evaluate/types';

const EXACT = 1e-6;

const UNIT: Record<string, string> = {
  wcm: 'ratio',
  binder_kg: 'kg/m3',
  cement_kg: 'kg/m3',
  scm: '%',
  water_kg: 'kg/m3',
  air_pct: '%',
  admixture: '%',
  sand_ratio_pct: '%',
  agg_share_pct: '%',
  agg_kg: 'kg/m3',
  paste_l: 'L/m3',
  fm_combined: 'none',
  passing_pct: '%',
  'shilstone.cf': 'none',
  'shilstone.wf': 'none',
  fines_max_pct: '%',
  fresh_density_kg_m3: 'kg/m3',
  slump_mm: 'mm',
  nmas_mm: 'mm',
  extra_margin_mpa: 'MPa',
  fcr_mpa: 'MPa',
  max_cost_jod_m3: 'JOD/m3',
};

const f = (v: number) => String(Math.round(v * 1e6) / 1e6);

export function describeSpec(c: ResolvedCharacteristic): string {
  const s = c.spec;
  const product = typeof s['product'] === 'string' ? `${s['product']} ` : '';
  if (s.mode === 'fixed') {
    const v = c.key === 'scm' ? (s['pct'] as number | undefined) : s.value;
    return `${product}= ${v === undefined ? (s['dosage_level'] !== undefined ? `level ${s['dosage_level']}` : '') : f(v)}`.trim();
  }
  if (s.mode === 'target') return `target ${f(s.value as number)}`;
  if (s.mode === 'range') {
    if (s.min !== undefined && s.max !== undefined)
      return `${product}${f(s.min)}–${f(s.max)}`.trim();
    return s.max !== undefined
      ? `${product}≤ ${f(s.max)}`.trim()
      : `${product}≥ ${f(s.min as number)}`.trim();
  }
  if (s.mode === 'list') return `one of ${(s['values'] as number[]).map(f).join(', ')}`;
  return s.mode;
}

interface Achieved {
  value: number | string | null;
  figure?: string;
  evidence?: EvidenceStatus[];
  detail?: string;
}

function achievedOf(c: ResolvedCharacteristic, s: EvaluationSnapshot, fig: Figures): Achieved {
  const n = (k: string): number | null => {
    const v = fig[k];
    return typeof v === 'number' ? v : null;
  };
  const sub = c.sub;
  switch (c.key) {
    case 'wcm':
      return { value: n('ratio.wcm') };
    case 'binder_kg':
      return { value: n('mass.binder') };
    case 'cement_kg':
      return { value: n('mass.cement') };
    case 'water_kg':
      return { value: n('mass.water') };
    case 'scm':
      return { value: n(`scm.pct.line.${c.spec['product']}`) };
    case 'admixture':
      return { value: n(`dosage.${c.spec['product']}`) };
    case 'air_pct': {
      const a = n('volume.air');
      return {
        value: a === null ? null : a * 100,
        evidence: s.request.airPct === null ? ['MODEL_BASELINE'] : [],
      };
    }
    case 'sand_ratio_pct':
      return {
        value: n(
          c.spec['basis'] === 'volume' ? 'agg.sand_ratio_volume_pct' : 'agg.sand_ratio_mass_pct',
        ),
      };
    case 'agg_share_pct':
      return { value: n(`agg.share_pct.${sub}`) };
    case 'agg_kg': {
      const l = s.lines.find((x) => x.materialId === sub);
      return { value: l ? Number(l.kgPerM3) : null };
    }
    case 'paste_l':
      return { value: n('agg.paste_l') };
    case 'fm_combined':
      return { value: n('agg.fm_combined') };
    case 'passing_pct':
      return { value: n(`agg.passing.${sub}`) };
    case 'fresh_density_kg_m3':
      return { value: n('mass.fresh_density') };
    case 'slump_mm':
      return { value: s.request.slumpMm };
    case 'nmas_mm':
      return { value: s.request.nmasMm };
    case 'extra_margin_mpa':
      return {
        value: n('fcr.total') === null ? null : (c.spec.value as number),
        evidence: ['USER_OVERRIDE'],
      };
    case 'fcr_mpa':
      return { value: n('fcr.total') };
    case 'max_cost_jod_m3': {
      const t = fig['cost.total'];
      return { value: typeof t === 'string' ? Number(t) : null };
    }
    default:
      return { value: null, detail: 'evaluated from M3.1 (grading guardrails)' };
  }
}

export function achievedRows(
  chars: readonly ResolvedCharacteristic[],
  s: EvaluationSnapshot,
  fig: Figures,
): CharacteristicRow[] {
  return chars.map((c): CharacteristicRow => {
    const a = achievedOf(c, s, fig);
    const spec = c.spec;
    const tol = Math.max(s.settings.roundingTolerance[c.key] ?? 0, EXACT);
    const v = typeof a.value === 'number' ? a.value : null;
    let status: CharacteristicRow['status'] = 'not_evaluated';
    let delta: number | null = null;
    let detail = a.detail;
    if (v !== null) {
      const want =
        c.key === 'scm' ? spec['pct'] : c.key === 'admixture' ? spec['dosage_pct'] : spec.value;
      if ((spec.mode === 'fixed' || spec.mode === 'target') && typeof want === 'number') {
        delta = v - want;
        status = Math.abs(delta) <= tol ? 'met' : 'deviated';
      } else if (spec.mode === 'range') {
        const lo = spec.min;
        const hi = spec.max;
        const below = lo !== undefined && v < lo - tol;
        const above = hi !== undefined && v > hi + tol;
        delta = below ? v - lo! : above ? v - hi! : 0;
        status = below || above ? 'deviated' : 'met';
      } else if (spec.mode === 'list') {
        status = (spec['values'] as number[]).includes(v) ? 'met' : 'deviated';
      } else detail = 'the requested dosage level is compared from M3.1';
    }
    return {
      key: idOf(c),
      requested: describeSpec(c),
      achieved: v === null && typeof a.value === 'string' ? a.value : v,
      unit: UNIT[c.key] ?? 'none',
      delta: delta === null ? null : Math.round(delta * 1e6) / 1e6,
      status,
      origin: c.origin,
      klass: 'USER_SPECIFIED',
      blocker:
        status === 'not_evaluated'
          ? {
              code: 'input_missing',
              detail: detail ?? 'the value cannot be computed from the given proportions',
            }
          : null,
      evidence: a.evidence ?? [],
    };
  });
}
