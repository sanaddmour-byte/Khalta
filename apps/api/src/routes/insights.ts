// Insights inbox (F-027): list, triage (dismiss / snooze), accept (a trial-only draft, never above trial_candidate),
// and the daily digest. Cost-blind roles receive no cost figures. Insights never change a design by themselves.
import { schema } from '@khalta/db';
import { savingPerM3, todayAmman } from '@khalta/engine';
import { canAccessPlant, roleCan } from '@khalta/rbac';
import { and, desc, eq, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, notFound } from '../errors';
import { loadDesign } from '../evaluation/run';
import { priceDesign } from '../insights/pricing';
import { expireOne } from '../insights/service';
import { baselineFor } from '../savings/service';
import type { ApiRoutes } from '../route';
import { createRequest, requestTrialDesign } from './designRequests';
import { createSnapshot } from './prices';
import { requestBody, type RequestBody } from '../optimizer/service';
import type { AuthContext } from '../middleware';

const idParam = z.object({ id: z.uuid() });
const listQuery = z.object({
  status: z.enum(['open', 'snoozed', 'dismissed', 'accepted', 'expired']).optional(),
  type: z.string().max(40).optional(),
  severity: z.enum(['info', 'medium', 'high', 'critical']).optional(),
  plantId: z.uuid().optional(),
});
const dismissBody = z.strictObject({ reason: z.string().trim().min(3).max(300) });
const snoozeBody = z.strictObject({ days: z.union([z.literal(1), z.literal(7)]) });

type Row = typeof schema.insights.$inferSelect;
const shape = (auth: AuthContext, r: Row) => {
  const cost = roleCan(auth.role, 'cost.view', auth.settings);
  return {
    id: r.id,
    type: r.type,
    severity: r.severity,
    status: r.status,
    plantId: r.plantId,
    designId: r.designId,
    payload: r.payload,
    savingJodPerM3: cost ? r.savingJodPerM3 : null,
    annualJod: cost ? r.annualJod : null,
    theoretical: r.type === 'opportunity',
    provisional: r.provisional,
    snoozedUntil: r.snoozedUntil,
    resolvedReason: r.resolvedReason,
    draftDesignId: r.draftDesignId,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
  };
};
const visible = (auth: AuthContext, r: Row) => !r.plantId || canAccessPlant(auth.scope, r.plantId);

