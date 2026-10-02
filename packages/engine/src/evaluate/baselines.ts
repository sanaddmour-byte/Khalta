// ACI 211.1 design aids used as INFORMATION next to the design: entrapped air, w/c for f'cr, mixing water.
// They are published heuristics (MODEL_BASELINE), never plant predictions and never compliance.
import { applicability, lookupTable, type Context, type TableDefinition } from '@khalta/rules';
import type {
  EvalBlocker,
  DesignRequestInput,
  SnapshotMaterial,
  StrengthAdequacy,
  WaterBaseline,
} from './types';
import type { Blend } from './blend';
import { propOf, round6, type RuleIndex, type Tracer } from './util';

type Table = { def: TableDefinition; key: string; clause: string | null };
type TableOrBlocker = { table: Table } | { blocker: EvalBlocker };

/** The ACI 211.1 table `prop.<name>.*` that applies for this request (air-entrained or not). */
function findTable(rules: RuleIndex, prefix: string, ctx: Context): TableOrBlocker {
  const candidates = rules.rules.filter(
    (r) =>
      r.ruleset === 'ACI' && r.key.startsWith(prefix) && applicability(r, ctx).applies === 'yes',
  );
  if (candidates.length === 0)
    return {
      blocker: {
        code: 'rule_not_on_file',
        detail: `${prefix}* table is not on file for this request${ctx.air_entrained ? ' (air-entrained design)' : ''}`,
      },
    };
  const r = candidates[0]!;
  const def = rules.value('ACI', r.key) as TableDefinition | null;
  if (!def)
    return {
      blocker: {
        code: 'rule_not_on_file',
        detail: `${r.key} is not on file${ctx.air_entrained ? ' (air-entrained design is not supported yet)' : ''}`,
      },
    };
  return { table: { def, key: r.key, clause: r.clause_ref } };
}

const domainBlocker = (what: string, domain: [number, number], x: number): EvalBlocker => ({
  code: 'out_of_domain',
  detail: `${what} ${x} is outside the table domain ${domain[0]}–${domain[1]} (no extrapolation)`,
});

export function entrappedAir(
  req: DesignRequestInput,
  rules: RuleIndex,
  ctx: Context,
): { value: number; clause: string | null; key: string } | { blocker: EvalBlocker } {
  if (req.nmasMm === null)
    return {
      blocker: {
        code: 'input_missing',
        detail: 'NMAS is not stated, so entrapped air cannot be estimated',
      },
    };
  const t = findTable(rules, 'prop.air_entrapped.', ctx);
  if ('blocker' in t) return t;
  const r = lookupTable(t.table.def, { col: req.nmasMm });
  if (r.status === 'ok') return { value: r.value, clause: t.table.clause, key: t.table.key };
  if (r.status === 'out_of_domain') return { blocker: domainBlocker('NMAS', r.domain, req.nmasMm) };
  return {
    blocker: {
      code: 'rule_not_on_file',
      detail: `${t.table.key} has no value at NMAS ${req.nmasMm} mm`,
    },
  };
}

export function strengthAdequacy(
  fcr: number | null,
  designWcm: number | null,
  rules: RuleIndex,
  ctx: Context,
  tr: Tracer,
): StrengthAdequacy {
  const base: StrengthAdequacy = {
    label: 'not_a_compliance_result',
    model: 'none',
    fcrMpa: fcr,
    baselineWc: null,
    designWcm,
    comparison: null,
    evidence: ['MODEL_BASELINE', 'TRIAL_REQUIRED'],
    blocker: null,
    clause: null,
  };
  if (fcr === null)
    return {
      ...base,
      blocker: { code: 'input_missing', detail: "required average strength f'cr is not available" },
    };
  const t = findTable(rules, 'prop.wc_strength.', ctx);
  if ('blocker' in t) return { ...base, blocker: t.blocker };
  const r = lookupTable(t.table.def, { col: fcr });
  if (r.status !== 'ok') {
    const blocker: EvalBlocker =
      r.status === 'out_of_domain'
        ? domainBlocker("f'cr", r.domain, fcr)
        : { code: 'rule_not_on_file', detail: `${t.table.key} has no value at f'cr ${fcr} MPa` };
    return { ...base, clause: t.table.clause, blocker };
  }
  tr.add(
    'baseline.wc',
    r.value,
    'ratio',
    "ACI 211.1 w/c for f'cr, interpolated linearly (baseline, not a plant model)",
    { fcr },
    {
      ruleKey: t.table.key,
      ...(t.table.clause ? { clause: t.table.clause } : {}),
      evidence: ['MODEL_BASELINE', 'TRIAL_REQUIRED'],
    },
  );
  const wc = r.value;
  const above = designWcm !== null && designWcm > wc + 1e-9;
  return {
    ...base,
    baselineWc: wc,
    clause: t.table.clause,
    comparison:
      designWcm === null ? null : above ? 'design_above_baseline' : 'design_at_or_below_baseline',
    evidence: above
      ? ['MODEL_BASELINE', 'TRIAL_REQUIRED', 'MODEL_PREDICTS_SHORTFALL']
      : ['MODEL_BASELINE', 'TRIAL_REQUIRED'],
  };
}

