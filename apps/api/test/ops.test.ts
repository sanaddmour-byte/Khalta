import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createDb, expectedMigrations, schema } from '@khalta/db';
import express from 'express';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { backupJob } from '../src/backup/job';
import { loadBackupEnv, storeFrom } from '../src/backup/config';
import {
  dbNameOf,
  fetchBackup,
  listBackups,
  psql,
  restoreDump,
  verifyRestored,
} from '../src/backup/restore';
import {
  applyRetention,
  CRITICAL_TABLES,
  dumpKeyFor,
  manifestKeyOf,
  prefixFor,
  runBackup,
  sha256File,
} from '../src/backup/run';
import { DirStore } from '../src/backup/store';
import { buildCsp, readyHandler, securityHeaders } from '../src/ops';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
let dir: string;
let store: DirStore;
const ENV = 'test';

beforeAll(async () => {
  env = await createTestEnv();
  dir = await mkdtemp(join(tmpdir(), 'khalta-ops-'));
  store = new DirStore(join(dir, 'bucket'));
  await env.seedPlant('OPS-A');
  await env.seedUser('qc_manager');
}, 120_000);
afterAll(async () => {
  await env.close();
  await rm(dir, { recursive: true, force: true });
});

const as = async (role: Parameters<TestEnv['seedUser']>[0]) =>
  env.login((await env.seedUser(role)).email);
const urlFor = (name: string) => {
  const u = new URL(env.config.DATABASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
};
const dropDb = (name: string) =>
  psql(urlFor('postgres'), `drop database if exists "${name}" with (force)`);

describe('readiness and headers', () => {
  it('/health is liveness; /ready asks the database and the migration state', async () => {
    const app = env.app;
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' });
    const r = await request(app).get('/ready');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      status: 'ready',
      database: 'ok',
      migrations: { applied: expectedMigrations(), expected: expectedMigrations() },
    });
    expect(r.body.backup.state).toBe('none');
    expect(JSON.stringify(r.body)).not.toMatch(/password|secret|postgres:\/\//i);
  });
  it('/ready reports worker liveness (information only): never, live, then stale; the API stays ready throughout', async () => {
    const { startHeartbeat, workerState } = await import('../src/ops');
    const { schema } = await import('@khalta/db');
    expect((await request(env.app).get('/ready')).body.worker).toMatchObject({ state: 'never' });
    const stop = startHeartbeat(env.db, 'test-1', 60_000);
    await new Promise((r) => setTimeout(r, 300));
    const live = (await request(env.app).get('/ready')).body;
    expect(live.status).toBe('ready');
    expect(live.worker).toMatchObject({ state: 'live', version: 'test-1' });
    stop();
    // two minutes later with no beat, the worker is stale but the API still serves
    expect((await workerState(env.db, new Date(Date.now() + 5 * 60_000))).state).toBe('stale');
    await env.db.delete(schema.workerHeartbeats);
  });
  it('/ready is 503 when a migration is missing or the database is unreachable, and backups never take it down', async () => {
    const mk = (db: typeof env.db, expected?: number) => {
      const a = express();
      a.get('/ready', readyHandler(db, env.config, expected));
      return a;
    };
    const late = await request(mk(env.db, expectedMigrations() + 1)).get('/ready');
    expect(late.status).toBe(503);
    expect(late.body.status).toBe('not_ready');
    const dead = createDb('postgres://postgres@127.0.0.1:1/none', () => {});
    try {
      const r = await request(mk(dead.db)).get('/ready');
      expect(r.status).toBe(503);
      expect(r.body.database).toBe('unreachable');
    } finally {
      await dead.close().catch(() => {});
    }
    // a stale backup is information, not an outage
    await env.db.insert(schema.backupRuns).values({
      storage: 'dir',
      status: 'ok',
      startedAt: new Date(Date.now() - 40 * 3_600_000),
      finishedAt: new Date(Date.now() - 40 * 3_600_000),
      objectKey: 'k',
      manifestKey: 'm',
      sha256: 'h',
      bytes: 1,
    });
    const stale = await request(env.app).get('/ready');
    expect(stale.status).toBe(200);
    expect(stale.body.backup.state).toBe('stale');
    await env.db.insert(schema.backupRuns).values({
      storage: 'dir',
      status: 'ok',
      startedAt: new Date(),
      finishedAt: new Date(),
      objectKey: 'k2',
      manifestKey: 'm2',
      sha256: 'h2',
      bytes: 1,
    });
    expect((await request(env.app).get('/ready')).body.backup.state).toBe('ok');
  });
  it('security headers on every response; HSTS only in production', async () => {
    const res = await request(env.app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['strict-transport-security']).toBeUndefined();
    const a = express();
    a.use(securityHeaders({ DEPLOY_ENV: 'production' }));
    a.get('/x', (_q, s) => void s.send('ok'));
    expect((await request(a).get('/x')).headers['strict-transport-security']).toContain(
      'max-age=31536000',
    );
  });
  it('the served app gets a CSP with no unsafe-inline script: the one inline script is allowed by its hash', async () => {
    const web = join(dir, 'web');
    const script = "document.documentElement.dataset.theme='light';";
    await rm(web, { recursive: true, force: true });
    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(join(web, 'assets'), { recursive: true });
      await fs.writeFile(
        join(web, 'index.html'),
        `<!doctype html><html><head><script>${script}</script></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`,
      );
      await fs.writeFile(join(web, 'assets', 'app.js'), 'console.log(1)');
    });
    const app = createApp({ config: { ...env.config, WEB_DIST_DIR: web }, db: env.db });
    const index = await request(app).get('/');
    const csp = index.headers['content-security-policy']!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp.match(/script-src[^;]*/)![0]).not.toContain('unsafe-inline');
    expect(csp).toBe(buildCsp(await readFile(join(web, 'index.html'), 'utf8')));
    expect((await request(app).get('/library')).headers['content-security-policy']).toBe(csp);
    expect((await request(app).get('/assets/app.js')).headers['x-content-type-options']).toBe(
      'nosniff',
    );
    expect((await request(app).get('/api/me')).status).toBe(401);
  });
});

