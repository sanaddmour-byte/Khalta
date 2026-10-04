// Degrees of freedom and conflict diagnostics (07 §4.4). The meter counts free design quantities against the
// equalities the user's Fixed characteristics add. A conflict is found by giving ONLY the user-specified rows
// slack (an L1 phase-1 solve): the hard rows never relax, so a diagnosis can never propose breaking a code
// or engineering limit. If the request is infeasible even with every user row released, the binding hard rows
// are named instead and no "saving" is offered.
import type { ConfigSpec } from './enumerate';
import { initialEstimates } from './solve';
import { asPhaseOne, formulate, type Model } from './formulate';
import type { Prepared } from './prepare';
import { classifyInfeasibility } from '../requirements/project';
import type { ConflictItem, ConflictReport, DofReport, Solver } from './types';

export function dofOf(p: Prepared, cfg: ConfigSpec): DofReport {
  const m = formulate(p, cfg, { ...initialEstimates(p, cfg), elastic: 'none' });
  const quantities = 2 + m.aggs.length; // binder, water, one volume per aggregate
  const equalities = 1 + m.fixed.length; // volume balance + Fixed characteristics
  const dof = quantities - equalities;
  return {
    quantities,
    equalities,
    dof,
    state: dof > 0 ? 'free' : dof === 0 ? 'fully_specified' : 'over_specified',
    fixed: [...m.fixed],
  };
}

const TOL = 1e-6;

export async function diagnose(
  p: Prepared,
  configs: ConfigSpec[],
  solver: Solver,
): Promise<ConflictReport | null> {
  if (configs.length === 0) return null;
  const sample = pick(configs, 12);
  const hasUser = p.chars.some((c) => c.spec.mode !== 'auto');

  const run = async (elastic: 'user' | 'all') => {
    let best: { total: number; model: Model; x: Record<string, number> } | null = null;
    for (const cfg of sample) {
      const model = formulate(p, cfg, { ...initialEstimates(p, cfg), elastic });
      if (model.elastic.length === 0) continue;
      const sol = await solver.solve(asPhaseOne(model, new Map()));
      if (sol.status !== 'optimal') continue;
      const total = model.elastic.reduce(
        (a, e) => a + (sol.x[e.plus] ?? 0) + (sol.x[e.minus] ?? 0),
        0,
      );
      if (best === null || total < best.total - 1e-12) best = { total, model, x: sol.x };
    }
    return best;
  };

  if (hasUser) {
    const r = await run('user');
    if (r && r.total > TOL) {
      const items: ConflictItem[] = [];
      for (const e of r.model.elastic) {
        const s = (r.x[e.plus] ?? 0) + (r.x[e.minus] ?? 0);
        if (s <= TOL) continue;
        const meta = r.model.meta.get(e.row)!;
        const c = p.chars.find(
          (cc) => meta.charKey === `${cc.key}${cc.sub === null ? '' : `.${cc.sub}`}`,
        );
        const q = c ? r.model.quantity(c.key, c.sub, c.spec) : null;
        let relax: number | null = null;
        if (q && meta.value !== undefined) {
          const num = q.num.value(r.x);
          const den = q.den ? q.den.value(r.x) : 1;
          relax = Math.abs(num / den - meta.value);
        }
        items.push({
          id: meta.charKey ?? e.row,
          klass: 'USER',
          relaxBy: relax === null ? null : Math.round(relax * 1e4) / 1e4,
          unit: meta.unit,
          detail: `${meta.charKey ?? e.row} ${meta.bound ?? ''} ${meta.value ?? ''}`.trim(),
          category: classifyInfeasibility({ klass: 'USER' }).class,
          adjustable: classifyInfeasibility({ klass: 'USER' }).adjustable,
        });
      }
      if (items.length > 0) return { kind: 'user_specified', items: dedupe(items) };
    }
  }
  const all = await run('all');
  if (all && all.total > TOL) {
    const items: ConflictItem[] = [];
    for (const e of all.model.elastic) {
      const s = (all.x[e.plus] ?? 0) + (all.x[e.minus] ?? 0);
      if (s <= TOL) continue;
      const meta = all.model.meta.get(e.row)!;
      items.push({
        id: e.row,
        klass: meta.klass === 'PHYSICAL' ? 'PHYSICAL' : meta.klass,
        relaxBy: null,
        unit: meta.unit,
        detail: `${e.row} cannot be met together with the other limits`,
        ...(() => {
          const c = classifyInfeasibility({
            klass: meta.klass,
            ...(meta.source === 'project' ? { source: 'project' as const } : {}),
          });
          return { category: c.class, adjustable: false };
        })(),
      });
    }
    return { kind: 'hard_rows', items };
  }
  return { kind: 'hard_rows', items: [] };
}

const dedupe = (xs: ConflictItem[]) => {
  const seen = new Map<string, ConflictItem>();
  for (const x of xs) {
    const prev = seen.get(x.id);
    if (!prev || (x.relaxBy ?? 0) > (prev.relaxBy ?? 0)) seen.set(x.id, x);
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
};

function pick<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  return Array.from({ length: n }, (_, i) => xs[Math.floor((i * xs.length) / n)]!);
}
