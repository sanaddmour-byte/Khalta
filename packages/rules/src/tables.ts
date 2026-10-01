import type { TableDefinition } from './schema';

export type LookupResult =
  | { status: 'ok'; value: number }
  | { status: 'out_of_domain'; domain: [number, number] }
  | { status: 'between_bins'; below: number; above: number } // caller must choose a policy; none is invented here
  | { status: 'not_tabulated' } // interpolation is 'none' and the point is not a table node
  | { status: 'not_on_file' }; // the cell (or the whole table) is empty

const isBin = (v: number | [number, number]): v is [number, number] => Array.isArray(v);

/** Linear interpolation along ascending nodes. Never extrapolates. */
function along(
  nodes: number[],
  values: (number | null)[],
  x: number,
  interpolate: boolean,
): LookupResult {
  const lo = nodes[0]!;
  const hi = nodes[nodes.length - 1]!;
  if (x < lo || x > hi) return { status: 'out_of_domain', domain: [lo, hi] };
  const exact = nodes.indexOf(x);
  if (exact >= 0) {
    const v = values[exact];
    return v === null || v === undefined ? { status: 'not_on_file' } : { status: 'ok', value: v };
  }
  if (!interpolate) return { status: 'not_tabulated' };
  const i = nodes.findIndex((n) => n > x);
  const a = values[i - 1];
  const b = values[i];
  if (a === null || a === undefined || b === null || b === undefined)
    return { status: 'not_on_file' };
  const t = (x - nodes[i - 1]!) / (nodes[i]! - nodes[i - 1]!);
  return { status: 'ok', value: a + t * (b - a) };
}

/**
 * Table lookup. 1D tables take only `col`. 2D tables with numeric row nodes interpolate in both
 * directions; 2D tables whose rows are bins (e.g. slump 25–50, 75–100) return the bin's row when the
 * query is inside a bin and `between_bins` otherwise (the interpolation policy between bins is an
 * engineering decision for the caller, not a guess made here).
 */
export function lookupTable(
  def: TableDefinition | null | undefined,
  q: { row?: number; col: number },
): LookupResult {
  if (!def) return { status: 'not_on_file' };
  const interp = def.interpolation === 'linear';
  const cols = def.cols.values;

  if (!def.rows) return along(cols, def.data[0]!, q.col, interp);
  if (q.row === undefined) return { status: 'not_on_file' };

  const rows = def.rows.values;
  if (rows.every(isBin)) {
    const bins = rows as [number, number][];
    const hit = bins.findIndex(([a, b]) => q.row! >= a && q.row! <= b);
    if (hit >= 0) return along(cols, def.data[hit]!, q.col, interp);
    const lowest = bins[0]![0];
    const highest = bins[bins.length - 1]![1];
    if (q.row < lowest || q.row > highest)
      return { status: 'out_of_domain', domain: [lowest, highest] };
    const above = bins.findIndex(([a]) => a > q.row!);
    return { status: 'between_bins', below: above - 1, above };
  }

  const nodes = rows as number[];
  const column = (c: number) => nodes.map((_, r) => along(cols, def.data[r]!, c, interp));
  const atCol = column(q.col);
  const bad = atCol.find((r) => r.status !== 'ok');
  if (bad) return bad;
  return along(
    nodes,
    atCol.map((r) => (r as { value: number }).value),
    q.row,
    interp,
  );
}
