// Insight rules (01-domain §8). Pure: what is worth telling a person, how loudly, and the stable key that stops an
// open insight from being duplicated. The hash itself is taken by the server.

export const INSIGHT_TYPES = [
  'opportunity', // a cheaper, validated, trial-only variant at current prices (theoretical)
  'test_expired',
  'prices_stale',
  'test_drift', // a new material test differs from the previous one
  'rule_change', // a rule or project change affects designs
  'low_strength', // a result below the acceptance criterion
  'compliance_failure', // a re-evaluation now fails a check
  'model_invalidated', // an approved strength model no longer holds (M5.2)
] as const;
export type InsightType = (typeof INSIGHT_TYPES)[number];
export const SEVERITIES = ['info', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const INSIGHT_STATUSES = ['open', 'snoozed', 'dismissed', 'accepted', 'expired'] as const;
export type InsightStatus = (typeof INSIGHT_STATUSES)[number];

/** Parts joined with a unit separator: the server hashes this string. Order-sensitive on purpose. */
export const dedupeParts = (type: InsightType, parts: readonly (string | number | null)[]) =>
  [type, ...parts.map((p) => (p === null ? '' : String(p)))].join('\u001f');

export interface DriftSummary {
  status: 'within' | 'beyond' | 'no_tolerance';
}
/**
 * Severity of a new material test relative to the previous one. An unset tolerance is NEVER read as "within":
 * it is a named review item (medium). Beyond tolerance on any field is high. A source change alone is medium.
 */
export function driftSeverity(
  items: readonly DriftSummary[],
  sourceChanged: boolean,
): Severity | null {
  if (items.some((i) => i.status === 'beyond')) return 'high';
  if (items.some((i) => i.status === 'no_tolerance') || sourceChanged) return 'medium';
  if (items.length > 0) return 'info';
  return null;
}

/** A yield drift above 2 % of the design volume, or any failed hard check, is critical (§14.3). */
export function reevaluationSeverity(input: {
  newFailures: number;
  yieldDriftPct: number | null;
  wasPassing: boolean;
}): Severity | null {
  if (input.newFailures > 0 && input.wasPassing) return 'critical';
  if (input.newFailures > 0) return 'high';
  if (input.yieldDriftPct !== null && Math.abs(input.yieldDriftPct) > 2) return 'high';
  return null;
}
