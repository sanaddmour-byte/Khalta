// Savings ledger states beyond theoretical (01-domain §14.2). Approved: the replacement's cost vs the baseline design's,
// both at ONE snapshot taken at approval. Realized: per month, both at THAT month's snapshot, × the produced volume.
// A missing volume, snapshot or price blocks the month and says which; nothing is estimated.
import { schema, type AuditRecorder, type Executor, type Tx } from '@khalta/db';
import {
  annualised,
  monthEnd,
  monthOf,
  monthsBetween,
  realizedForMonth,
  savingPerM3,
  todayAmman,
} from '@khalta/engine';
import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import type { DesignRow } from '../evaluation/service';
import type { AuthContext } from '../middleware';
import { priceDesign } from '../insights/pricing';
import { createSnapshot } from '../routes/prices';
import { loadSettings } from '../settings';

/** An all-plants admin context for system jobs (no user: rows it writes carry a null author). */
export async function systemAuth(db: Executor, tenantId: string): Promise<AuthContext> {
  return {
    user: { id: 'system', name: 'System', email: '' },
    role: 'admin',
    tenantId,
    scope: { all: true, plantIds: [] },
    settings: await loadSettings(db, tenantId),
    ctx: { tenantId, actor: null, requestId: 'system' },
  } as unknown as AuthContext;
}

/** The nearest design in `d`'s lineage (itself, then its parents) that has a cost baseline. */
export async function baselineFor(db: Executor, tenantId: string, d: DesignRow) {
  let cur: DesignRow | undefined = d;
  for (let i = 0; i < 20 && cur; i++) {
    const [b] = await db
      .select()
      .from(schema.costBaselines)
      .where(
        and(eq(schema.costBaselines.tenantId, tenantId), eq(schema.costBaselines.designId, cur.id)),
      )
      .orderBy(desc(schema.costBaselines.createdAt))
      .limit(1);
    if (b) return { baseline: b, design: cur };
    if (!cur.parentDesignId) return null;
    [cur] = await db
      .select()
      .from(schema.mixDesigns)
      .where(eq(schema.mixDesigns.id, cur.parentDesignId));
  }
  return null;
}

async function snapshotFor(
  tx: Tx,
  audit: AuditRecorder,
  auth: AuthContext,
  plantId: string,
  want: { name: string; from: string; to: string; createAsOf: string | null },
) {
  const [existing] = await tx
    .select()
    .from(schema.priceSnapshots)
    .where(
      and(
        eq(schema.priceSnapshots.tenantId, auth.tenantId),
        gte(schema.priceSnapshots.asOf, want.from),
        lte(schema.priceSnapshots.asOf, want.to),
      ),
    )
    .orderBy(desc(schema.priceSnapshots.asOf), desc(schema.priceSnapshots.createdAt));
  if (existing && (existing.plantIds as string[]).includes(plantId)) return existing.id;
  if (want.createAsOf === null) return null;
  const made = await createSnapshot(
    tx,
    auth,
    audit,
    { name: want.name, asOf: want.createAsOf, plantIds: [plantId] },
    null,
  );
  return made.id;
}

export type ApprovedResult =
  | { state: 'created'; entryId: string; perM3: string }
  | { state: 'skipped'; reason: 'no_baseline' | 'cost_incomplete' | 'not_a_version' };

/** Called when a design is approved: if it replaces a baselined design, record the APPROVED saving. */
export async function createApprovedEntry(
  tx: Tx,
  audit: AuditRecorder,
  auth: AuthContext,
  d: DesignRow,
): Promise<ApprovedResult> {
  if (!d.parentDesignId) return { state: 'skipped', reason: 'not_a_version' };
  const parent = (
    await tx.select().from(schema.mixDesigns).where(eq(schema.mixDesigns.id, d.parentDesignId))
  )[0];
  if (!parent) return { state: 'skipped', reason: 'not_a_version' };
  const found = await baselineFor(tx, auth.tenantId, parent);
  if (!found) return { state: 'skipped', reason: 'no_baseline' };
  const today = todayAmman();
  const snapId = (await snapshotFor(tx, audit, auth, d.plantId, {
    name: `Approval ${d.code} v${d.version}`,
    from: today,
    to: today,
    createAsOf: today,
  }))!;
  const [pb, pn] = [
    await priceDesign(tx, auth.tenantId, found.design, { snapshotId: snapId }),
    await priceDesign(tx, auth.tenantId, d, { snapshotId: snapId }),
  ];
  if (!pb.cost || !pn.cost || !pb.validatorPass || !pn.validatorPass)
    return { state: 'skipped', reason: 'cost_incomplete' };
  const perM3 = savingPerM3(pb.cost, pn.cost);
  const vol = found.baseline.monthlyVolumeM3;
  const [e] = await tx
    .insert(schema.savingsEntries)
    .values({
      tenantId: auth.tenantId,
      baselineId: found.baseline.id,
      baselineDesignId: found.design.id,
      variantDesignId: d.id,
      priceSnapshotId: snapId,
      state: 'approved',
      reasonCode: 'approval',
      savingJodPerM3: perM3,
      monthlyVolumeM3: vol,
      annualJod: vol ? annualised(perM3, vol) : null,
      baselineCostJodPerM3: pb.cost,
      replacementCostJodPerM3: pn.cost,
      totalJod: vol ? annualised(perM3, vol) : null,
      provisional: pn.provisional || pb.provisional,
      createdBy: auth.user.id === 'system' ? null : auth.user.id,
    })
    .returning({ id: schema.savingsEntries.id });
  await audit.record({
    action: 'savings.approved',
    entityType: 'savings_entry',
    entityId: e!.id,
    after: {
      baselineId: found.baseline.id,
      variantDesignId: d.id,
      savingJodPerM3: perM3,
      state: 'approved',
      snapshot: snapId,
    },
  });
  return { state: 'created', entryId: e!.id, perM3 };
}