describe('backup: a consistent dump with a manifest, verified after upload', () => {
  it('writes the dump and its manifest; counts are the dump’s own; the run is recorded', async () => {
    const now = new Date('2026-10-03T01:30:00Z');
    const r = await runBackup({
      db: env.db,
      databaseUrl: env.config.DATABASE_URL,
      store,
      env: ENV,
      appVersion: 'test-1',
      now,
    });
    const m = r.manifest;
    expect(m).toMatchObject({
      schema: 'khalta.backup.v1',
      env: ENV,
      appVersion: 'test-1',
      excludedSchemas: ['pgboss'],
    });
    expect(m.migrations).toBe(expectedMigrations());
    for (const t of CRITICAL_TABLES) {
      const [row] = (await env.db.execute(sql.raw(`select count(*)::int as n from "${t}"`)))
        .rows as { n: number }[];
      expect(m.counts[t], t).toBe(row!.n);
    }
    expect(m.counts['users']).toBeGreaterThan(0);
    expect(m.dumpKey).toBe(dumpKeyFor(ENV, now, m.sha256));
    const stored = join(dir, 'bucket', m.dumpKey);
    expect(await sha256File(stored)).toBe(m.sha256);
    expect(JSON.parse(await store.getText(manifestKeyOf(m.dumpKey)))).toEqual(m);
    const [run] = await env.db
      .select()
      .from(schema.backupRuns)
      .where(eq(schema.backupRuns.id, r.runId));
    expect(run).toMatchObject({
      status: 'ok',
      storage: 'dir',
      objectKey: m.dumpKey,
      sha256: m.sha256,
      bytes: m.bytes,
      migrationCount: m.migrations,
    });
    expect(run!.finishedAt).not.toBeNull();
    expect((await listBackups(store, ENV)).map((b) => b.dumpKey)).toContain(m.dumpKey);
  });

  it('a failed dump is recorded with its error and leaves nothing in the bucket', async () => {
    const before = (await store.list(prefixFor(ENV))).length;
    await expect(
      runBackup({
        db: env.db,
        databaseUrl: env.config.DATABASE_URL,
        store,
        env: ENV,
        pgDump: 'false',
        now: new Date('2026-10-04T01:30:00Z'),
      }),
    ).rejects.toThrow();
    const failed = (
      await env.db.select().from(schema.backupRuns).where(eq(schema.backupRuns.status, 'failed'))
    ).at(-1)!;
    expect(failed.error).toMatch(/exited 1/);
    expect(failed.finishedAt).not.toBeNull();
    expect((await store.list(prefixFor(ENV))).length).toBe(before);
  });

  it('the job audits its outcome, and records a visible failure when no storage is configured', async () => {
    const cfg = (over: Record<string, string>) =>
      loadBackupEnv({ DATABASE_URL: env.config.DATABASE_URL, ...over });
    expect(await backupJob(env.db, cfg({ BACKUP_ENABLED: '0' }))).toEqual({ skipped: 'disabled' });
    expect(await backupJob(env.db, cfg({}))).toEqual({ skipped: 'no_storage' });
    const none = (
      await env.db.select().from(schema.backupRuns).where(eq(schema.backupRuns.storage, 'none'))
    ).at(-1)!;
    expect(none).toMatchObject({ status: 'failed' });
    expect(none.error).toMatch(/no backup storage/);
    const ok = await backupJob(
      env.db,
      cfg({ BACKUP_DIR: join(dir, 'bucket2'), BACKUP_ENV: 'job' }),
      new Date('2026-10-05T01:30:00Z'),
    );
    expect(ok).toMatchObject({ ok: true });
    const audits = await env.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'backup.run'));
    expect(audits.map((a) => (a.after as { status: string }).status).sort()).toEqual([
      'failed',
      'ok',
    ]);
    expect(storeFrom(cfg({ BACKUP_DIR: dir }))?.kind).toBe('dir');
    expect(storeFrom(cfg({}))).toBeNull();
    expect(
      storeFrom(
        cfg({
          BACKUP_BUCKET_NAME: 'b',
          BACKUP_BUCKET_ENDPOINT: 'https://s3.example.org',
          BACKUP_BUCKET_ACCESS_KEY_ID: 'k',
          BACKUP_BUCKET_SECRET_ACCESS_KEY: 's',
        }),
      )?.kind,
    ).toBe('s3');
  });

  it('admins see the runs and the freshness; no one else, and no credentials appear', async () => {
    expect((await (await as('qc_manager')).get('/api/system/backups')).status).toBe(403);
    expect((await (await as('sales')).get('/api/system/backups')).status).toBe(403);
    const res = await (await as('admin')).get('/api/system/backups');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('ok');
    expect(res.body.runs.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(res.body)).not.toMatch(/secret|password|access_key/i);
  });
});