export function insightRoutes(api: ApiRoutes) {
  api.get(
    '/api/insights',
    {
      summary: 'The insights inbox (snoozed ones return when their time is up)',
      capability: 'library.read',
      query: listQuery,
    },
    async ({ auth, query, db }) => {
      const where = [eq(schema.insights.tenantId, auth.tenantId)];
      if (query.status === 'open' || !query.status)
        where.push(
          or(
            eq(schema.insights.status, 'open'),
            and(
              eq(schema.insights.status, 'snoozed'),
              lte(schema.insights.snoozedUntil, new Date()),
            ),
          )!,
        );
      else where.push(eq(schema.insights.status, query.status));
      if (query.type) where.push(eq(schema.insights.type, query.type as Row['type']));
      if (query.severity) where.push(eq(schema.insights.severity, query.severity));
      if (query.plantId) where.push(eq(schema.insights.plantId, query.plantId));
      const rows = await db
        .select()
        .from(schema.insights)
        .where(and(...where))
        .orderBy(
          sql`case ${schema.insights.severity} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`,
          desc(schema.insights.lastSeenAt),
        )
        .limit(200);
      return rows.filter((r) => visible(auth, r)).map((r) => shape(auth, r));
    },
  );

  api.get(
    '/api/insights/digest',
    { summary: 'The latest daily digest (taken by the nightly sweep)', capability: 'library.read' },
    async ({ auth, db }) => {
      const [d] = await db
        .select()
        .from(schema.dailyDigests)
        .where(eq(schema.dailyDigests.tenantId, auth.tenantId))
        .orderBy(desc(schema.dailyDigests.day))
        .limit(1);
      if (!d) return null;
      const s = d.summary as { topOpportunities?: unknown[] } & Record<string, unknown>;
      const cost = roleCan(auth.role, 'cost.view', auth.settings);
      return {
        day: d.day,
        summary: cost ? s : { ...s, topOpportunities: [] },
        createdAt: d.createdAt,
      };
    },
  );

  api.get(
    '/api/insights/:id',
    { summary: 'One insight with its history', capability: 'library.read', params: idParam },
    async ({ auth, params, db }) => {
      const [r] = await db
        .select()
        .from(schema.insights)
        .where(and(eq(schema.insights.id, params.id), eq(schema.insights.tenantId, auth.tenantId)));
      if (!r || !visible(auth, r)) throw notFound('Insight not found');
      const events = await db
        .select()
        .from(schema.insightEvents)
        .where(eq(schema.insightEvents.insightId, r.id))
        .orderBy(desc(schema.insightEvents.at));
      return { insight: shape(auth, r), events };
    },
  );

  const load = async (tx: Parameters<typeof loadDesign>[0], auth: AuthContext, id: string) => {
    const [r] = await tx
      .select()
      .from(schema.insights)
      .where(and(eq(schema.insights.id, id), eq(schema.insights.tenantId, auth.tenantId)))
      .for('update');
    if (!r || !visible(auth, r)) throw notFound('Insight not found');
    if (!['open', 'snoozed'].includes(r.status))
      throw new ApiError(409, 'conflict', `This insight is already ${r.status}`);
    return r;
  };

  api.mutate(
    'post',
    '/api/insights/:id/dismiss',
    {
      summary: 'Dismiss an insight with a reason',
      capability: 'insight.draft',
      params: idParam,
      body: dismissBody,
    },
    async ({ auth, params, body, tx, audit }) => {
      const r = await load(tx, auth, params.id);
      await tx
        .update(schema.insights)
        .set({
          status: 'dismissed',
          resolvedReason: body.reason,
          resolvedBy: auth.user.id,
          resolvedAt: new Date(),
        })
        .where(eq(schema.insights.id, r.id));
      await tx.insert(schema.insightEvents).values({
        tenantId: auth.tenantId,
        insightId: r.id,
        kind: 'dismissed',
        actorId: auth.user.id,
        detail: { reason: body.reason },
      });
      await audit.record({
        action: 'insight.dismiss',
        entityType: 'insight',
        entityId: r.id,
        after: { reason: body.reason },
      });
      return { id: r.id, status: 'dismissed' };
    },
  );

  api.mutate(
    'post',
    '/api/insights/:id/snooze',
    {
      summary: 'Snooze an insight for 1 day or 1 week',
      capability: 'insight.draft',
      params: idParam,
      body: snoozeBody,
    },
    async ({ auth, params, body, tx, audit }) => {
      const r = await load(tx, auth, params.id);
      const until = new Date(Date.now() + body.days * 86_400_000);
      await tx
        .update(schema.insights)
        .set({ status: 'snoozed', snoozedUntil: until })
        .where(eq(schema.insights.id, r.id));
      await tx.insert(schema.insightEvents).values({
        tenantId: auth.tenantId,
        insightId: r.id,
        kind: 'snoozed',
        actorId: auth.user.id,
        detail: { until },
      });
      await audit.record({
        action: 'insight.snooze',
        entityType: 'insight',
        entityId: r.id,
        after: { until },
      });
      return { id: r.id, status: 'snoozed', snoozedUntil: until };
    },
  );

  api.mutate(
    'post',
    '/api/insights/:id/accept',
    {
      summary:
        'Accept an opportunity: re-run the optimizer now and create a trial-only draft (the next version of the design, at TRIAL CANDIDATE; never approved)',
      capability: 'insight.accept',
      params: idParam,
      status: 201,
    },
    async ({ auth, params, tx, audit }) => {
      const r = await load(tx, auth, params.id);
      if (r.type !== 'opportunity' || !r.designId)
        throw new ApiError(409, 'conflict', 'Only an opportunity can be accepted');
      const parent = await loadDesign(tx, auth, r.designId, true);
      if (!['approved', 'in_production'].includes(parent.status)) {
        await expireOne(tx, auth.tenantId, r.id, 'design_not_live');
        throw new ApiError(
          409,
          'no_longer_holds',
          'The design is no longer approved or in production',
        );
      }
      const body = requestBody.parse((r.payload as { request: RequestBody }).request);
      const nowCost = await priceDesign(tx, auth.tenantId, parent);
      const run = await createRequest(tx, auth, audit, body);
      const cand = (
        run as {
          candidates: {
            id: string;
            rank: number;
            costJodPerM3: string | null;
            requiresAuthorization: boolean;
          }[];
        }
      ).candidates.find((c) => c.costJodPerM3 !== null && !c.requiresAuthorization);
      if (
        !cand?.costJodPerM3 ||
        !nowCost.cost ||
        Number(savingPerM3(nowCost.cost, cand.costJodPerM3)) <= 0
      ) {
        await expireOne(tx, auth.tenantId, r.id, 'no_longer_holds');
        throw new ApiError(
          409,
          'no_longer_holds',
          "At today's prices this opportunity no longer holds",
        );
      }
      const [{ top }] = (await tx
        .select({ top: sql<number>`max(${schema.mixDesigns.version})` })
        .from(schema.mixDesigns)
        .where(
          and(
            eq(schema.mixDesigns.tenantId, auth.tenantId),
            eq(schema.mixDesigns.code, parent.code),
          ),
        )) as [{ top: number }];
      const made = await requestTrialDesign(
        tx,
        auth,
        audit,
        { id: (run as { id: string }).id, cid: cand.id },
        { code: parent.code, name: `${parent.name} (opportunity)` },
        { version: top + 1, parentDesignId: parent.id },
      );
      // THEORETICAL ledger entry: baseline and draft both priced at ONE snapshot taken now (the current prices), so
      // the figure is the optimizer's claim at today's prices and never credits market movement between two dates.
      const found = await baselineFor(tx, auth.tenantId, parent);
      let ledger: string | null = null;
      if (found) {
        const today = todayAmman();
        const snap = await createSnapshot(
          tx,
          auth,
          audit,
          { name: `Opportunity ${parent.code} ${today}`, asOf: today, plantIds: [parent.plantId] },
          auth.user.id,
        );
        const [d] = await tx
          .select()
          .from(schema.mixDesigns)
          .where(eq(schema.mixDesigns.id, made.design.id));
        const [pb, pn] = [
          await priceDesign(tx, auth.tenantId, found.design, { snapshotId: snap.id }),
          await priceDesign(tx, auth.tenantId, d!, { snapshotId: snap.id }),
        ];
        if (
          pb.cost &&
          pn.cost &&
          pb.validatorPass &&
          pn.validatorPass &&
          Number(savingPerM3(pb.cost, pn.cost)) > 0
        ) {
          const perM3 = savingPerM3(pb.cost, pn.cost);
          const [e] = await tx
            .insert(schema.savingsEntries)
            .values({
              tenantId: auth.tenantId,
              baselineId: found.baseline.id,
              baselineDesignId: found.design.id,
              variantDesignId: d!.id,
              variantEvaluationId: made.evaluationId,
              priceSnapshotId: snap.id,
              state: 'theoretical',
              reasonCode: 'insight',
              savingJodPerM3: perM3,
              monthlyVolumeM3: found.baseline.monthlyVolumeM3,
              baselineCostJodPerM3: pb.cost,
              replacementCostJodPerM3: pn.cost,
              provisional: pn.provisional || pb.provisional,
              insightId: r.id,
              createdBy: auth.user.id,
            })
            .returning({ id: schema.savingsEntries.id });
          ledger = e!.id;
        }
      }
      await tx
        .update(schema.insights)
        .set({
          status: 'accepted',
          resolvedBy: auth.user.id,
          resolvedAt: new Date(),
          draftDesignId: made.design.id,
          resolvedReason: 'accepted',
        })
        .where(eq(schema.insights.id, r.id));
      await tx.insert(schema.insightEvents).values({
        tenantId: auth.tenantId,
        insightId: r.id,
        kind: 'accepted',
        actorId: auth.user.id,
        detail: { draftDesignId: made.design.id },
      });
      await audit.record({
        action: 'insight.accept',
        entityType: 'insight',
        entityId: r.id,
        after: { draftDesignId: made.design.id, status: 'trial_candidate' },
      });
      return { id: r.id, status: 'accepted', design: made.design, theoreticalEntryId: ledger };
    },
  );

  api.get(
    '/api/system/jobs',
    { summary: 'Background job health (admin)', capability: 'org.manage' },
    async () => (await api.jobStatus?.()) ?? { mode: 'none' },
  );
}
