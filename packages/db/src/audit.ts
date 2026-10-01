import { auditLog } from './schema';
import type { Db, Tx } from './client';

export interface Actor {
  id: string;
  role: string;
}

export interface RequestContext {
  tenantId: string;
  actor: Actor | null; // null = system action (bootstrap, jobs)
  requestId: string;
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

export interface AuditRecorder {
  record(entry: AuditEntry): Promise<void>;
}

export class AuditMissingError extends Error {
  constructor() {
    super('mutation committed no audit entry; transaction rolled back');
    this.name = 'AuditMissingError';
  }
}

/**
 * Runs `fn` in a single transaction together with its audit rows. If `fn` throws, both the change
 * and its audit rows roll back. A mutation that records no audit entry is rejected, so a route
 * cannot forget auditing.
 */
export async function withAudit<T>(
  db: Db,
  ctx: RequestContext,
  fn: (tx: Tx, audit: AuditRecorder) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    let count = 0;
    const audit: AuditRecorder = {
      async record(entry) {
        count += 1;
        await tx.insert(auditLog).values({
          tenantId: ctx.tenantId,
          actorId: ctx.actor?.id ?? null,
          actorRole: ctx.actor?.role ?? null,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          before: entry.before ?? null,
          after: entry.after ?? null,
          requestId: ctx.requestId,
        });
      },
    };
    const result = await fn(tx, audit);
    if (count === 0) throw new AuditMissingError();
    return result;
  });
}
