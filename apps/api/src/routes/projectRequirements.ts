// Project requirements: a versioned record per project reference. A draft is edited; verification (a second person)
// freezes it; a change is a new revision. Limits stated on different bases are reported, never merged.
import { createHash } from 'node:crypto';
import { schema, type Executor, type Tx } from '@khalta/db';
import {
  canonicalJson,
  projectRequirementsSchema,
  resolveGoverningLimits,
  type ProjectRequirementsContent,
} from '@khalta/engine';
import { assertNotAuthor } from '@khalta/rbac';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, notFound } from '../errors';
import type { AuthContext } from '../middleware';
import type { ApiRoutes } from '../route';

const idParam = z.object({ id: z.uuid() });
/** SHA-256 of the canonical text: what a verification and every frozen copy bind to. */
export const contentHash = (c: ProjectRequirementsContent) =>
  createHash('sha256').update(canonicalJson(c)).digest('hex');
const listQuery = z.object({
  projectRef: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['draft', 'verified', 'superseded']).optional(),
});
const createBody = z.strictObject({
  projectRef: z.string().trim().min(1).max(120),
  content: projectRequirementsSchema,
});
const patchBody = z.strictObject({ content: projectRequirementsSchema });
const verifyBody = z.strictObject({ reason: z.string().trim().min(5).max(500) });

type Row = typeof schema.projectRequirements.$inferSelect;

const view = (r: Row) => ({
  id: r.id,
  projectRef: r.projectRef,
  revision: r.revision,
  status: r.status,
  contentHash: r.contentHash,
  supersedesId: r.supersedesId,
  supersededById: r.supersededById,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
  verifiedBy: r.verifiedBy,
  verifiedAt: r.verifiedAt,
});

async function load(tx: Executor, auth: AuthContext, id: string, lock = false): Promise<Row> {
  const where = and(
    eq(schema.projectRequirements.id, id),
    eq(schema.projectRequirements.tenantId, auth.tenantId),
  );
  const rows = lock
    ? await tx.select().from(schema.projectRequirements).where(where).for('update')
    : await tx.select().from(schema.projectRequirements).where(where);
  if (!rows[0]) throw notFound('Project requirements not found');
  return rows[0];
}

/**
 * A design freezes a VERIFIED revision (its id and a copy of the content). Anything else is refused with a reason:
 * a draft is not yet a requirement, and a superseded revision is no longer the project's.
 */
export async function freezeRevision(tx: Tx, auth: AuthContext, revisionId: string) {
  const r = await load(tx, auth, revisionId);
  if (r.status !== 'verified')
    throw new ApiError(
      409,
      'requirements_not_verified',
      r.status === 'draft'
        ? 'These project requirements are a draft: a second person must verify them first'
        : 'These project requirements were superseded by a newer revision',
      { status: r.status, projectRef: r.projectRef, revision: r.revision },
    );
  return {
    requirementsRevisionId: r.id,
    requirementsFrozen: {
      projectRef: r.projectRef,
      revision: r.revision,
      contentHash: r.contentHash,
      content: r.content,
    },
  };
}

/** The project's current verified revision for a design's project reference (null when it has none or none is verified). */
export async function currentRevisionFor(
  tx: Executor,
  tenantId: string,
  parentDesignId: string,
): Promise<string | null> {
  const [parent] = await tx
    .select({ frozen: schema.mixDesigns.requirementsFrozen })
    .from(schema.mixDesigns)
    .where(eq(schema.mixDesigns.id, parentDesignId));
  const ref = (parent?.frozen as { projectRef?: string } | null)?.projectRef;
  if (!ref) return null;
  const [cur] = await tx
    .select({ id: schema.projectRequirements.id })
    .from(schema.projectRequirements)
    .where(
      and(
        eq(schema.projectRequirements.tenantId, tenantId),
        eq(schema.projectRequirements.projectRef, ref),
        eq(schema.projectRequirements.status, 'verified'),
      ),
    );
  return cur?.id ?? null;
}

