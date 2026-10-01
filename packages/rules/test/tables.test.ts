import { describe, expect, it } from 'vitest';
import { loadSeeds } from '../src/loader';
import { lookupTable } from '../src/tables';
import type { TableDefinition } from '../src/schema';

const { rules } = loadSeeds();
const def = (key: string) =>
  rules.find((r) => r.ruleset === 'ACI' && r.key === key)!.definition as TableDefinition;
const approx = (r: ReturnType<typeof lookupTable>, v: number) => {
  expect(r.status).toBe('ok');
  expect((r as { value: number }).value).toBeCloseTo(v, 6);
};

describe('1D tables (w/c vs strength, ACI 211.1 T6.3.4(a))', () => {
  const wc = def('prop.wc_strength.non_ae');
  it('returns exact nodes', () => approx(lookupTable(wc, { col: 30 }), 0.54));
  it('interpolates linearly between nodes', () => approx(lookupTable(wc, { col: 32.5 }), 0.505));
  it('never extrapolates', () => {
    expect(lookupTable(wc, { col: 14.9 })).toEqual({ status: 'out_of_domain', domain: [15, 40] });
    expect(lookupTable(wc, { col: 40.1 })).toEqual({ status: 'out_of_domain', domain: [15, 40] });
  });
  it('handles the end nodes', () => {
    approx(lookupTable(wc, { col: 15 }), 0.79);
    approx(lookupTable(wc, { col: 40 }), 0.42);
  });
});

describe('2D tables with numeric rows (coarse aggregate volume T6.3.6)', () => {
  const ca = def('prop.ca_volume');
  it('exact node', () => approx(lookupTable(ca, { row: 19, col: 2.6 }), 0.64));
  it('interpolates along the columns', () => approx(lookupTable(ca, { row: 19, col: 2.7 }), 0.63));
  it('interpolates in both directions', () =>
    approx(lookupTable(ca, { row: 15.75, col: 2.7 }), (0.56 + 0.63) / 2));
  it('out of domain on either axis', () => {
    expect(lookupTable(ca, { row: 50, col: 2.6 }).status).toBe('out_of_domain');
    expect(lookupTable(ca, { row: 19, col: 3.5 }).status).toBe('out_of_domain');
  });
});

describe('2D tables with bin rows (water by slump bins, ACI 211.1 T6.3.3)', () => {
  const water = def('prop.water.non_ae');
  it('uses the bin row when the slump is inside a bin', () =>
    approx(lookupTable(water, { row: 90, col: 19 }), 205));
  it('interpolates between NMAS columns', () =>
    approx(lookupTable(water, { row: 90, col: 22 }), 199));
  it('does NOT invent a policy between bins', () => {
    const r = lookupTable(water, { row: 60, col: 19 });
    expect(r).toEqual({ status: 'between_bins', below: 0, above: 1 });
  });
  it('is out of domain below the first and above the last bin', () => {
    expect(lookupTable(water, { row: 10, col: 19 })).toEqual({
      status: 'out_of_domain',
      domain: [25, 175],
    });
    expect(lookupTable(water, { row: 200, col: 19 })).toEqual({
      status: 'out_of_domain',
      domain: [25, 175],
    });
  });
  it('needs a row for a 2D table', () =>
    expect(lookupTable(water, { col: 19 }).status).toBe('not_on_file'));
});

describe('gaps and missing tables', () => {
  it('a table that is not on file says so', () => {
    const ae = rules.find((r) => r.key === 'prop.water.ae')!;
    expect(lookupTable(ae.definition, { row: 90, col: 19 })).toEqual({ status: 'not_on_file' });
  });
  it('a null cell is not on file and blocks interpolation through it', () => {
    const t: TableDefinition = {
      cols: { name: 'x', values: [1, 2, 3] },
      data: [[1, null, 3]],
      interpolation: 'linear',
    };
    expect(lookupTable(t, { col: 2 })).toEqual({ status: 'not_on_file' });
    expect(lookupTable(t, { col: 1.5 })).toEqual({ status: 'not_on_file' });
    expect(lookupTable(t, { col: 1 })).toEqual({ status: 'ok', value: 1 });
  });
  it('interpolation "none" only answers at nodes', () => {
    const t: TableDefinition = {
      cols: { name: 'x', values: [1, 2] },
      data: [[10, 20]],
      interpolation: 'none',
    };
    expect(lookupTable(t, { col: 1.5 })).toEqual({ status: 'not_tabulated' });
    expect(lookupTable(t, { col: 2 })).toEqual({ status: 'ok', value: 20 });
  });
});
