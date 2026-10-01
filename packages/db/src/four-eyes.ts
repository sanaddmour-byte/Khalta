import { assertNotAuthor } from '@khalta/rbac';
import { eq } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Tx } from './client';

/**
 * Four-eyes check against the PERSISTED author, read (and row-locked) inside the caller's
 * transaction so the author cannot change between check and transition. Throws FourEyesViolation
 * if the actor authored the record or the author is unknown.
 */
export async function assertFourEyes(
  tx: Tx,
  target: { table: PgTable; id: PgColumn; createdBy: PgColumn },
  recordId: string,
  actorId: string,
): Promise<void> {
  const rows = await tx
    .select({ author: target.createdBy })
    .from(target.table)
    .where(eq(target.id, recordId))
    .for('update');
  if (rows.length === 0) throw new Error(`record ${recordId} not found`);
  assertNotAuthor(actorId, rows[0]?.author as string | null);
}
