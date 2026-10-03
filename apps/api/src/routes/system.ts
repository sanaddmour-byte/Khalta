// Operations visibility for admins (M6.2): the recent backup runs and their freshness. No storage credentials, no keys
// outside the bucket prefix, no data from the backups themselves.
import { schema } from '@khalta/db';
import { desc } from 'drizzle-orm';
import { backupState } from '../ops';
import type { ApiRoutes } from '../route';

export function systemRoutes(api: ApiRoutes, backupsEnabled: boolean) {
  api.get(
    '/api/system/backups',
    {
      summary: 'Recent backup runs and whether the last good one is fresh (admin)',
      capability: 'org.manage',
    },
    async ({ db }) => {
      const runs = await db
        .select({
          id: schema.backupRuns.id,
          startedAt: schema.backupRuns.startedAt,
          finishedAt: schema.backupRuns.finishedAt,
          status: schema.backupRuns.status,
          storage: schema.backupRuns.storage,
          objectKey: schema.backupRuns.objectKey,
          bytes: schema.backupRuns.bytes,
          sha256: schema.backupRuns.sha256,
          migrationCount: schema.backupRuns.migrationCount,
          retentionDeleted: schema.backupRuns.retentionDeleted,
          error: schema.backupRuns.error,
        })
        .from(schema.backupRuns)
        .orderBy(desc(schema.backupRuns.startedAt))
        .limit(30);
      return { ...(await backupState(db, backupsEnabled)), runs };
    },
  );
}
