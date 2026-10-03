// The nightly backup (M6.2, ADR 0017): a consistent `pg_dump -Fc` (one exported snapshot, so the row counts in the
// manifest are exactly the counts inside the dump), a manifest, an upload, a re-read that proves the hash, a run record,
// and retention (30 days, never fewer than the 7 newest verified). The pg-boss schema is not dumped: queues rebuild.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schema, type Db } from '@khalta/db';
import { eq, sql } from 'drizzle-orm';
import type { BackupStore } from './store';

/** Tables whose row counts are checked on restore: the safety-critical records. Constants only (never user input). */
export const CRITICAL_TABLES = [
  'users',
  'plants',
  'rules',
  'materials',
  'material_tests',
  'material_prices',
  'mix_designs',
  'mix_design_lines',
  'design_evaluations',
  'design_transitions',
  'trial_batches',
  'strength_results',
  'batch_instances',
  'production_volumes',
  'savings_entries',
  'insights',
  'strength_models',
  'audit_log',
] as const;

export const MANIFEST_SCHEMA = 'khalta.backup.v1';
export interface Manifest {
  schema: typeof MANIFEST_SCHEMA;
  createdAt: string;
  env: string;
  appVersion: string | null;
  pgVersion: string;
  dumpKey: string;
  sha256: string;
  bytes: number;
  migrations: number;
  /** Row counts inside the dump's own snapshot. */
  counts: Record<string, number>;
  excludedSchemas: string[];
}

export const prefixFor = (env: string) => `khalta/${env}/`;
const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
export const dumpKeyFor = (env: string, at: Date, sha: string) =>
  `${prefixFor(env)}${at.getUTCFullYear()}/${String(at.getUTCMonth() + 1).padStart(2, '0')}/khalta-${stamp(at)}-${sha.slice(0, 8)}.dump`;
export const manifestKeyOf = (dumpKey: string) => dumpKey.replace(/\.dump$/, '.manifest.json');
/** `20261003T013000Z` embedded in the key. */
export function keyTime(key: string): Date | null {
  const m = /khalta-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(key);
  return m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)) : null;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

export function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0
        ? resolve({ out })
        : reject(new Error(`${cmd} exited ${code}: ${err.trim().slice(0, 800)}`)),
    );
  });
}

export interface RetentionPolicy {
  days: number;
  keep: number;
}
export const DEFAULT_RETENTION: RetentionPolicy = { days: 30, keep: 7 };

/**
 * Deletes verified backups older than `days`, but never leaves fewer than `keep` of the newest verified ones.
 * "Verified" = the dump has its manifest. A dump without a manifest older than one day is a failed upload: removed.
 */
export async function applyRetention(
  store: BackupStore,
  prefix: string,
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): Promise<number> {
  const objects = await store.list(prefix);
  const keys = new Set(objects.map((o) => o.key));
  const dumps = objects.filter((o) => o.key.endsWith('.dump'));
  const verified = dumps
    .filter((o) => keys.has(manifestKeyOf(o.key)))
    .map((o) => ({ key: o.key, at: keyTime(o.key) }))
    .filter((o): o is { key: string; at: Date } => o.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const cutoff = now.getTime() - policy.days * 86_400_000;
  const doomed: string[] = [];
  verified.slice(policy.keep).forEach((v) => {
    if (v.at.getTime() < cutoff) doomed.push(v.key, manifestKeyOf(v.key));
  });
  for (const o of dumps)
    if (!keys.has(manifestKeyOf(o.key)) && now.getTime() - o.lastModified.getTime() > 86_400_000)
      doomed.push(o.key);
  if (doomed.length) await store.delete(doomed);
  return doomed.filter((k) => k.endsWith('.dump')).length;
}

export interface RunOptions {
  db: Db;
  databaseUrl: string;
  store: BackupStore;
  env: string;
  appVersion?: string | null;
  now?: Date;
  retention?: RetentionPolicy;
  /** Test hook: replaces the dump command (to prove a failure is recorded). */
  pgDump?: string;
}

export interface RunResult {
  runId: string;
  manifest: Manifest;
  retentionDeleted: number;
}

export async function runBackup(o: RunOptions): Promise<RunResult> {
  const now = o.now ?? new Date();
  const [row] = await o.db
    .insert(schema.backupRuns)
    .values({
      storage: o.store.kind,
      startedAt: now,
      status: 'running',
      appVersion: o.appVersion ?? null,
    })
    .returning({ id: schema.backupRuns.id });
  const runId = row!.id;
  const dir = await mkdtemp(join(tmpdir(), 'khalta-backup-'));
  const file = join(dir, 'dump');
  try {
    let pgVersion = '';
    let migrations = 0;
    const counts: Record<string, number> = {};
    // one REPEATABLE READ transaction exports a snapshot; pg_dump reads the same snapshot, the counts too
    await o.db.transaction(
      async (tx) => {
        const snap = (await tx.execute(sql`select pg_export_snapshot() as snap`)).rows[0] as {
          snap: string;
        };
        pgVersion = (
          (await tx.execute(sql`show server_version`)).rows[0] as { server_version: string }
        ).server_version;
        migrations = Number(
          (
            (await tx.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`))
              .rows[0] as { n: number }
          ).n,
        );
        for (const t of CRITICAL_TABLES)
          counts[t] = Number(
            (
              (await tx.execute(sql.raw(`select count(*)::int as n from "${t}"`))).rows[0] as {
                n: number;
              }
            ).n,
          );
        await run(o.pgDump ?? 'pg_dump', [
          '--format=custom',
          '--no-owner',
          '--no-privileges',
          '--exclude-schema=pgboss',
          `--snapshot=${snap.snap}`,
          `--file=${file}`,
          `--dbname=${o.databaseUrl}`,
        ]);
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    const sha = await sha256File(file);
    const bytes = (await stat(file)).size;
    const dumpKey = dumpKeyFor(o.env, now, sha);
    const manifest: Manifest = {
      schema: MANIFEST_SCHEMA,
      createdAt: now.toISOString(),
      env: o.env,
      appVersion: o.appVersion ?? null,
      pgVersion,
      dumpKey,
      sha256: sha,
      bytes,
      migrations,
      counts,
      excludedSchemas: ['pgboss'],
    };
    await o.store.putFile(dumpKey, file);
    // prove what is stored is what was dumped, before the manifest makes it count as a backup
    const back = join(dir, 'verify');
    await o.store.getFile(dumpKey, back);
    if ((await sha256File(back)) !== sha) throw new Error('uploaded dump does not match its hash');
    await o.store.putText(manifestKeyOf(dumpKey), JSON.stringify(manifest, null, 2) + '\n');
    const retentionDeleted = await applyRetention(o.store, prefixFor(o.env), now, o.retention);
    await o.db
      .update(schema.backupRuns)
      .set({
        status: 'ok',
        finishedAt: new Date(),
        objectKey: dumpKey,
        manifestKey: manifestKeyOf(dumpKey),
        bytes,
        sha256: sha,
        pgVersion,
        migrationCount: migrations,
        retentionDeleted,
      })
      .where(eq(schema.backupRuns.id, runId));
    return { runId, manifest, retentionDeleted };
  } catch (e) {
    await o.db
      .update(schema.backupRuns)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        error: String((e as Error).message ?? e).slice(0, 1000),
      })
      .where(eq(schema.backupRuns.id, runId));
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