export function projectRequirementRoutes(api: ApiRoutes) {
  api.get(
    '/api/project-requirements',
    {
      summary: 'Project requirements revisions, newest first',
      capability: 'library.read',
      query: listQuery,
    },
    async ({ auth, query, db }) => {
      const where = [eq(schema.projectRequirements.tenantId, auth.tenantId)];
      if (query.projectRef) where.push(eq(schema.projectRequirements.projectRef, query.projectRef));
      if (query.status) where.push(eq(schema.projectRequirements.status, query.status));
      const rows = await db
        .select()
        .from(schema.projectRequirements)
        .where(and(...where))
        .orderBy(desc(schema.projectRequirements.createdAt));
      return rows.map(view);
    },
  );

  api.get(
    '/api/project-requirements/:id',
    {
      summary: 'One revision with its content and how its limits resolve',
      capability: 'library.read',
      params: idParam,
    },
    async ({ auth, params, db }) => {
      const r = await load(db, auth, params.id);
      const content = r.content as ProjectRequirementsContent;
      return { ...view(r), content, limits: resolveGoverningLimits(content.governingLimits) };
    },
  );

  api.mutate(
    'post',
    '/api/project-requirements',
    {
      summary:
        'Create a draft revision (the first for a project reference, or the next one, which will supersede the verified one on verification)',
      capability: 'design.write',
      body: createBody,
      status: 201,
    },
    async ({ auth, body, tx, audit }) => {
      const rows = await tx
        .select()
        .from(schema.projectRequirements)
        .where(
          and(
            eq(schema.projectRequirements.tenantId, auth.tenantId),
            eq(schema.projectRequirements.projectRef, body.projectRef),
          ),
        )
        .orderBy(desc(schema.projectRequirements.revision))
        .for('update');
      if (rows.some((r) => r.status === 'draft'))
        throw new ApiError(
          409,
          'draft_exists',
          'This project already has a draft revision: edit or verify it first',
        );
      const latest = rows[0];
      const revision = (latest?.revision ?? 0) + 1;
      const [row] = await tx
        .insert(schema.projectRequirements)
        .values({
          tenantId: auth.tenantId,
          projectRef: body.projectRef,
          revision,
          content: body.content,
          contentHash: contentHash(body.content),
          supersedesId: rows.find((r) => r.status === 'verified')?.id ?? null,
          createdBy: auth.user.id,
        })
        .returning();
      await audit.record({
        action: 'project_requirements.create',
        entityType: 'project_requirements',
        entityId: row!.id,
        after: { projectRef: body.projectRef, revision, contentHash: row!.contentHash },
      });
      return view(row!);
    },
  );

  api.mutate(
    'patch',
    '/api/project-requirements/:id',
    {
      summary: 'Edit a DRAFT revision (a verified revision is immutable: create a new revision)',
      capability: 'design.write',
      params: idParam,
      body: patchBody,
    },
    async ({ auth, params, body, tx, audit }) => {
      const r = await load(tx, auth, params.id, true);
      if (r.status !== 'draft')
        throw new ApiError(
          409,
          'revision_immutable',
          'Only a draft can be edited; create a new revision',
        );
      const [row] = await tx
        .update(schema.projectRequirements)
        .set({ content: body.content, contentHash: contentHash(body.content) })
        .where(eq(schema.projectRequirements.id, r.id))
        .returning();
      await audit.record({
        action: 'project_requirements.update',
        entityType: 'project_requirements',
        entityId: r.id,
        before: { contentHash: r.contentHash },
        after: { contentHash: row!.contentHash },
      });
      return view(row!);
    },
  );

  api.mutate(
    'post',
    '/api/project-requirements/:id/verify',
    {
      summary:
        'Verify a draft (a second person, e-signed). Refused while limits of one requirement are stated on incompatible bases',
      capability: 'rules.verify',
      params: idParam,
      body: verifyBody,
    },
    async ({ auth, params, body, tx, audit }) => {
      const r = await load(tx, auth, params.id, true);
      if (r.status !== 'draft')
        throw new ApiError(409, 'conflict', `A ${r.status} revision cannot be verified`);
      assertNotAuthor(auth.user.id, r.createdBy);
      const content = r.content as ProjectRequirementsContent;
      const resolution = resolveGoverningLimits(content.governingLimits);
      if (resolution.incompatible.length > 0)
        throw new ApiError(
          409,
          'incompatible_limits',
          'Limits of the same requirement are stated on different units or test bases; they cannot be compared. Restate them on a common basis',
          { incompatible: resolution.incompatible },
        );
      const [u] = await tx
        .select({ name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.id, auth.user.id));
      const now = new Date();
      const verification = {
        signerId: auth.user.id,
        signerName: u?.name ?? auth.user.id,
        role: auth.role,
        meaning: 'requirements_verified',
        reason: body.reason,
        contentHash: r.contentHash,
        at: now.toISOString(),
      };
      // the revision this one replaces stops being the project's current requirements
      if (r.supersedesId) {
        await tx
          .update(schema.projectRequirements)
          .set({ status: 'superseded', supersededAt: now, supersededById: r.id })
          .where(
            and(
              eq(schema.projectRequirements.id, r.supersedesId),
              eq(schema.projectRequirements.status, 'verified'),
            ),
          );
      }
      const [row] = await tx
        .update(schema.projectRequirements)
        .set({ status: 'verified', verifiedBy: auth.user.id, verifiedAt: now, verification })
        .where(eq(schema.projectRequirements.id, r.id))
        .returning();
      await audit.record({
        action: 'project_requirements.verify',
        entityType: 'project_requirements',
        entityId: r.id,
        after: {
          projectRef: r.projectRef,
          revision: r.revision,
          contentHash: r.contentHash,
          supersedes: r.supersedesId,
        },
      });
      return view(row!);
    },
  );
}