describe('retention: 30 days, never fewer than the 7 newest verified', () => {
  const day = 86_400_000;
  const now = new Date('2026-11-01T02:00:00Z');
  const put = async (s: DirStore, ageDays: number, withManifest = true, mtimeAgeDays = ageDays) => {
    const at = new Date(now.getTime() - ageDays * day);
    const key = dumpKeyFor('ret', at, 'a'.repeat(64));
    await s.putText(key, 'dump');
    if (withManifest) await s.putText(manifestKeyOf(key), '{}');
    const when = new Date(now.getTime() - mtimeAgeDays * day);
    await utimes(join((s as unknown as { root: string }).root, key), when, when);
    return key;
  };
  it('deletes only verified backups older than 30 days beyond the newest seven', async () => {
    const s = new DirStore(join(dir, 'ret1'));
    const ages = [1, 2, 3, 4, 5, 32, 34, 36, 38, 40];
    const keys = new Map<number, string>();
    for (const a of ages) keys.set(a, await put(s, a));
    expect(await applyRetention(s, prefixFor('ret'), now)).toBe(3);
    const left = (await s.list(prefixFor('ret'))).map((o) => o.key);
    for (const a of [1, 2, 3, 4, 5, 32, 34]) {
      expect(left).toContain(keys.get(a));
      expect(left).toContain(manifestKeyOf(keys.get(a)!));
    }
    for (const a of [36, 38, 40]) {
      expect(left).not.toContain(keys.get(a));
      expect(left).not.toContain(manifestKeyOf(keys.get(a)!));
    }
  });
  it('never leaves fewer than seven: three ancient backups all stay', async () => {
    const s = new DirStore(join(dir, 'ret2'));
    for (const a of [60, 70, 80]) await put(s, a);
    expect(await applyRetention(s, prefixFor('ret'), now)).toBe(0);
    expect((await s.list(prefixFor('ret'))).length).toBe(6);
  });
  it('removes a dump with no manifest only once it is a day old (a failed upload), and keeps fresh ones', async () => {
    const s = new DirStore(join(dir, 'ret3'));
    const old = await put(s, 3, false, 3);
    const fresh = await put(s, 0, false, 0);
    expect(await applyRetention(s, prefixFor('ret'), now)).toBe(1);
    const left = (await s.list(prefixFor('ret'))).map((o) => o.key);
    expect(left).toContain(fresh);
    expect(left).not.toContain(old);
  });
  it('the store refuses keys that could leave its root', async () => {
    const s = new DirStore(join(dir, 'ret4'));
    for (const bad of ['../x', '/abs', 'a/../../b', 'a b', 'a\\b'])
      await expect(s.putText(bad, 'x')).rejects.toThrow(/unsafe/);
  });
});

