// Change-impact list (what a change touched and what a person decided). Reading is open to anyone who can read the
// library, within their plants. A disposition is an engineering decision: QC manager only, with a reason, once.
import { schema } from '@khalta/db';
import {
  dispositionAllowed,
  DISPOSITIONS,
  IMPACT_TRIGGERS,
  type ImpactClass,
} from '@khalta/engine';
import { canAccessPlant } from '@khalta/rbac';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, notFound } from '../errors';
import type { ApiRoutes } from '../route';

const listQuery = z.object({
  state: z.enum(['pending', 'running', 'failed', 'completed']).optional(),
  trigger: z.enum(IMPACT_TRIGGERS).optional(),
  open: z.enum(['true', 'false']).optional(),
});
const itemParam = z.object({ id: z.uuid() });
const dispositionBody = z.strictObject({
  disposition: z.enum(DISPOSITIONS),
  reason: z.string().trim().min(10).max(500),
});

export function changeImpactRoutes(api: ApiRoutes) {
  api.get(
    '/api/change-impacts',
    {
      summary:
        'Changes that touched approved designs, newest first: the job state (pending, running, failed, completed), each design touched, its class and any disposition',
      capability: 'library.read',
      query: listQuery,
    },
    async ({ auth, query, db }) => {
      const impacts = await db
        .select()
        .from(schema.changeImpacts)
        .where(
          and(
            eq(schema.changeImpacts.tenantId, auth.tenantId),
            ...(query.state ? [eq(schema.changeImpacts.jobState, query.state)] : []),
            ...(query.trigger ? [eq(schema.changeImpacts.trigger, query.trigger)] : []),
          ),
        )
        .orderBy(desc(schema.changeImpacts.createdAt))
        .limit(100);
      if (impacts.length === 0) return [];
      const items = await db
        .select({
          i: schema.changeImpactItems,
          code: schema.mixDesigns.code,
          name: schema.mixDesigns.name,
          plantCode: schema.plants.code,
        })
        .from(schema.changeImpactItems)
        .innerJoin(schema.mixDesigns, eq(schema.mixDesigns.id, schema.changeImpactItems.designId))
        .innerJoin(schema.plants, eq(schema.plants.id, schema.changeImpactItems.plantId))
        .where(
          inArray(
            schema.changeImpactItems.impactId,
            impacts.map((i) => i.id),
          ),
        );
      const visible = items.filter((x) => canAccessPlant(auth.scope, x.i.plantId));
      return impacts
        .map((imp) => {
          const mine = visible.filter((x) => x.i.impactId === imp.id);
          return {
            id: imp.id,
            trigger: imp.trigger,
            subject: imp.subject,
            jobState: imp.jobState,
            attempts: imp.attempts,
            lastError: imp.lastError,
            summary: imp.summary,
            createdAt: imp.createdAt,
            finishedAt: imp.finishedAt,
            items: mine
              .filter(
                (x) => query.open !== 'true' || (x.i.klass !== 'no_action' && !x.i.disposition),
              )
              .map((x) => ({
                id: x.i.id,
                designId: x.i.designId,
                designCode: x.code,
                designName: x.name,
                designVersion: x.i.designVersion,
                plantCode: x.plantCode,
                class: x.i.klass,
                reasons: x.i.reasons,
                disposition: x.i.disposition,
                dispositionAt: x.i.dispositionAt,
                dispositionNote: x.i.dispositionNote,
              })),
          };
        })
        .filter((imp) => query.open !== 'true' || imp.items.length > 0);
    },
  );

  api.mutate(
    'post',
    '/api/change-impacts/items/:id/disposition',
    {
      summary:
        'Record the decision on one design a change touched (QC manager, with a reason, once). It does not alter or suspend the design: that remains its own, signed lifecycle move',
      capability: 'design.approve',
      params: itemParam,
      body: dispositionBody,
    },
    async ({ auth, params, body, tx, audit }) => {
      const [row] = await tx
        .select()
        .from(schema.changeImpactItems)
        .where(
          and(
            eq(schema.changeImpactItems.id, params.id),
            eq(schema.changeImpactItems.tenantId, auth.tenantId),
          ),
        )
        .for('update');
      if (!row || !canAccessPlant(auth.scope, row.plantId)) throw notFound('Item not found');
      if (row.disposition)
        throw new ApiError(409, 'conflict', 'A decision was already recorded for this item');
      if (!dispositionAllowed(row.klass as ImpactClass, body.disposition))
        throw new ApiError(
          409,
          'disposition_not_allowed',
          `"${body.disposition}" does not answer a "${row.klass}" finding`,
        );
      await tx
        .update(schema.changeImpactItems)
        .set({
          disposition: body.disposition,
          dispositionBy: auth.user.id,
          dispositionAt: new Date(),
          dispositionNote: body.reason,
        })
        .where(eq(schema.changeImpactItems.id, row.id));
      await audit.record({
        action: 'change_impact.disposition',
        entityType: 'change_impact_item',
        entityId: row.id,
        before: { class: row.klass, disposition: null },
        after: { disposition: body.disposition, designId: row.designId, reason: body.reason },
      });
      return { id: row.id, disposition: body.disposition };
    },
  );
}
