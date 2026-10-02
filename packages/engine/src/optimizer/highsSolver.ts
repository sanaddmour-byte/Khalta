// HiGHS (WASM, MIT) behind the Solver contract. The LP is handed over in CPLEX LP text with sanitised names;
// the optimizer core never imports this file, so the engine stays solver-agnostic and tests can inject a stub.
import type { LpProblem, LpSolution, Solver } from './types';

type HighsColumn = { Primal: number; Dual: number };
type HighsRow = { Name: string; Primal: number; Dual: number };
interface HighsResult {
  Status: string;
  ObjectiveValue: number;
  Columns: Record<string, HighsColumn>;
  Rows: HighsRow[];
}
type Loader = () => Promise<{ solve(lp: string, options?: Record<string, unknown>): HighsResult }>;

const num = (x: number) => (Object.is(x, -0) ? '0' : x.toPrecision(15));

export function toLpText(p: LpProblem): {
  text: string;
  cols: string[];
  rows: { id: string; row: string }[];
} {
  const cols = p.vars.map((v) => v.name);
  const idx = new Map(cols.map((n, i) => [n, i]));
  const lines: string[] = ['Minimize'];
  const obj = p.vars
    .map((v, i) => (v.cost !== 0 ? `${v.cost < 0 ? '-' : '+'} ${num(Math.abs(v.cost))} x${i}` : ''))
    .filter(Boolean);
  lines.push(` obj: ${obj.length ? obj.join(' ') : '0 x0'}`);
  lines.push('Subject To');
  const rowIds: { id: string; row: string }[] = [];
  const emit = (
    id: string,
    r: LpProblem['rows'][number],
    op: '>=' | '<=' | '=',
    rhs: number,
    k: number,
  ) => {
    const terms = r.terms
      .filter(([, c]) => c !== 0)
      .map(([n, c]) => `${c < 0 ? '-' : '+'} ${num(Math.abs(c))} x${idx.get(n)!}`);
    const name = `r${k}`;
    lines.push(` ${name}: ${terms.length ? terms.join(' ') : '0 x0'} ${op} ${num(rhs)}`);
    rowIds.push({ id, row: name });
  };
  let k = 0;
  for (const r of p.rows) {
    if (r.lb !== null && r.ub !== null && r.lb === r.ub) emit(r.name, r, '=', r.lb, k++);
    else {
      if (r.lb !== null) emit(r.name, r, '>=', r.lb, k++);
      if (r.ub !== null) emit(r.name, r, '<=', r.ub, k++);
    }
  }
  lines.push('Bounds');
  p.vars.forEach((v, i) => lines.push(` ${num(v.lb)} <= x${i} <= ${num(v.ub)}`));
  lines.push('End');
  return { text: lines.join('\n'), cols, rows: rowIds };
}

export async function createHighsSolver(): Promise<Solver> {
  const mod = (await import('highs')) as unknown as { default: Loader };
  const highs = await mod.default();
  return {
    async solve(problem: LpProblem): Promise<LpSolution> {
      const { text, cols, rows } = toLpText(problem);
      let res: HighsResult;
      try {
        res = highs.solve(text, { presolve: 'on', output_flag: false });
      } catch {
        return { status: 'error', objective: 0, x: {}, duals: {}, activity: {} };
      }
      const status: LpSolution['status'] =
        res.Status === 'Optimal'
          ? 'optimal'
          : res.Status === 'Infeasible'
            ? 'infeasible'
            : res.Status === 'Unbounded'
              ? 'unbounded'
              : res.Status.includes('nfeasible')
                ? 'infeasible'
                : 'error';
      if (status !== 'optimal') return { status, objective: 0, x: {}, duals: {}, activity: {} };
      const x: Record<string, number> = {};
      cols.forEach((n, i) => (x[n] = res.Columns[`x${i}`]?.Primal ?? 0));
      const byName = new Map(res.Rows.map((r) => [r.Name, r]));
      const duals: Record<string, number> = {};
      const activity: Record<string, number> = {};
      for (const r of rows) {
        const row = byName.get(r.row);
        if (!row) continue;
        duals[r.id] = (duals[r.id] ?? 0) + (row.Dual ?? 0);
        activity[r.id] = row.Primal;
      }
      return { status, objective: res.ObjectiveValue, x, duals, activity };
    },
  };
}
