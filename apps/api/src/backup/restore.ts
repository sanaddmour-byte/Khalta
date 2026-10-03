// Restore and verification (M6.2). The tool NEVER restores over the live database: the target is a named database
// that does not exist yet (or is explicitly replaced), and the live URL needs a flag AND the typed database name.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CRITICAL_TABLES,
  MANIFEST_SCHEMA,
  manifestKeyOf,
  prefixFor,
  run,
  sha256File,
  type Manifest,
} from './run';
import type { BackupStore } from './store';

export interface BackupEntry {
  dumpKey: string;
  manifest: Manifest;
}

/** Verified backups (dump + readable manifest), newest first. */
export async function listBackups(store: BackupStore, env: string): Promise<BackupEntry[]> {
  const objects = await store.list(prefixFor(env));
  const out: BackupEntry[] = [];
  for (const o of objects.filter((x) => x.key.endsWith('.manifest.json'))) {
    try {
      const m = JSON.parse(await store.getText(o.key)) as Manifest;
      if (m.schema === MANIFEST_SCHEMA && objects.some((x) => x.key === m.dumpKey))
        out.push({ dumpKey: m.dumpKey, manifest: m });
    } catch {
      /* an unreadable manifest is not a verified backup */
    }
  }
  return out.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
}

/** Downloads a backup and checks its SHA-256 against the manifest; throws on any difference. */
export async function fetchBackup(
  store: BackupStore,
  entry: BackupEntry,
  dir: string,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'restore.dump');
  await store.getFile(entry.dumpKey, file);
  const sha = await sha256File(file);
  if (sha !== entry.manifest.sha256)
    throw new Error(
      `backup ${entry.dumpKey} is corrupt: hash ${sha} differs from its manifest ${entry.manifest.sha256}`,
    );
  return file;
}

const NAME = /^[A-Za-z0-9_]+$/;
export function dbNameOf(url: string): string {
  const n = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!NAME.test(n)) throw new Error(`unsupported database name in URL: ${n}`);
  return n;
}
const withDb = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};
const sameServer = (a: string, b: string) => {
  const x = new URL(a);
  const y = new URL(b);
  return x.host === y.host;
};

export async function psql(url: string, query: string): Promise<string> {
  return (
    await run('psql', ['--no-psqlrc', '-At', '-v', 'ON_ERROR_STOP=1', '-d', url, '-c', query])
  ).out.trim();
}

export interface RestoreOptions {
  dumpFile: string;
  targetUrl: string;
  /** The live database URL (to refuse restoring over it). */
  liveUrl?: string;
  /** Drop and recreate the target if it exists. */
  replace?: boolean;
  /** Both needed to restore INTO the live database. */
  allowLive?: boolean;
  confirm?: string;
}

export async function restoreDump(o: RestoreOptions): Promise<{ database: string }> {
  const name = dbNameOf(o.targetUrl);
  const live = o.liveUrl ? dbNameOf(o.liveUrl) : null;
  const isLive = !!o.liveUrl && sameServer(o.liveUrl, o.targetUrl) && live === name;
  if (isLive && !(o.allowLive && o.confirm === name))
    throw new Error(
      `refusing to restore over the live database "${name}": restore into a new database and swap, or pass --allow-live with --confirm ${name}`,
    );
  const admin = withDb(o.targetUrl, 'postgres');
  const exists = (await psql(admin, `select 1 from pg_database where datname = '${name}'`)) === '1';
  if (exists) {
    if (!o.replace && !isLive)
      throw new Error(`database "${name}" already exists; choose another name or pass --replace`);
    await psql(admin, `drop database "${name}" with (force)`);
  }
  await psql(admin, `create database "${name}"`);
  await run('pg_restore', [
    '--no-owner',
    '--no-privileges',
    '--exit-on-error',
    `--dbname=${o.targetUrl}`,
    o.dumpFile,
  ]);
  return { database: name };
}

export interface VerifyReport {
  ok: boolean;
  migrations: { restored: number; manifest: number };
  mismatches: { table: string; restored: number | null; manifest: number }[];
  counts: Record<string, number>;
}

/** The restored database must match the manifest exactly: the migration count and every critical table's rows. */
export async function verifyRestored(targetUrl: string, manifest: Manifest): Promise<VerifyReport> {
  const restoredMigrations = Number(
    await psql(targetUrl, 'select count(*) from drizzle.__drizzle_migrations'),
  );
  const counts: Record<string, number> = {};
  const mismatches: VerifyReport['mismatches'] = [];
  for (const t of CRITICAL_TABLES) {
    const n = await psql(targetUrl, `select count(*) from "${t}"`)
      .then((v) => Number(v))
      .catch(() => null);
    if (n !== null) counts[t] = n;
    if (n !== manifest.counts[t])
      mismatches.push({ table: t, restored: n, manifest: manifest.counts[t] ?? -1 });
  }
  return {
    ok: mismatches.length === 0 && restoredMigrations === manifest.migrations,
    migrations: { restored: restoredMigrations, manifest: manifest.migrations },
    mismatches,
    counts,
  };
}

export { manifestKeyOf };
