// How a search ended is stated, never implied: every termination kind is reachable and none is mislabelled as another.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createHighsSolver,
  optimize,
  OptimizeCancelled,
  TERMINATION_KINDS,
  type LpSolution,
  type Solver,
} from '../src/optimizer';
import { optimizerInput } from '../src/testing/optimizer';

let real: Solver;
beforeAll(async () => {
  real = await createHighsSolver();
}, 30_000);

const failing = (status: LpSolution['status']): Solver => ({
  solve: async () => ({ status, objective: 0, x: {}, duals: {}, activity: {} }),
});

describe('termination', () => {
  it('a complete search with candidates is "optimal within the search", with the rounding gap stated', async () => {
    const r = await optimize(optimizerInput(), { solver: real });
    expect(r.termination.kind).toBe('optimal_within_search');
    expect(r.termination.searchComplete).toBe(true);
    expect(r.termination.objective).toEqual({ name: 'cheapest', statement: 'lowest_cost_found' });
    expect(r.termination.configurations.notAttempted).toBe(0);
    expect(r.termination.validator.accepted).toBe(r.candidates.length);
    expect(Object.keys(r.termination.constraints).length).toBeGreaterThan(0);
    for (const c of r.candidates) {
      expect(c.solve).toBeDefined();
      // rounding can only add cost over the LP optimum (to a micro-JOD of float noise)
      expect(c.solve!.roundingGapJod!).toBeGreaterThanOrEqual(-1e-3);
      expect(c.solve!.lpCostJod).toBeGreaterThan(0);
    }
    expect(r.termination.maxRoundingGapJod).toBe(
      Math.max(...r.candidates.map((c) => c.solve!.roundingGapJod!)),
    );
  });

  it('a search cut short by the time budget but holding candidates is "feasible, unproven"', async () => {
    let t = 0;
    // the budget ends the search after the first few solves, before ranking runs on a wider set
    const r = await optimize(optimizerInput(), {
      solver: real,
      now: () => {
        t += 200;
        return t;
      },
    });
    if (r.status === 'candidates') {
      expect(r.termination.kind).toBe('feasible_unproven');
      expect(r.termination.searchComplete).toBe(false);
      expect(r.termination.configurations.notAttempted).toBeGreaterThan(0);
    } else {
      expect(r.termination.kind).toBe('timed_out');
    }
  });

  it('running out of time before any solve is "timed out", and claims no infeasibility', async () => {
    let t = 0;
    const r = await optimize(optimizerInput(), { solver: real, now: () => (t += 1_000_000) });
    expect(r.termination.kind).toBe('timed_out');
    expect(r.status).toBe('no_valid_candidate');
    expect(r.conflicts).toBeNull();
    expect(r.notes.some((n) => n.code === 'time_budget_no_solution')).toBe(true);
  });

  it('a solver that errors on every configuration is a "solver failure", not infeasibility', async () => {
    const r = await optimize(optimizerInput(), { solver: failing('error') });
    expect(r.termination.kind).toBe('solver_failure');
    expect(r.termination.configurations.solverErrors).toBe(r.stats.enumerated);
    expect(r.conflicts).toBeNull();
    expect(r.termination.searchComplete).toBe(false);
  });

  it('a solver that proves every configuration infeasible gives "infeasible" with a conflict report', async () => {
    const r = await optimize(optimizerInput(), { solver: failing('infeasible') });
    expect(r.termination.kind).toBe('infeasible');
    expect(r.status).toBe('infeasible');
  });

  it('a request that cannot be formulated is "invalid input"', async () => {
    const r = await optimize(optimizerInput({ extraRules: { 'eng.fines.max_pct_75um': null } }), {
      solver: real,
    });
    expect(r.status).toBe('blocked');
    expect(r.termination.kind).toBe('invalid_input');
    expect(r.termination.searchComplete).toBe(false);
  });

  it('an aborted search throws and returns nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(optimize(optimizerInput(), { solver: real, signal: ac.signal })).rejects.toThrow(
      OptimizeCancelled,
    );
  });

  it('the vocabulary is closed', () => {
    expect([...TERMINATION_KINDS].sort()).toEqual(
      [
        'cancelled',
        'feasible_unproven',
        'infeasible',
        'invalid_input',
        'no_valid_candidate',
        'optimal_within_search',
        'solver_failure',
        'timed_out',
      ].sort(),
    );
  });
});
