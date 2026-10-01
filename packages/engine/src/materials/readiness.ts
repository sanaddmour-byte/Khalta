import { fineModulus, validateGradation, type GradationPoint } from './gradation';
import { isAggregate, SOURCE_STRENGTH, type Category, type Properties, type Source } from './properties';

export type Workflow = 'evaluate' | 'design';

export interface ReadinessContext {
  /** A sulfate class above S0 governs the request (needs cement C₃A). */
  sulfateGoverns?: boolean;
  /** An ASR rule is active (needs cement alkali). */
  asrActive?: boolean;
  /** Recycled water is used (needs chloride content). */
  recycledWater?: boolean;
  fmSieves?: readonly number[];
}

export interface Blocker {
  field: string;
  workflow: Workflow;
  code: 'missing' | 'invalid';
  detail?: string;
}

type Provenance = Record<string, Source>;

const has = (p: Properties, k: string) => p[k] !== undefined && p[k] !== null && p[k] !== '';

/** Fields each workflow needs (07 §2.2). Returns [field, workflow] pairs. */
function required(category: Category, ctx: ReadinessContext): [string, Workflow][] {
  const ev = (...f: string[]): [string, Workflow][] => f.map((x) => [x, 'evaluate']);
  const de = (...f: string[]): [string, Workflow][] => f.map((x) => [x, 'design']);
  switch (category) {
    case 'fine_agg':
    case 'coarse_agg':
      return [...ev('sg_ssd', 'absorption_pct'), ...de('sieve_analysis', 'finer_75um_pct')];
    case 'cement':
      return [...ev('sg'), ...de(...(ctx.sulfateGoverns ? ['c3a_pct'] : []), ...(ctx.asrActive ? ['alkali_na2o_eq_pct'] : []))];
    case 'scm':
      return [...ev('scm_type', 'sg'), ...de(...(ctx.asrActive ? ['alkali_na2o_eq_pct'] : []))];
    case 'admixture':
      return [...ev('type', 'sg', 'solids_pct'), ...de('min_dosage_pct', 'max_dosage_pct', 'water_reduction_table')];
    case 'water':
      return [...ev('water_source', 'sg'), ...de(...(ctx.recycledWater ? ['chloride_mg_l'] : []))];
    default:
      return ev('sg');
  }
}

/** Named blockers for a workflow: everything missing or unusable. Design includes the evaluate set. */
export function blockers(category: Category, props: Properties, workflow: Workflow, ctx: ReadinessContext = {}): Blocker[] {
  const out: Blocker[] = [];
  for (const [field, wf] of required(category, ctx)) {
    if (workflow === 'evaluate' && wf === 'design') continue;
    if (field === 'sieve_analysis') {
      const pts = props['sieve_analysis'] as GradationPoint[] | undefined;
      if (!pts || pts.length === 0) out.push({ field, workflow: wf, code: 'missing' });
      else if (validateGradation(pts).length > 0) out.push({ field, workflow: wf, code: 'invalid', detail: validateGradation(pts)[0]!.message });
      else {
        const fm = fineModulus(pts, ctx.fmSieves);
        if (!fm.ok) out.push({ field: 'fineness_modulus', workflow: wf, code: 'missing', detail: `sieves ${fm.missing.join(', ')} mm` });
      }
    } else if (field === 'water_reduction_table') {
      const t = props[field] as unknown[] | undefined;
      if (!t) out.push({ field, workflow: wf, code: 'missing' });
      else if (t.length < 3) out.push({ field, workflow: wf, code: 'invalid', detail: 'needs at least 3 points' });
    } else if (field === 'sg' && category === 'water') {
      if (!has(props, 'sg') || props['sg_confirmed'] !== true) out.push({ field: 'sg', workflow: wf, code: 'missing', detail: 'confirm the specific gravity (default 1.000)' });
    } else if (!has(props, field)) out.push({ field, workflow: wf, code: 'missing' });
  }
  return out;
}

/** The workflow that is satisfiable with the data on file. */
export function readiness(category: Category, props: Properties, ctx: ReadinessContext = {}) {
  const evaluate = blockers(category, props, 'evaluate', ctx);
  const design = blockers(category, props, 'design', ctx);
  return { evaluate, design, canEvaluate: evaluate.length === 0, canDesign: design.length === 0 };
}

/** Fields a design depends on whose value is only user-declared (07 §2.5 "key properties"). */
export function declaredKeyFields(category: Category, props: Properties, provenance: Provenance, ctx: ReadinessContext = {}): string[] {
  const keys = new Set(required(category, ctx).map(([f]) => f));
  if (isAggregate(category)) ['sieve_analysis', 'sg_ssd', 'absorption_pct'].forEach((k) => keys.add(k));
  return [...keys].filter((k) => has(props, k) && provenance[k] === 'user_declared');
}

/** Record-level source = the weakest source among the record's fields. */
export function overallSource(provenance: Provenance, fallback: Source): Source {
  const values = Object.values(provenance);
  if (values.length === 0) return fallback;
  return values.reduce((w, s) => (SOURCE_STRENGTH[s] < SOURCE_STRENGTH[w] ? s : w));
}
