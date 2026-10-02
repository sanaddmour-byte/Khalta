import { schema } from '@khalta/db';
import { canTransition } from '@khalta/engine';
import { assertNotAuthor, canAccessPlant } from '@khalta/rbac';
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, notFound } from '../errors';
import type { ApiRoutes } from '../route';

const idParam = z.object({ id: z.uuid() });
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const listQuery = z.object({
  status: z.enum(schema.DESIGN_STATUSES).optional(),
  plantId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
  /** The attestation queue: imported designs nobody has approved yet. */
  queue: bool.optional(),
  /** Attested designs whose latest evaluation failed a hard check. */
  revalidation: bool.optional(),
  /** `awaiting`: trial passed, waiting for approval; `trial`: trial candidates and trials in progress. */
  stage: z.enum(['awaiting', 'trial']).optional(),
});
const attestBody = z.strictObject({
  approvalReference: z.string().trim().min(2).max(200),
  approvedOn: z.iso.date().optional(),
  inProduction: z.boolean(),
  note: z.string().trim().min(5).max(500),
});

const card = {
  id: schema.mixDesigns.id,
  code: schema.mixDesigns.code,
  name: schema.mixDesigns.name,
  plantId: schema.mixDesigns.plantId,
  version: schema.mixDesigns.version,
  status: schema.mixDesigns.status,
  approvalSource: schema.mixDesigns.approvalSource,
  externalApprovalRef: schema.mixDesigns.externalApprovalRef,
  approvedAt: schema.mixDesigns.approvedAt,
  evaluationPending: schema.mixDesigns.evaluationPending,
  needsRevalidation: schema.mixDesigns.needsRevalidation,
  lastVerdict: schema.mixDesigns.lastVerdict,
  lastEvaluatedAt: schema.mixDesigns.lastEvaluatedAt,
  requirements: schema.mixDesigns.requirements,
  importedApprovalRef: schema.mixDesigns.importedApprovalRef,
  importedInProduction: schema.mixDesigns.importedInProduction,
  avgMonthlyVolumeM3: schema.mixDesigns.avgMonthlyVolumeM3,
  warnings: schema.mixDesigns.warnings,
  synthetic: schema.mixDesigns.synthetic,
  createdBy: schema.mixDesigns.createdBy,
};