describe('restore: into a new database, verified against the manifest', () => {
  const name = `khalta_restore_${randomBytes(4).toString('hex')}`;
  afterAll(() => dropDb(name));

  it('round trip: dump → restore → every critical count and the migrations match → the API starts on it', async () => {
    const [entry] = await listBackups(store, ENV);
    const file = await fetchBackup(store, entry!, join(dir, 'fetch'));
    await restoreDump({
      dumpFile: file,
      targetUrl: urlFor(name),
      liveUrl: env.config.DATABASE_URL,
    });
    const report = await verifyRestored(urlFor(name), entry!.manifest);
    expect(report).toMatchObject({ ok: true, mismatches: [] });
    expect(report.migrations.restored).toBe(entry!.manifest.migrations);
    expect(report.counts['users']).toBe(entry!.manifest.counts['users']);
    // the application boots on the restored copy and answers
    const handle = createDb(urlFor(name));
    try {
      const app = createApp({
        config: { ...env.config, DATABASE_URL: urlFor(name) },
        db: handle.db,
      });
      const ready = await request(app).get('/ready');
      expect(ready.status).toBe(200);
      expect(ready.body.status).toBe('ready');
    } finally {
      await handle.close();
    }
  }, 120_000);

  it('a restore that differs from the manifest is reported, table by table', async () => {
    const [entry] = await listBackups(store, ENV);
    await psql(urlFor(name), 'alter table audit_log disable trigger all');
    await psql(
      urlFor(name),
      "insert into plants (tenant_id, code, name_en, name_ar) select tenant_id, 'EXTRA-' || substr(md5(random()::text), 1, 4), 'x', 'x' from plants limit 1",
    );
    const report = await verifyRestored(urlFor(name), entry!.manifest);
    expect(report.ok).toBe(false);
    expect(report.mismatches.map((m) => m.table)).toContain('plants');
  });

  it('refuses the live database, an existing target without --replace, and a wrong confirmation', async () => {
    const [entry] = await listBackups(store, ENV);
    const file = await fetchBackup(store, entry!, join(dir, 'fetch2'));
    const live = env.config.DATABASE_URL;
    await expect(restoreDump({ dumpFile: file, targetUrl: live, liveUrl: live })).rejects.toThrow(
      /refusing to restore over the live database/,
    );
    await expect(
      restoreDump({
        dumpFile: file,
        targetUrl: live,
        liveUrl: live,
        allowLive: true,
        confirm: 'nope',
      }),
    ).rejects.toThrow(/refusing/);
    await expect(
      restoreDump({ dumpFile: file, targetUrl: urlFor(name), liveUrl: live }),
    ).rejects.toThrow(/already exists/);
    await restoreDump({ dumpFile: file, targetUrl: urlFor(name), liveUrl: live, replace: true });
    expect((await verifyRestored(urlFor(name), entry!.manifest)).ok).toBe(true);
    expect(() => dbNameOf('postgres://x/a-b;drop')).toThrow();
  }, 120_000);

  it('a corrupt or tampered dump is refused before any restore', async () => {
    const [entry] = await listBackups(store, ENV);
    const path = join(dir, 'bucket', entry!.dumpKey);
    const orig = await readFile(path);
    await writeFile(path, Buffer.concat([orig, Buffer.from('tamper')]));
    await expect(fetchBackup(store, entry!, join(dir, 'fetch3'))).rejects.toThrow(/corrupt/);
    await writeFile(path, orig);
    await expect(fetchBackup(store, entry!, join(dir, 'fetch4'))).resolves.toBeTruthy();
  });

  it('a dump without a manifest is not a backup', async () => {
    const s = new DirStore(join(dir, 'bucket3'));
    await s.putText(dumpKeyFor('x', new Date(), 'b'.repeat(64)), 'dump');
    expect(await listBackups(s, 'x')).toEqual([]);
  });
});