/** Linear interpolation of the admixture's dosage → water-reduction table (never extrapolated). */
export function waterReduction(
  m: SnapshotMaterial | undefined,
  dosagePct: number,
): { ok: true; pct: number } | { ok: false; detail: string } {
  const t = propOf(m, 'water_reduction_table') as
    { dosage_pct: number; water_reduction_pct: number }[] | undefined;
  if (!t || t.length === 0)
    return { ok: false, detail: 'the dosage–water-reduction table is not on file' };
  const pts = [...t].sort((a, b) => a.dosage_pct - b.dosage_pct);
  const lo = pts[0]!;
  const hi = pts[pts.length - 1]!;
  if (dosagePct < lo.dosage_pct || dosagePct > hi.dosage_pct)
    return {
      ok: false,
      detail: `dosage ${round6(dosagePct)} % is outside the table ${lo.dosage_pct}–${hi.dosage_pct} % (no extrapolation)`,
    };
  const i = pts.findIndex((p) => p.dosage_pct >= dosagePct);
  const b = pts[i]!;
  if (b.dosage_pct === dosagePct) return { ok: true, pct: b.water_reduction_pct };
  const a = pts[i - 1]!;
  const f = (dosagePct - a.dosage_pct) / (b.dosage_pct - a.dosage_pct);
  return {
    ok: true,
    pct: a.water_reduction_pct + f * (b.water_reduction_pct - a.water_reduction_pct),
  };
}

export function waterBaseline(
  req: DesignRequestInput,
  blend: Blend,
  rules: RuleIndex,
  ctx: Context,
  tr: Tracer,
): { block: WaterBaseline; assumptions: string[] } {
  const assumptions: string[] = [];
  const block: WaterBaseline = {
    label: 'does_not_predict_plant_water_demand',
    baseWaterKg: null,
    admixtureReductionPct: null,
    baselineWaterKg: null,
    designWaterKg: blend.freeWaterKg,
    evidence: ['MODEL_BASELINE'],
    blocker: null,
    clause: null,
  };
  const stop = (blocker: EvalBlocker, clause: string | null = null) => ({
    block: { ...block, blocker, clause },
    assumptions,
  });
  if (req.slumpMm === null) return stop({ code: 'input_missing', detail: 'slump is not stated' });
  if (req.nmasMm === null) return stop({ code: 'input_missing', detail: 'NMAS is not stated' });
  const t = findTable(rules, 'prop.water.', ctx);
  if ('blocker' in t) return stop(t.blocker);
  const def = t.table.def;
  let base: number | null = null;
  const q = lookupTable(def, { row: req.slumpMm, col: req.nmasMm });
  if (q.status === 'ok') base = q.value;
  else if (q.status === 'between_bins') {
    // Slump falls between two tabulated slump ranges: interpolate linearly between the nearest edges
    // (upper edge of the lower range, lower edge of the upper range). An engineering convention, stated.
    const bins = def.rows!.values as [number, number][];
    const below = bins[q.below]!;
    const above = bins[q.above]!;
    const col = (row: number) => lookupTable(def, { row, col: req.nmasMm! });
    const a = col(below[1]);
    const b = col(above[0]);
    if (a.status === 'ok' && b.status === 'ok') {
      base = a.value + ((req.slumpMm - below[1]) / (above[0] - below[1])) * (b.value - a.value);
      assumptions.push(
        `Slump ${req.slumpMm} mm is between the ACI 211.1 slump ranges ${below[0]}–${below[1]} and ${above[0]}–${above[1]} mm; the baseline water is interpolated between their nearest edges.`,
      );
    }
  } else if (q.status === 'out_of_domain')
    return stop(
      {
        code: 'out_of_domain',
        detail: 'slump or NMAS is outside the ACI 211.1 table domain (no extrapolation)',
      },
      t.table.clause,
    );
  if (base === null)
    return stop(
      { code: 'rule_not_on_file', detail: `${t.table.key} has no value for this slump and NMAS` },
      t.table.clause,
    );

  // Admixture water reduction at the design's own dosage (multiplicative across products).
  let remaining = 1;
  let reductionNote: number | null = null;
  for (const l of blend.lines.filter((x) => x.category === 'admixture')) {
    const dose = blend.dosagePct.get(l.id);
    if (dose === undefined) continue;
    const wr = waterReduction(l.material, dose);
    if (!wr.ok)
      return stop(
        { code: 'input_missing', detail: `${l.material?.nameEn ?? l.id}: ${wr.detail}` },
        t.table.clause,
      );
    remaining *= 1 - wr.pct / 100;
    reductionNote = (reductionNote ?? 0) + wr.pct;
  }
  const reduced = base * remaining;
  const reductionPct = (1 - remaining) * 100;
  tr.add(
    'baseline.water_kg',
    reduced,
    'kg/m3',
    'ACI 211.1 mixing water for slump and NMAS × Π(1 − admixture water reduction)',
    {
      table: base,
      reductionPct,
    },
    {
      ruleKey: t.table.key,
      ...(t.table.clause ? { clause: t.table.clause } : {}),
      evidence: ['MODEL_BASELINE'],
    },
  );
  return {
    block: {
      ...block,
      baseWaterKg: base,
      admixtureReductionPct: reductionNote === null ? 0 : reductionPct,
      baselineWaterKg: reduced,
      clause: t.table.clause,
    },
    assumptions,
  };
}