export function designRoutes(api: ApiRoutes) {
  api.get(
    '/api/designs',
    {
      summary: 'List designs with their latest evaluation verdict (no cost figures)',
      capability: 'library.read',
      query: listQuery,
    },
    async ({ auth, query, db }) => {
      const where = [
        eq(schema.mixDesigns.tenantId, auth.tenantId),
        isNull(schema.mixDesigns.deletedAt),
      ];
      if (query.status) where.push(eq(schema.mixDesigns.status, query.status));
      if (query.plantId) where.push(eq(schema.mixDesigns.plantId, query.plantId));
      if (query.queue)
        where.push(
          inArray(schema.mixDesigns.status, ['draft', 'evaluated']),
          isNull(schema.mixDesigns.approvalSource),
          isNotNull(schema.mixDesigns.importBatchId),
        );
      if (query.stage === 'awaiting') where.push(eq(schema.mixDesigns.status, 'trial_passed'));
      if (query.stage === 'trial')
        where.push(inArray(schema.mixDesigns.status, ['trial_candidate', 'trial_in_progress']));
      if (query.revalidation) where.push(eq(schema.mixDesigns.needsRevalidation, true));
      if (query.q) {
        const like = `%${query.q.replace(/[%_\\]/g, '\\$&')}%`;
        where.push(or(ilike(schema.mixDesigns.code, like), ilike(schema.mixDesigns.name, like))!);
      }
      if (!auth.scope.all) {
        if (auth.scope.plantIds.length === 0) return [];
        where.push(inArray(schema.mixDesigns.plantId, [...auth.scope.plantIds]));
      }
      return db
        .select(card)
        .from(schema.mixDesigns)
        .where(and(...where))
        .orderBy(asc(schema.mixDesigns.code));
    },
  );

  api.get(
    '/api/designs/:id',
    {
      summary: 'One design with its lines, warnings and history',
      capability: 'library.read',
      params: idParam,
    },
    async ({ auth, params, db }) => {
      const [d] = await db
        .select({
          ...card,
          importBatchId: schema.mixDesigns.importBatchId,
          inputsSnapshot: schema.mixDesigns.inputsSnapshot,
        })
        .from(schema.mixDesigns)
        .where(
          and(
            eq(schema.mixDesigns.id, params.id),
            eq(schema.mixDesigns.tenantId, auth.tenantId),
            isNull(schema.mixDesigns.deletedAt),
          ),
        );
      if (!d || !canAccessPlant(auth.scope, d.plantId)) throw notFound('Design not found');
      const [lines, transitions, batch] = await Promise.all([
        db
          .select({
            id: schema.mixDesignLines.id,
            materialId: schema.mixDesignLines.materialId,
            nameEn: schema.materials.marketNameEn,
            nameAr: schema.materials.marketNameAr,
            category: schema.materials.category,
            quantityKgM3: schema.mixDesignLines.quantityKgM3,
            originalQuantity: schema.mixDesignLines.originalQuantity,
            originalUnit: schema.mixDesignLines.originalUnit,
            originalName: schema.mixDesignLines.originalName,
            sourceLine: schema.mixDesignLines.sourceLine,
            matchMethod: schema.mixDesignLines.matchMethod,
          })
          .from(schema.mixDesignLines)
          .innerJoin(schema.materials, eq(schema.materials.id, schema.mixDesignLines.materialId))
          .where(eq(schema.mixDesignLines.designId, d.id))
          .orderBy(asc(schema.mixDesignLines.sourceLine)),
        db
          .select({
            id: schema.designTransitions.id,
            fromStatus: schema.designTransitions.fromStatus,
            toStatus: schema.designTransitions.toStatus,
            evidence: schema.designTransitions.evidence,
            esignature: schema.designTransitions.esignature,
            at: schema.designTransitions.at,
            actor: schema.users.name,
          })
          .from(schema.designTransitions)
          .leftJoin(schema.users, eq(schema.users.id, schema.designTransitions.actorId))
          .where(eq(schema.designTransitions.designId, d.id))
          .orderBy(desc(schema.designTransitions.at)),
        d.importBatchId
          ? db
              .select({ filename: schema.legacyImportBatches.filename })
              .from(schema.legacyImportBatches)
              .where(eq(schema.legacyImportBatches.id, d.importBatchId))
          : Promise.resolve([]),
      ]);
      return { design: d, lines, transitions, source: batch[0]?.filename ?? null };
    },
  );

  api.mutate(
    'post',
    '/api/designs/:id/attest',
    {
      summary:
        'Attest an imported design that was approved outside Khalta (four-eyes, e-signature note)',
      capability: 'design.attest',
      body: attestBody,
      params: idParam,
    },
    async ({ auth, body, params, tx, audit }) => {
      const [d] = await tx
        .select()
        .from(schema.mixDesigns)
        .where(
          and(
            eq(schema.mixDesigns.id, params.id),
            eq(schema.mixDesigns.tenantId, auth.tenantId),
            isNull(schema.mixDesigns.deletedAt),
          ),
        )
        .for('update');
      if (!d || !canAccessPlant(auth.scope, d.plantId)) throw notFound('Design not found');
      if (
        !['draft', 'evaluated'].includes(d.status) ||
        d.approvalSource !== null ||
        !d.importBatchId
      )
        throw new ApiError(
          409,
          'conflict',
          'Only an imported design awaiting attestation can be attested',
        );
      // The lifecycle graph decides, and names its evidence (a legacy attestation is the one path
      // to approved without a Khalta trial).
      const steps0 = [
        canTransition(d.status, 'approved', ['legacy_attestation']),
        ...(body.inProduction ? [canTransition('approved', 'in_production', ['release'])] : []),
      ];
      const refused = steps0.find((v) => !v.ok);
      if (refused && !refused.ok) throw new ApiError(409, 'conflict', refused.reason);
      assertNotAuthor(auth.user.id, d.createdBy); // the importer cannot attest their own import
      const now = new Date();
      const approvedAt = body.approvedOn ? new Date(`${body.approvedOn}T00:00:00Z`) : now;
      const target = body.inProduction ? 'in_production' : 'approved';
      // One graph edge at a time (the database refuses anything else): approved, then in production.
      await tx
        .update(schema.mixDesigns)
        .set({
          status: 'approved',
          approvalSource: 'legacy_attested',
          externalApprovalRef: body.approvalReference,
          approvedBy: auth.user.id,
          approvedAt,
          updatedAt: now,
        })
        .where(eq(schema.mixDesigns.id, d.id));
      if (target === 'in_production')
        await tx
          .update(schema.mixDesigns)
          .set({ status: 'in_production', updatedAt: now })
          .where(eq(schema.mixDesigns.id, d.id));
      const evidence = {
        kind: 'legacy_attestation',
        approvalReference: body.approvalReference,
        note: body.note,
        note_scope: 'approved outside Khalta; not evaluated by Khalta',
      };
      const steps = body.inProduction
        ? (['approved', 'in_production'] as const)
        : (['approved'] as const);
      let from: string = d.status;
      for (const to of steps) {
        await tx.insert(schema.designTransitions).values({
          tenantId: auth.tenantId,
          designId: d.id,
          fromStatus: from,
          toStatus: to,
          actorId: auth.user.id,
          evidence,
        });
        from = to;
      }
      await audit.record({
        action: 'design.attest',
        entityType: 'mix_design',
        entityId: d.id,
        before: { status: d.status },
        after: {
          status: target,
          approvalSource: 'legacy_attested',
          externalApprovalRef: body.approvalReference,
        },
      });
      return { id: d.id, status: target };
    },
  );
}
