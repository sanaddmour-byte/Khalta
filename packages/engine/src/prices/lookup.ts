export interface PriceRow {
  id: string;
  materialId: string;
  plantId: string;
  supplierId: string;
  price: string;
  unit: string;
  includesDelivery: boolean;
  /** Calendar dates `YYYY-MM-DD` (Asia/Amman). */
  effectiveFrom: string;
  effectiveTo: string | null;
  supersededAt: string | Date | null;
}

export type PriceLookup =
  | { status: 'ok'; row: PriceRow; alternatives: number }
  | { status: 'unavailable' }
  | { status: 'ambiguous'; supplierIds: string[] };

const covers = (r: PriceRow, date: string) =>
  !r.supersededAt && r.effectiveFrom <= date && (r.effectiveTo === null || date <= r.effectiveTo);

/**
 * The single price in force on `date` for one material at one plant. `preferred` picks among several
 * suppliers; with several suppliers and no preference the answer is "ambiguous", never a silent pick.
 * No price = "unavailable", never zero.
 */
export function priceAt(
  rows: readonly PriceRow[],
  date: string,
  preferred?: string | null,
): PriceLookup {
  const live = rows.filter((r) => covers(r, date));
  if (live.length === 0) return { status: 'unavailable' };
  const pick = preferred ? live.find((r) => r.supplierId === preferred) : undefined;
  if (pick) return { status: 'ok', row: pick, alternatives: live.length - 1 };
  if (live.length === 1) return { status: 'ok', row: live[0]!, alternatives: 0 };
  return { status: 'ambiguous', supplierIds: live.map((r) => r.supplierId).sort() };
}

export interface Staleness {
  status: 'fresh' | 'stale' | 'not_configured';
  ageDays: number;
}
const DAY = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** Age of a price against the tenant limit. No limit configured is never reported as "fresh". */
export function priceStaleness(
  effectiveFrom: string,
  today: string,
  limitDays: number | null | undefined,
): Staleness {
  const ageDays = Math.max(0, Math.floor((utc(today) - utc(effectiveFrom)) / DAY));
  if (limitDays === null || limitDays === undefined) return { status: 'not_configured', ageDays };
  return { status: ageDays > limitDays ? 'stale' : 'fresh', ageDays };
}

/** Today's calendar date in Asia/Amman as `YYYY-MM-DD`. */
export function todayAmman(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Amman',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export const addDays = (date: string, n: number): string =>
  new Date(utc(date) + n * DAY).toISOString().slice(0, 10);
