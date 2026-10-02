// Solves one configuration: the fixed-point loop on the binder-dependent workability adjustment, and the
// two-stage lexicographic objective of "closest to targets". Pure apart from the injected solver.
import type { ConfigSpec } from './enumerate';
import { formulate, type Model } from './formulate';
import type { Prepared } from './prepare';
import type { BindingRow, LpProblem, LpSolution, Objective, Solver } from './types';

export interface Solved {
  cfg: ConfigSpec;
  model: Model;
  x: Record<string, number>;
  /** JOD/m³ from the LP (the final cost is recomputed in exact decimals by the evaluator). */
  costJod: number;
  /** Σ weight × deviation of the target characteristics, JOD/m³. */
  deviationJod: number;
  binding: BindingRow[];
  iterations: number;
  converged: boolean;
}

const stageOne = (m: Model): LpProblem => ({
  vars: m.problem.vars.map((v) => ({
    ...v,
    cost: m.devs.some((d) => d.plus === v.name || d.minus === v.name) ? v.cost : 0,
  })),
  rows: m.problem.rows,
});
const withoutDevCost = (m: Model): LpProblem => ({
  vars: m.problem.vars.map((v) => ({
    ...v,
    cost: m.devs.some((d) => d.plus === v.name || d.minus === v.name) ? 0 : v.cost,
  })),
  rows: m.problem.rows,
});

/** The estimates the first iteration of a configuration starts from (also used by the diagnostics). */
export function initialEstimates(p: Prepared, cfg: ConfigSpec) {
  const fineFms = p.fines.filter((x) => x.fm !== null);
  return {
    binderEst: p.wcmCeiling > 0 ? (p.baseWaterKg.get(cfg.nmas) ?? 180) / p.wcmCeiling : 350,
    aggMassEst: 1800,
    fmFineEst: fineFms.length
      ? fineFms.reduce((a, x) => a + (x.fm as number), 0) / fineFms.length
      : null,
  };
}

export async function solveConfig(
  p: Prepared,
  cfg: ConfigSpec,
  solver: Solver,
  objective: Objective,
): Promise<Solved | null> {
  let { binderEst, aggMassEst, fmFineEst } = initialEstimates(p, cfg);
  let last: { sol: LpSolution; model: Model } | null = null;
  let iterations = 0;
  let converged = false;
  for (; iterations < 5;) {
    iterations++;
    let model = formulate(p, cfg, { binderEst, aggMassEst, fmFineEst, elastic: 'none' });
    let sol: LpSolution;
    if (objective === 'closest_to_targets' && model.devs.length > 0) {
      const s1 = await solver.solve(stageOne(model));
      if (s1.status !== 'optimal') break;
      const dev = model.devs.reduce(
        (a, d) => a + d.weight * ((s1.x[d.plus] ?? 0) + (s1.x[d.minus] ?? 0)),
        0,
      );
      model = formulate(p, cfg, {
        binderEst,
        aggMassEst,
        fmFineEst,
        elastic: 'none',
        deviationCap: dev * (1 + 1e-6) + 1e-9,
      });
      sol = await solver.solve(withoutDevCost(model));
    } else sol = await solver.solve(model.problem);
    // A later iteration can only be infeasible because an estimate moved; the last feasible point stands and
    // is validated from scratch afterwards.
    if (sol.status !== 'optimal') break;
    last = { sol, model };
    const b = sol.x['B'] ?? 0;
    const fineMass = p.fines.reduce((a, g) => a + (sol.x[`V:${g.id}`] ?? 0) * g.rho, 0);
    if (fineMass > 1 && p.fines.every((g) => g.fm !== null))
      fmFineEst =
        p.fines.reduce((a, g) => a + (sol.x[`V:${g.id}`] ?? 0) * g.rho * (g.fm as number), 0) /
        fineMass;
    aggMassEst = Math.max(
      model.aggs.reduce((a, g) => a + (sol.x[`V:${g.id}`] ?? 0) * g.rho, 0),
      1,
    );
    if (Math.abs(b - binderEst) / Math.max(binderEst, 1) < 0.001) {
      converged = true;
      break;
    }
    binderEst = b;
  }
  if (!last) return null;
  const { sol, model } = last;
  const binding: BindingRow[] = [];
  for (const [id, dual] of Object.entries(sol.duals)) {
    const m = model.meta.get(id);
    if (!m || m.klass === 'PHYSICAL' || Math.abs(dual) < 1e-9) continue;
    binding.push({ id, shadowPrice: dual, klass: m.klass });
  }
  binding.sort(
    (a, b) => Math.abs(b.shadowPrice) - Math.abs(a.shadowPrice) || a.id.localeCompare(b.id),
  );
  return {
    cfg,
    model,
    x: sol.x,
    costJod: model.cost.value(sol.x),
    deviationJod: model.devs.reduce(
      (a, d) => a + d.weight * ((sol.x[d.plus] ?? 0) + (sol.x[d.minus] ?? 0)),
      0,
    ),
    binding,
    iterations,
    converged,
  };
}
