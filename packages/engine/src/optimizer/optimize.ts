// The controlled optimizer (07 §4, ADR 0009). Prepare → enumerate → one LP per configuration → rank →
// round and re-validate each candidate from scratch. Deterministic: the same input gives the same output.
// The solver and the independent validator are injected; this module has no I/O and imports neither.
import { diagnose, dofOf } from './diagnostics';
import { enumerate, type ConfigSpec } from './enumerate';
import { finalizeOne, GRIDS, type ValidateFn } from './finalize';
import { prepare } from './prepare';
import { solveConfig, type SolveTally, type Solved } from './solve';
import {
  OPTIMIZER_VERSION,
  type Candidate,
  type OptimizeResult,
  OptimizeCancelled,
  type OptimizerInput,
  type Solver,
  type Termination,
  type TerminationKind,
} from './types';

export interface OptimizeDeps {
  solver: Solver;
  /** The independent validator, applied to every candidate's evaluation after rounding. */
  validate?: ValidateFn;
  now?: () => number;
  /** Aborting it stops the search at the next configuration and throws `OptimizeCancelled` (nothing is returned). */
  signal?: AbortSignal;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

export async function optimize(input: OptimizerInput, deps: OptimizeDeps): Promise<OptimizeResult> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const stats = {
    enumerated: 0,
    solved: 0,
    infeasible: 0,
    solverErrors: 0,
    rejectedAfterRounding: 0,
    truncated: false,
    elapsedMs: 0,
  };
  const cancelled = () => {
    if (deps.signal?.aborted) throw new OptimizeCancelled();
  };
  const validatorTally = { checked: 0, accepted: 0, rejected: 0 };
  let constraints: Record<string, number> = {};
  const done = (
    r: Omit<OptimizeResult, 'stats' | 'optimizerVersion' | 'objective' | 'termination'>,
    kind: TerminationKind,
  ): OptimizeResult => {
    stats.elapsedMs = now() - t0;
    const gaps = r.candidates.flatMap((c) =>
      c.solve?.roundingGapJod != null ? [c.solve.roundingGapJod] : [],
    );
    const notAttempted = Math.max(
      0,
      stats.enumerated - stats.solved - stats.infeasible - stats.solverErrors,
    );
    const termination: Termination = {
      kind,
      searchComplete:
        kind !== 'invalid_input' &&
        notAttempted === 0 &&
        stats.solverErrors === 0 &&
        !stats.truncated,
      configurations: {
        enumerated: stats.enumerated,
        solved: stats.solved,
        infeasible: stats.infeasible,
        solverErrors: stats.solverErrors,
        notAttempted,
      },
      objective: {
        name: input.objective,
        statement:
          input.objective === 'closest_to_targets'
            ? 'closest_to_targets_found'
            : 'lowest_cost_found',
      },
      constraints,
      maxRoundingGapJod: gaps.length ? Math.max(...gaps) : null,
      validator: validatorTally,
    };
    return {
      ...r,
      objective: input.objective,
      stats,
      termination,
      optimizerVersion: OPTIMIZER_VERSION,
    };
  };

  const prep = prepare(input);
  if (!prep.ok)
    return done(
      {
        status: 'blocked',
        candidates: [],
        blockers: prep.blockers,
        conflicts: null,
        dof: null,
        excluded: prep.excluded,
        notes: [],
      },
      'invalid_input',
    );
  const p = prep.prepared;
  const en = enumerate(p);
  stats.enumerated = en.configs.length;
  stats.truncated = en.truncated;
  const notes = [...p.notes, ...en.notes];
  if (en.blockers.length > 0 || en.configs.length === 0)
    return done(
      {
        status: 'blocked',
        candidates: [],
        blockers: en.blockers.length
          ? en.blockers
          : [
              {
                code: 'no_materials',
                subject: 'configurations',
                detail:
                  'No configuration can be formed from the usable materials and characteristics',
              },
            ],
        conflicts: null,
        dof: null,
        excluded: p.excluded,
        notes,
      },
      'invalid_input',
    );
  const dof = dofOf(p, en.configs[0]!);

