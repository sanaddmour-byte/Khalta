// Savings arithmetic (01-domain §14.2). Exact decimals; every comparison prices BOTH designs at the SAME snapshot,
// so market price movement is never credited to a change. States are kept apart and never summed together.
import { divide, formatDecimal, multiply, parseDecimal, roundTo } from '../prices/decimal';

export type SavingState = 'theoretical' | 'approved' | 'realized';

/** Half-up rounding that treats negatives symmetrically (the price helpers assume non-negative values). */
const roundSigned = (v: bigint, places: number) =>
  v < 0n ? `-${roundTo(-v, places)}`.replace(/^-(0\.0+)$/, '$1') : roundTo(v, places);
const mulSigned = (a: bigint, b: bigint) =>
  a < 0n !== b < 0n
    ? -multiply(a < 0n ? -a : a, b < 0n ? -b : b)
    : multiply(a < 0n ? -a : a, b < 0n ? -b : b);

const dec = (s: string): bigint => {
  const v = parseDecimal(s);
  if (v === null) throw new Error(`not a plain decimal: ${s}`);
  return v;
};

/** (baseline − replacement) per m³, signed, rounded to 3 places. Negative means the replacement costs more. */
export function savingPerM3(baselineCost: string, replacementCost: string): string {
  return roundSigned(dec(baselineCost) - dec(replacementCost), 3);
}

/** A signed 3-place decimal back to a scaled bigint (parseDecimal refuses signs). */
export function signed(s: string): bigint {
  return s.startsWith('-') ? -dec(s.slice(1)) : dec(s);
}

/** saving per m³ × volume (m³), rounded to 3 places. */
export function totalSaving(perM3: string, volumeM3: string): string {
  return roundSigned(mulSigned(signed(perM3), dec(volumeM3)), 3);
}

/** Realized saving for one month: (baseline − replacement, both priced at THAT month's snapshot) × produced volume. */
export function realizedForMonth(input: {
  baselineCostAtMonth: string;
  replacementCostAtMonth: string;
  producedM3: string;
}): { perM3: string; total: string } {
  const perM3 = savingPerM3(input.baselineCostAtMonth, input.replacementCostAtMonth);
  return { perM3, total: totalSaving(perM3, input.producedM3) };
}

/** perM3 × monthly volume × 12. */
export function annualised(perM3: string, monthlyVolumeM3: string): string {
  return roundSigned(mulSigned(mulSigned(signed(perM3), dec(monthlyVolumeM3)), 12n * 10n ** 9n), 3);
}

export interface Thresholds {
  minPerM3: number;
  minAnnualJod: number;
}
/** An opportunity is worth an insight if it saves enough per m³ OR enough per year (tenant settings, §8). */
export function opportunityEligible(
  perM3: string,
  annualJod: string | null,
  t: Thresholds,
): boolean {
  const p = Number(perM3);
  const a = annualJod === null ? null : Number(annualJod);
  return p > 0 && (p >= t.minPerM3 || (a !== null && a >= t.minAnnualJod));
}

/** Sums by state. Never returns a combined figure: the three states are different kinds of number. */
export function totalsByState(
  rows: readonly { state: SavingState; total: string }[],
): Record<SavingState, string> {
  const out: Record<SavingState, bigint> = { theoretical: 0n, approved: 0n, realized: 0n };
  for (const r of rows) out[r.state] += signed(r.total);
  return {
    theoretical: roundSigned(out.theoretical, 3),
    approved: roundSigned(out.approved, 3),
    realized: roundSigned(out.realized, 3),
  };
}

/** `YYYY-MM-01` for a date string. */
export const monthOf = (d: string) => `${d.slice(0, 7)}-01`;
/** Last calendar day of the month that starts on `month` (`YYYY-MM-01`). */
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
/** Months (first days) from `from` to `to` inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export { divide, formatDecimal };
