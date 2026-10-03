// The worker's `backup` job: take the backup, record it in the audit log of every tenant, and never hide a failure.
import { schema, withAudit, type Db } from '@khalta/db';
import { loadBackupEnv, storeFrom, type BackupEnv } from './config';
import { runBackup } from './run';

export async function backupJob(db: Db, env: BackupEnv = loadBackupEnv(), now = new Date()) {
  if (env.BACKUP_ENABLED === '0') return { skipped: 'disabled' as const };
  const store = storeFrom(env);
  const tenants = await db.select({ id: schema.tenants.id }).from(schema.tenants);
  const audit = async (after: Record<string, unknown>) => {
    for (const t of tenants)
      await withAudit(
        db,
        { tenantId: t.id, actor: null, requestId: 'job:backup' },
        async (_tx, a) => {
          await a.record({
            action: 'backup.run',
            entityType: 'backup',
            entityId: String(after['key'] ?? 'none'),
            after,
          });
        },
      );
  };
  if (!store) {
    await db.insert(schema.backupRuns).values({
      storage: 'none',
      status: 'failed',
      startedAt: now,
      finishedAt: now,
      error: 'no backup storage is configured (BACKUP_BUCKET_* or BACKUP_DIR)',
    });
    await audit({ status: 'failed', error: 'no backup storage is configured' });
    return { skipped: 'no_storage' as const };
  }
  try {
    const r = await runBackup({
      db,
      databaseUrl: env.DATABASE_URL,
      store,
      env: env.BACKUP_ENV,
      appVersion: env.APP_VERSION ?? null,
      now,
    });
    await audit({
      status: 'ok',
      key: r.manifest.dumpKey,
      sha256: r.manifest.sha256,
      bytes: r.manifest.bytes,
      retentionDeleted: r.retentionDeleted,
    });
    return { ok: true as const, key: r.manifest.dumpKey };
  } catch (e) {
    await audit({ status: 'failed', error: (e as Error).message.slice(0, 500) });
    throw e; // pg-boss retries; the run row already says failed
  }
}
