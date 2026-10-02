// The validator's own table interpolation (linear, never extrapolating). Independent of the rules package's
// `lookupTable`; only the table *data* comes from the snapshot's rules.
import type { TableDefinition } from '@khalta/rules';
import { R, Rat } from './rat';

export type Look =
  | { s: 'ok'; v: Rat }
  | { s: 'out' }
  | { s: 'none' } // not tabulated / no value on file
  | { s: 'between'; below: [number, number]; above: [number, number] };

function along(nodes: number[], values: (number | null)[], x: Rat, linear: boolean): Look {
  const first = R(nodes[0]!);
  const last = R(nodes[nodes.length - 1]!);
  if (x.cmp(first) < 0 || x.cmp(last) > 0) return { s: 'out' };
  for (let i = 0; i < nodes.length; i++) {
    if (x.cmp(R(nodes[i]!)) === 0) {
      const v = values[i];
      return v === null || v === undefined ? { s: 'none' } : { s: 'ok', v: R(v) };
    }
  }
  if (!linear) return { s: 'none' };
  let i = 1;
  while (R(nodes[i]!).cmp(x) < 0) i++;
  const a = values[i - 1];
  const b = values[i];
  if (a === null || a === undefined || b === null || b === undefined) return { s: 'none' };
  const x0 = R(nodes[i - 1]!);
  const x1 = R(nodes[i]!);
  const t = x.sub(x0).div(x1.sub(x0));
  return { s: 'ok', v: R(a).add(t.mul(R(b).sub(R(a)))) };
}

export function look1d(def: TableDefinition | null | undefined, col: Rat): Look {
  if (!def || def.rows) return { s: 'none' };
  return along(def.cols.values, def.data[0]!, col, def.interpolation === 'linear');
}

/** 2-D table whose rows are bins [lo, hi] (the ACI 211.1 water table). */
export function look2dBins(def: TableDefinition | null | undefined, row: Rat, col: Rat): Look {
  if (!def || !def.rows) return { s: 'none' };
  const bins = def.rows.values as [number, number][];
  const linear = def.interpolation === 'linear';
  const hit = bins.findIndex(([a, b]) => row.gte(R(a)) && row.cmp(R(b)) <= 0);
  if (hit >= 0) return along(def.cols.values, def.data[hit]!, col, linear);
  if (row.cmp(R(bins[0]![0])) < 0 || row.cmp(R(bins[bins.length - 1]![1])) > 0) return { s: 'out' };
  const above = bins.findIndex(([a]) => R(a).cmp(row) > 0);
  return { s: 'between', below: bins[above - 1]!, above: bins[above]! };
}
