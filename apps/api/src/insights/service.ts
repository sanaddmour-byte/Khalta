// Insight storage (01-domain §8 noise control): one open row per dedupe key (a repeat updates it), expiry when the
// inputs that produced it no longer do, and an append-only event history. No function here touches a design.
import { createHash } from 'node:crypto';
import { schema, type AuditRecorder, type Executor } from '@khalta/db';
import { dedupeParts, type InsightType, type Severity } from '@khalta/engine';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';

export const hashKey = (s: string) => createHash('sha256').update(s).digest('hex');

export interface InsightInput {
  tenantId: string;
  type: InsightType;
  severity: Severity;
  plantId?: string | null;
  designId?: string | null;
  /** Parts of the dedupe key besides the type (the design, the inputs). */
  keyParts: (string | number | null)[];
  /** What changed, with named inputs. Never contains cost: cost lives in the typed columns. */
  payload: Record<string, unknown>;
  savingJodPerM3?: string | null;
  annualJod?: string | null;
  provisional?: boolean;
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, medium: 1, high: 2, critical: 3 };

/** Creates the insight, or refreshes the open one with the same key. Returns the row id and what happened. */
export async function upsertInsight(
  tx: Executor,
  audit: AuditRecorder | null,
  i: InsightInput,
  now = new Date(),
): Promise<{ id: string; action: 'created' | 'updated' }> {
  const key = hashKey(dedupeParts(i.type, i.keyParts));
  const [open] = await tx
    .select()
    .from(schema.insights)
    .where(
      and(
        eq(schema.insights.tenantId, i.tenantId),
        eq(schema.insights.dedupeKey, key),
        inArray(schema.insights.status, ['open', 'snoozed']),
      ),
    );
  if (open) {
    const severity =
      SEVERITY_RANK[i.severity] > SEVERITY_RANK[open.severity as Severity]
        ? i.severity
        : open.severity;
    await tx
      .update(schema.insights)
      .set({
        severity: severity as Severity,
        payload: i.payload,
        savingJodPerM3: i.savingJodPerM3 ?? null,
        annualJod: i.annualJod ?? null,
        provisional: i.provisional ?? true,
        lastSeenAt: now,
        // a snooze ends on its own date; seeing it again does not wake it
        ...(open.status === 'snoozed' && open.snoozedUntil && open.snoozedUntil <= now
          ? { status: 'open' as const, snoozedUntil: null }
          : {}),
      })
      .where(eq(schema.insights.id, open.id));
    await tx.insert(schema.insightEvents).values({
      tenantId: i.tenantId,
      insightId: open.id,
      kind: 'updated',
      detail: { severity },
    });
    return { id: open.id, action: 'updated' };
  }
  const [row] = await tx
    .insert(schema.insights)
    .values({
      tenantId: i.tenantId,
      type: i.type,
      severity: i.severity,
      plantId: i.plantId ?? null,
      designId: i.designId ?? null,
      dedupeKey: key,
      payload: i.payload,
      savingJodPerM3: i.savingJodPerM3 ?? null,
      annualJod: i.annualJod ?? null,
      provisional: i.provisional ?? true,
      lastSeenAt: now,
    })
    .returning({ id: schema.insights.id });
  await tx.insert(schema.insightEvents).values({
    tenantId: i.tenantId,
    insightId: row!.id,
    kind: 'created',
    detail: { type: i.type, severity: i.severity },
  });
  await audit?.record({
    action: 'insight.create',
    entityType: 'insight',
    entityId: row!.id,
    after: { type: i.type, severity: i.severity, designId: i.designId ?? null },
  });
  return { id: row!.id, action: 'created' };
}

/** Insights of these types that no sweep has refreshed since `before` are stale: their inputs changed. */
export async function expireUnseen(
  tx: Executor,
  tenantId: string,
  types: InsightType[],
  before: Date,
): Promise<number> {
  const rows = await tx
    .update(schema.insights)
    .set({ status: 'expired', resolvedAt: new Date(), resolvedReason: 'inputs_changed' })
    .where(
      and(
        eq(schema.insights.tenantId, tenantId),
        inArray(schema.insights.type, types),
        inArray(schema.insights.status, ['open', 'snoozed']),
        lt(schema.insights.lastSeenAt, before),
      ),
    )
    .returning({ id: schema.insights.id });
  for (const r of rows)
    await tx.insert(schema.insightEvents).values({
      tenantId,
      insightId: r.id,
      kind: 'expired',
      detail: { reason: 'inputs_changed' },
    });
  return rows.length;
}

/** Expire the open insight with this dedupe key (a criterion that has recovered). */
export async function expireByKey(
  tx: Executor,
  tenantId: string,
  type: InsightType,
  keyParts: (string | number | null)[],
  reason: string,
) {
  const key = hashKey(dedupeParts(type, keyParts));
  const rows = await tx
    .update(schema.insights)
    .set({ status: 'expired', resolvedAt: new Date(), resolvedReason: reason })
    .where(
      and(
        eq(schema.insights.tenantId, tenantId),
        eq(schema.insights.dedupeKey, key),
        inArray(schema.insights.status, ['open', 'snoozed']),
      ),
    )
    .returning({ id: schema.insights.id });
  for (const r of rows)
    await tx
      .insert(schema.insightEvents)
      .values({ tenantId, insightId: r.id, kind: 'expired', detail: { reason } });
  return rows.length;
}

/** Expire one specific insight (an accepted opportunity that no longer holds). */
export async function expireOne(tx: Executor, tenantId: string, id: string, reason: string) {
  await tx
    .update(schema.insights)
    .set({ status: 'expired', resolvedAt: new Date(), resolvedReason: reason })
    .where(and(eq(schema.insights.id, id), eq(schema.insights.tenantId, tenantId)));
  await tx
    .insert(schema.insightEvents)
    .values({ tenantId, insightId: id, kind: 'expired', detail: { reason } });
}

export const openCount = sql<number>`count(*)::int`;
