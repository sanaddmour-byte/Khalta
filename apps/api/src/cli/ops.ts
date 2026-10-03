// `node dist/cli.js <command>`: backup now, list backups, restore into a new database, verify a restore (M6.2).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@khalta/db';
import { loadBackupEnv, storeFrom } from '../backup/config';
import {
  fetchBackup,
  listBackups,
  restoreDump,
  verifyRestored,
  dbNameOf,
  type BackupEntry,
} from '../backup/restore';
import { prefixFor, runBackup } from '../backup/run';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => {
  const i = rest.indexOf(`--${n}`);
  return i >= 0
    ? rest[i + 1] && !rest[i + 1]!.startsWith('--')
      ? rest[i + 1]!
      : 'true'
    : undefined;
};
const usage = `usage: node dist/cli.js <command>
  backup                                     take a backup now (needs DATABASE_URL and a bucket or BACKUP_DIR)
  list                                       list verified backups, newest first
  restore --target <url> [--from <key|latest>] [--replace]
                                             restore into a NEW database; refuses the live one
          [--allow-live --confirm <dbname>]  (only for a deliberate restore over the live database)
  verify  --target <url> [--from <key|latest>]
                                             compare a restored database with the manifest`;

const env = loadBackupEnv();
const store = storeFrom(env);
if (!store) {
  console.error('no backup storage configured (set the BACKUP_BUCKET_* variables or BACKUP_DIR)');
  process.exit(2);
}
const pick = async (): Promise<BackupEntry> => {
  const all = await listBackups(store, env.BACKUP_ENV);
  const from = flag('from') ?? 'latest';
  const e =
    from === 'latest' ? all[0] : all.find((x) => x.dumpKey === from || x.dumpKey.endsWith(from));
  if (!e) throw new Error(`no such verified backup under ${prefixFor(env.BACKUP_ENV)}: ${from}`);
  return e;
};

try {
  if (cmd === 'backup') {
    const handle = createDb(env.DATABASE_URL);
    try {
      const r = await runBackup({
        db: handle.db,
        databaseUrl: env.DATABASE_URL,
        store,
        env: env.BACKUP_ENV,
        appVersion: env.APP_VERSION ?? null,
      });
      console.log(
        JSON.stringify({
          ok: true,
          key: r.manifest.dumpKey,
          sha256: r.manifest.sha256,
          bytes: r.manifest.bytes,
          retentionDeleted: r.retentionDeleted,
        }),
      );
    } finally {
      await handle.close();
    }
  } else if (cmd === 'list') {
    for (const b of await listBackups(store, env.BACKUP_ENV))
      console.log(
        `${b.manifest.createdAt}  ${b.manifest.bytes}  ${b.manifest.sha256.slice(0, 12)}  ${b.dumpKey}`,
      );
  } else if (cmd === 'restore' || cmd === 'verify') {
    const target = flag('target');
    if (!target) throw new Error('--target <database url> is required');
    const entry = await pick();
    const dir = await mkdtemp(join(tmpdir(), 'khalta-restore-'));
    try {
      if (cmd === 'restore') {
        const t0 = Date.now();
        const file = await fetchBackup(store, entry, dir);
        const t1 = Date.now();
        await restoreDump({
          dumpFile: file,
          targetUrl: target,
          liveUrl: env.DATABASE_URL,
          ...(flag('replace') ? { replace: true } : {}),
          ...(flag('allow-live') ? { allowLive: true } : {}),
          ...(flag('confirm') ? { confirm: flag('confirm')! } : {}),
        });
        const t2 = Date.now();
        console.log(
          `restored ${entry.dumpKey} into ${dbNameOf(target)} (fetch ${t1 - t0} ms, restore ${t2 - t1} ms)`,
        );
      }
      const report = await verifyRestored(target, entry.manifest);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
