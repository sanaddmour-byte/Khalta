import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  cellKey,
  clearStaging,
  divide,
  emptyStaging,
  formatDecimal,
  multiply,
  parseDecimal,
  parsePriceCell,
  parsePricePaste,
  placePaste,
  priceAt,
  priceStaleness,
  redo,
  roundTo,
  splitKey,
  stage,
  todayAmman,
  toJodPerKg,
  undo,
  type PriceRow,
  type PriceUnit,
} from '../src/index';

describe('decimal', () => {
  it('parses and formats exactly', () => {
    expect(parseDecimal('0.0125')).toBe(12_500_000n);
    expect(formatDecimal(12_500_000n)).toBe('0.012500000');
    expect(formatDecimal(-1_500_000_000n, 2)).toBe('-1.50');
    expect(formatDecimal(5n, 0)).toBe('0');
    for (const bad of ['', '-1', '1e3', '1.', '.5', 'abc', '1.2.3', '1234567890123'])
      expect(parseDecimal(bad), bad).toBeNull();
  });
  it('divides and multiplies with half-up rounding', () => {
    expect(formatDecimal(divide(1_000_000_000n, 3_000_000_000n))).toBe('0.333333333');
    expect(formatDecimal(divide(2_000_000_000n, 3_000_000_000n))).toBe('0.666666667');
    expect(formatDecimal(multiply(1_500_000_000n, 2_000_000_000n))).toBe('3.000000000');
    expect(() => divide(1n, 0n)).toThrow(RangeError);
    expect(roundTo(parseDecimal('1.2345')!, 3)).toBe('1.235');
  });
});

describe('toJodPerKg', () => {
  it('converts per ton, per kg and per litre exactly', () => {
    expect(toJodPerKg({ price: '45.000', unit: 'JOD/ton' })).toEqual({
      ok: true,
      jodPerKg: '0.045000000',
    });
    expect(toJodPerKg({ price: '0.120', unit: 'JOD/kg' })).toEqual({
      ok: true,
      jodPerKg: '0.120000000',
    });
    expect(toJodPerKg({ price: '1.100', unit: 'JOD/L', sg: 1.1 })).toEqual({
      ok: true,
      jodPerKg: '1.000000000',
    });
    expect(toJodPerKg({ price: '1.000', unit: 'JOD/L', sg: '1.2' })).toEqual({
      ok: true,
      jodPerKg: '0.833333333',
    });
  });
  it('names what is missing instead of guessing', () => {
    expect(toJodPerKg({ price: '5.000', unit: 'JOD/L' })).toEqual({
      ok: false,
      reason: 'needs_sg',
      missing: 'sg',
    });
    expect(toJodPerKg({ price: '5.000', unit: 'JOD/L', sg: 0 })).toMatchObject({
      reason: 'needs_sg',
    });
    expect(toJodPerKg({ price: '5.000', unit: 'JOD/m3' })).toEqual({
      ok: false,
      reason: 'needs_density',
      missing: 'density',
    });
    for (const price of ['', '-1', '1.2345', 'x'])
      expect(toJodPerKg({ price, unit: 'JOD/kg' })).toEqual({ ok: false, reason: 'invalid_price' });
  });
  it('property: scale-invariant (doubling the price doubles the per-kg value) and monotonic', () => {
    const price = fc.integer({ min: 1, max: 5_000_000 }).map((n) => (n / 1000).toFixed(3));
    const unit = fc.constantFrom<PriceUnit>('JOD/ton', 'JOD/kg');
    fc.assert(
      fc.property(price, price, unit, (a, b, u) => {
        const x = toJodPerKg({ price: a, unit: u });
        const y = toJodPerKg({ price: b, unit: u });
        if (!x.ok || !y.ok) throw new Error('should convert');
        const [pa, pb] = [parseDecimal(x.jodPerKg)!, parseDecimal(y.jodPerKg)!];
        if (Number(a) <= Number(b)) expect(pa <= pb).toBe(true);
        else expect(pa > pb).toBe(true);
        const dbl = toJodPerKg({ price: (Number(a) * 2).toFixed(3), unit: u });
        if (dbl.ok && Number(a) * 2 < 999_999_999) expect(parseDecimal(dbl.jodPerKg)).toBe(pa * 2n);
      }),
    );
  });
});

const row = (
  o: Partial<PriceRow> & { id: string; supplierId: string; effectiveFrom: string },
): PriceRow => ({
  materialId: 'm',
  plantId: 'p',
  price: '1.000',
  unit: 'JOD/ton',
  includesDelivery: true,
  effectiveTo: null,
  supersededAt: null,
  ...o,
});

describe('priceAt', () => {
  const rows = [
    row({ id: 'old', supplierId: 's1', effectiveFrom: '2026-01-01', effectiveTo: '2026-05-31' }),
    row({ id: 'new', supplierId: 's1', effectiveFrom: '2026-06-01' }),
  ];
  it('picks the row in force, including at period boundaries', () => {
    expect(priceAt(rows, '2026-05-31')).toMatchObject({ status: 'ok', row: { id: 'old' } });
    expect(priceAt(rows, '2026-06-01')).toMatchObject({ status: 'ok', row: { id: 'new' } });
    expect(priceAt(rows, '2027-01-01')).toMatchObject({ row: { id: 'new' } });
  });
  it('is unavailable before the first price and for superseded rows (never zero)', () => {
    expect(priceAt(rows, '2025-12-31')).toEqual({ status: 'unavailable' });
    expect(
      priceAt(
        [
          row({
            id: 'x',
            supplierId: 's',
            effectiveFrom: '2026-01-01',
            supersededAt: '2026-02-01',
          }),
        ],
        '2026-03-01',
      ),
    ).toEqual({ status: 'unavailable' });
    expect(priceAt([], '2026-03-01')).toEqual({ status: 'unavailable' });
  });
  it('several suppliers: preferred wins, otherwise ambiguous', () => {
    const two = [
      row({ id: 'a', supplierId: 'sa', effectiveFrom: '2026-01-01' }),
      row({ id: 'b', supplierId: 'sb', effectiveFrom: '2026-01-01' }),
    ];
    expect(priceAt(two, '2026-02-01', 'sb')).toMatchObject({
      status: 'ok',
      row: { id: 'b' },
      alternatives: 1,
    });
    expect(priceAt(two, '2026-02-01')).toEqual({ status: 'ambiguous', supplierIds: ['sa', 'sb'] });
    expect(priceAt(two, '2026-02-01', 'gone')).toMatchObject({ status: 'ambiguous' });
  });
});

