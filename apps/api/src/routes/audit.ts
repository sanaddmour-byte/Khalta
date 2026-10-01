import { schema } from '@khalta/db';
import { and, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { ApiRoutes } from '../route';

const query = z.object({
  entityType: z.string().max(100).optional(),
  entityId: z.string().max(100).optional(),
  before: z.coerce.number().int().positive().optional(), // cursor: audit id
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function auditRoutes(api: ApiRoutes) {
  api.get(
    '/api/audit',
    { summary: 'Read the audit log', capability: 'audit.read', query },
    async ({ auth, query: q, db }) => {
      const where = [eq(schema.auditLog.tenantId, auth.tenantId)];
      if (q.entityType) where.push(eq(schema.auditLog.entityType, q.entityType));
      if (q.entityId) where.push(eq(schema.auditLog.entityId, q.entityId));
      if (q.before) where.push(lt(schema.auditLog.id, q.before));
      return db
        .select()
        .from(schema.auditLog)
        .where(and(...where))
        .orderBy(desc(schema.auditLog.id))
        .limit(q.limit);
    },
  );
}
