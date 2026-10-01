export type FreshnessStatus = 'fresh' | 'expired' | 'not_configured';

export interface Freshness {
  status: FreshnessStatus;
  ageDays: number;
  /** Absent when no limit is configured (a missing limit is never reported as "fresh"). */
  validUntil?: string;
}

const DAY = 86_400_000;

/** Test age against the QC limit (days). `limitDays` null/undefined = not configured. */
export function freshness(testedAt: Date | string, now: Date, limitDays: number | null | undefined): Freshness {
  const tested = new Date(testedAt);
  const ageDays = Math.floor((now.getTime() - tested.getTime()) / DAY);
  if (limitDays === null || limitDays === undefined) return { status: 'not_configured', ageDays };
  const until = new Date(tested.getTime() + limitDays * DAY);
  return { status: now.getTime() > until.getTime() ? 'expired' : 'fresh', ageDays, validUntil: until.toISOString().slice(0, 10) };
}