/** The effective monthly volume rows of a design: the latest entry per month wins (corrections are new rows). */
export async function effectiveVolumes(db: Executor, designId: string) {
  const rows = await db
    .select()
    .from(schema.productionVolumes)
    .where(eq(schema.productionVolumes.designId, designId))
    .orderBy(asc(schema.productionVolumes.month), asc(schema.productionVolumes.createdAt));
  const byMonth = new Map<string, (typeof rows)[number]>();
  for (const r of rows) byMonth.set(r.month, r);
  return byMonth;
}

export interface BlockedMonth {
  month: string;
  reason: 'no_volume' | 'no_snapshot' | 'cost_incomplete';
}

/**
 * Realized entries for every completed month since the replacement was approved. With `create`, a missing month
 * snapshot is taken now (the nightly job's month-close snapshot); without it the month is reported as blocked.
 */
export async function realizeForEntry(
  tx: Tx,
  audit: AuditRecorder,
  auth: AuthContext,
  approved: typeof schema.savingsEntries.$inferSelect,
  opts: { create: boolean; persist: boolean },
): Promise<{
  entries: { month: string; perM3: string; total: string; volume: string }[];
  blocked: BlockedMonth[];
}> {
  const [replacement] = await tx
    .select()
    .from(schema.mixDesigns)
    .where(eq(schema.mixDesigns.id, approved.variantDesignId));
  const [baselineDesign] = await tx
    .select()
    .from(schema.mixDesigns)
    .where(eq(schema.mixDesigns.id, approved.baselineDesignId));
  if (!replacement || !baselineDesign) return { entries: [], blocked: [] };
  const today = todayAmman();
  const thisMonth = monthOf(today);
  // months count from the replacement's approval (the entry's own date is when it was recorded)
  const first = monthOf((replacement.approvedAt ?? approved.createdAt).toISOString().slice(0, 10));
  const months = monthsBetween(first, thisMonth).filter((m) => m < thisMonth);
  const volumes = await effectiveVolumes(tx, replacement.id);
  const done = new Set(
    (
      await tx
        .select({ period: schema.savingsEntries.period })
        .from(schema.savingsEntries)
        .where(
          and(
            eq(schema.savingsEntries.baselineId, approved.baselineId),
            eq(schema.savingsEntries.variantDesignId, replacement.id),
            eq(schema.savingsEntries.state, 'realized'),
          ),
        )
    ).map((r) => r.period),
  );
  const entries: { month: string; perM3: string; total: string; volume: string }[] = [];
  const blocked: BlockedMonth[] = [];
  for (const m of months) {
    if (done.has(m)) continue;
    const vol = volumes.get(m);
    if (!vol) {
      blocked.push({ month: m, reason: 'no_volume' });
      continue;
    }
    const snapId = await snapshotFor(tx, audit, auth, replacement.plantId, {
      name: `Month close ${m.slice(0, 7)}`,
      from: m,
      to: monthEnd(m),
      createAsOf: opts.create ? today : null,
    });
    if (!snapId) {
      blocked.push({ month: m, reason: 'no_snapshot' });
      continue;
    }
    const [pb, pn] = [
      await priceDesign(tx, auth.tenantId, baselineDesign, { snapshotId: snapId }),
      await priceDesign(tx, auth.tenantId, replacement, { snapshotId: snapId }),
    ];
    if (!pb.cost || !pn.cost || !pb.validatorPass || !pn.validatorPass) {
      blocked.push({ month: m, reason: 'cost_incomplete' });
      continue;
    }
    const r = realizedForMonth({
      baselineCostAtMonth: pb.cost,
      replacementCostAtMonth: pn.cost,
      producedM3: vol.volumeM3,
    });
    entries.push({ month: m, perM3: r.perM3, total: r.total, volume: vol.volumeM3 });
    if (opts.persist) {
      const [e] = await tx
        .insert(schema.savingsEntries)
        .values({
          tenantId: auth.tenantId,
          baselineId: approved.baselineId,
          baselineDesignId: approved.baselineDesignId,
          variantDesignId: replacement.id,
          priceSnapshotId: snapId,
          state: 'realized',
          reasonCode: 'month',
          period: m,
          producedVolumeM3: vol.volumeM3,
          savingJodPerM3: r.perM3,
          baselineCostJodPerM3: pb.cost,
          replacementCostJodPerM3: pn.cost,
          totalJod: r.total,
          provisional: pn.provisional || pb.provisional,
        })
        .returning({ id: schema.savingsEntries.id });
      await audit.record({
        action: 'savings.realized',
        entityType: 'savings_entry',
        entityId: e!.id,
        after: {
          period: m,
          perM3: r.perM3,
          total: r.total,
          volume: vol.volumeM3,
          snapshot: snapId,
        },
      });
    }
  }
  return { entries, blocked };
}