describe('staleness and dates', () => {
  it('never reports fresh without a configured limit', () => {
    expect(priceStaleness('2026-01-01', '2026-02-01', null)).toEqual({
      status: 'not_configured',
      ageDays: 31,
    });
    expect(priceStaleness('2026-01-01', '2026-02-01', undefined).status).toBe('not_configured');
  });
  it('fresh at the limit, stale after, and never negative', () => {
    expect(priceStaleness('2026-01-01', '2026-01-31', 30).status).toBe('fresh');
    expect(priceStaleness('2026-01-01', '2026-02-01', 30).status).toBe('stale');
    expect(priceStaleness('2026-03-01', '2026-02-01', 30).ageDays).toBe(0);
  });
  it('Asia/Amman calendar date and day arithmetic', () => {
    expect(todayAmman(new Date('2026-10-01T21:30:00Z'))).toBe('2026-10-02'); // already past midnight in Amman (UTC+3)
    expect(todayAmman(new Date('2026-10-01T12:00:00Z'))).toBe('2026-10-01');
    expect(todayAmman()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('paste parsing', () => {
  it('reads cells with Arabic digits, decimal commas, currency and blanks', () => {
    expect(parsePriceCell('45.5')).toEqual({ kind: 'value', value: '45.5' });
    expect(parsePriceCell('٤٥٫٥٠٠')).toEqual({ kind: 'value', value: '45.500' });
    expect(parsePriceCell('45,5 JOD')).toEqual({ kind: 'value', value: '45.5' });
    expect(parsePriceCell('  ')).toEqual({ kind: 'empty' });
    expect(parsePriceCell('abc')).toMatchObject({ kind: 'error', message: 'not_a_number' });
    expect(parsePriceCell('1.2345')).toMatchObject({ kind: 'error', message: 'too_many_decimals' });
    expect(parsePriceCell('99999999999')).toMatchObject({ kind: 'error', message: 'out_of_range' });
    expect(parsePriceCell('-5')).toMatchObject({ kind: 'error' });
  });
  it('parses a block, ignores the trailing newline and states its assumptions', () => {
    const p = parsePricePaste('45,5\t٣٠\n\t12.250\n');
    expect(p.grid).toHaveLength(2);
    expect(p.grid[1]![0]).toEqual({ kind: 'empty' });
    expect(p.assumptions).toEqual(expect.arrayContaining(['digits', 'decimal_comma']));
    expect(parsePricePaste('1;2\r\n3;4').grid[1]).toEqual([
      { kind: 'value', value: '3' },
      { kind: 'value', value: '4' },
    ]);
  });
});

describe('staging model', () => {
  const rows = ['m1', 'm2'];
  const cols = ['p1', 'p2'];
  const unit = (): PriceUnit => 'JOD/ton';
  it('places a pasted block, skips blanks, reports errors and clipping', () => {
    const { grid } = parsePricePaste('1\t2\t3\n\tx\t6');
    const r = placePaste(grid, { row: 0, col: 0 }, rows, cols, unit);
    expect(r.updates.map((u) => [u.key, u.edit.price])).toEqual([
      ['m1|p1', '1'],
      ['m1|p2', '2'],
    ]);
    expect(r.errors).toEqual([{ row: 1, col: 1, raw: 'x', message: 'not_a_number' }]);
    expect(r.clipped).toBe(2); // the third column falls outside
    expect(placePaste(grid, { row: 1, col: 1 }, rows, cols, unit).clipped).toBeGreaterThan(0);
  });
  it('undo / redo / clear step through whole edits', () => {
    let s = emptyStaging();
    s = stage(s, [{ key: cellKey('m1', 'p1'), edit: { price: '1', unit: 'JOD/kg' } }]);
    s = stage(s, [
      { key: cellKey('m1', 'p2'), edit: { price: '2', unit: 'JOD/kg' } },
      { key: cellKey('m2', 'p1'), edit: { price: '3', unit: 'JOD/kg' } },
    ]);
    expect(Object.keys(s.edits)).toHaveLength(3);
    s = undo(s);
    expect(Object.keys(s.edits)).toEqual(['m1|p1']);
    s = redo(s);
    expect(Object.keys(s.edits)).toHaveLength(3);
    s = stage(s, [{ key: 'm1|p1', edit: null }]);
    expect(s.edits['m1|p1']).toBeUndefined();
    expect(redo(s)).toBe(s); // a new edit clears the redo stack
    s = clearStaging(s);
    expect(s.edits).toEqual({});
    s = undo(s);
    expect(Object.keys(s.edits).length).toBeGreaterThan(0);
    expect(stage(s, [])).toBe(s);
    expect(undo(emptyStaging())).toEqual(emptyStaging());
    expect(clearStaging(emptyStaging())).toEqual(emptyStaging());
    expect(splitKey(cellKey('a', 'b'))).toEqual(['a', 'b']);
  });
});