  // ---- one LP per configuration, within the time budget
  const solved: Solved[] = [];
  const tally: SolveTally = { errors: 0 };
  let overBudget = false;
  for (const [i, cfg] of en.configs.entries()) {
    cancelled();
    if (now() - t0 > input.settings.timeBudgetMs) {
      overBudget = true;
      break;
    }
    const before = tally.errors;
    const s = await solveConfig(p, cfg, deps.solver, input.objective, tally);
    if (s) {
      solved.push(s);
      stats.solved++;
    } else if (tally.errors > before) stats.solverErrors++;
    else stats.infeasible++;
    if (i % 8 === 7) await tick();
  }
  cancelled();
  if (overBudget) {
    stats.truncated = true;
    notes.push({
      code: 'time_budget',
      detail: `the ${input.settings.timeBudgetMs} ms budget ended the search after ${stats.solved + stats.infeasible + stats.solverErrors} of ${en.configs.length} configurations`,
    });
  }
  if (solved.length === 0 && (overBudget || stats.solverErrors > 0)) {
    // Not proven infeasible: the search ended for another reason, so no conflict is claimed.
    notes.push({
      code: overBudget ? 'time_budget_no_solution' : 'solver_failure',
      detail: overBudget
        ? 'The time budget ended the search before any configuration was solved; this is not a finding of infeasibility.'
        : `${stats.solverErrors} configuration(s) failed in the solver; this is not a finding of infeasibility.`,
    });
    return done(
      {
        status: 'no_valid_candidate',
        candidates: [],
        blockers: [],
        conflicts: null,
        dof,
        excluded: p.excluded,
        notes,
      },
      overBudget ? 'timed_out' : 'solver_failure',
    );
  }
  constraints = {};
  if (solved[0])
    for (const m of solved[0].model.meta.values())
      constraints[m.klass] = (constraints[m.klass] ?? 0) + 1;
  if (solved.length === 0) {
    const conflicts = await diagnose(p, en.configs, deps.solver);
    return done(
      {
        status: 'infeasible',
        candidates: [],
        blockers: [],
        conflicts,
        dof,
        excluded: p.excluded,
        notes,
      },
      'infeasible',
    );
  }

  // ---- rank, then round and re-validate until the top N are real candidates
  const key = (s: Solved) =>
    input.objective === 'closest_to_targets' && s.model.devs.length > 0
      ? [s.deviationJod, s.costJod]
      : [s.costJod + s.deviationJod, s.costJod];
  const order = (a: ConfigSpec) =>
    [
      a.cement.id,
      a.scm?.id ?? '',
      a.scmPct,
      a.admix?.id ?? '',
      a.level?.dosagePct ?? 0,
      a.nmas,
      a.airPct,
    ].join('|');
  solved.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      const d = Math.round(ka[i]! * 1e6) - Math.round(kb[i]! * 1e6);
      if (d !== 0) return d;
    }
    return order(a.cfg) < order(b.cfg) ? -1 : 1;
  });

  const out: Omit<Candidate, 'rank'>[] = [];
  const rejections = new Map<string, number>();
  const details: string[] = [];
  let attempts = 0;
  for (const s of solved) {
    if (out.length >= input.settings.candidatesTopN) break;
    if (now() - t0 > input.settings.timeBudgetMs * 1.5) break;
    attempts++;
    let accepted = false;
    for (const grid of GRIDS) {
      cancelled();
      const r = await finalizeOne(p, s, grid, deps.validate);
      if (r.ok) {
        validatorTally.checked++;
        validatorTally.accepted++;
        const finalCost =
          r.candidate.costJodPerM3 === null ? null : Number(r.candidate.costJodPerM3);
        out.push({
          ...r.candidate,
          solve: {
            lpCostJod: s.costJod,
            roundingGapJod:
              finalCost === null ? null : Math.round((finalCost - s.costJod) * 1e6) / 1e6,
            fixedPointIterations: s.iterations,
            fixedPointConverged: s.converged,
          },
        });
        accepted = true;
        break;
      }
      if (grid === GRIDS[GRIDS.length - 1]) {
        validatorTally.checked++;
        validatorTally.rejected++;
        rejections.set(r.rej.reason, (rejections.get(r.rej.reason) ?? 0) + 1);
        if (details.length < 5) details.push(r.rej.detail);
      }
    }
    if (!accepted) stats.rejectedAfterRounding++;
    if (attempts % 4 === 0) await tick();
  }
  if (out.length === 0) {
    for (const d of details) notes.push({ code: 'rejected_after_rounding', detail: d });
    return done(
      {
        status: 'no_valid_candidate',
        candidates: [],
        blockers: [],
        conflicts: null,
        dof,
        excluded: p.excluded,
        notes,
      },
      'no_valid_candidate',
    );
  }
  out.sort(
    (a, b) =>
      (input.objective === 'closest_to_targets' && a.deviations.length > 0
        ? a.deviations.reduce((x, d) => x + d.weightedCostJod, 0) -
          b.deviations.reduce((x, d) => x + d.weightedCostJod, 0)
        : a.objectiveValue - b.objectiveValue) ||
      Number(a.costJodPerM3 ?? 0) - Number(b.costJodPerM3 ?? 0),
  );
  return done(
    {
      status: 'candidates',
      candidates: out.map((c, i) => ({ ...c, rank: i + 1 })),
      blockers: [],
      conflicts: null,
      dof,
      excluded: p.excluded,
      notes,
    },
    stats.truncated || stats.solverErrors > 0 ? 'feasible_unproven' : 'optimal_within_search',
  );
}
