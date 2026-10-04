// The restore drill (M6.2): data → backup → restore into a NEW database → verify against the manifest → boot the
// application on the restored copy → smoke test and compare what the API reports. Prints a JSON report with timings.
//   node scripts/restore-drill.mjs --bundle <deployed bundle dir> --admin-url <postgres admin url> --web <web dist>
// The bundle dir holds dist/, migrations/, seeds/, node_modules/ (see docs/runbooks/production.md, "Build").
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const bundle = resolve(arg('bundle') ?? '');
const adminUrl = arg('admin-url') ?? process.env.TEST_DATABASE_URL;
const web = resolve(arg('web') ?? 'apps/web/dist');
if (!arg('bundle') || !adminUrl) {
  console.error('usage: restore-drill --bundle <dir> --admin-url <url> [--web <dir>]');
  process.exit(2);
}
const withDb = (name) => {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.toString();
};
const id = randomBytes(3).toString('hex');
const srcDb = `khalta_drill_src_${id}`;
const dstDb = `khalta_drill_restored_${id}`;
const work = mkdtempSync(join(tmpdir(), 'khalta-drill-'));
const bucket = join(work, 'bucket');
const secret = randomBytes(36).toString('base64');
const adminEmail = 'drill-admin@khalta.test';
const adminPassword = randomBytes(9).toString('base64url') + 'Aa1';
const t = {};
const timed = async (name, fn) => {
  const t0 = performance.now();
  const r = await fn();
  t[name] = Math.round(performance.now() - t0);
  return r;
};
const sh = (cmd, args, env = {}, cwd = bundle) => {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout).slice(-1500)}`);
  return r.stdout;
};
const psql = (db, q) => sh('psql', ['--no-psqlrc', '-At', '-d', withDb(db), '-c', q]).trim();

const baseEnv = (db, port) => ({
  NODE_ENV: 'production',
  DEPLOY_ENV: 'staging',
  DATABASE_URL: withDb(db),
  BETTER_AUTH_SECRET: secret,
  BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
  APP_BASE_URL: `http://127.0.0.1:${port}`,
  WEB_DIST_DIR: web,
  PORT: String(port),
  LOG_LEVEL: 'warn',
  KHALTA_DEMO: '1',
  TRUST_PROXY: '1',
  BACKUP_DIR: bucket,
  BACKUP_ENV: 'drill',
  APP_VERSION: 'restore-drill',
  BOOTSTRAP_ADMIN_EMAIL: adminEmail,
  BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
});

async function startServer(db, port) {
  const p = spawn('node', ['dist/server.js'], {
    cwd: bundle,
    env: { ...process.env, ...baseEnv(db, port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  p.stdout.on('data', (c) => (log += c));
  p.stderr.on('data', (c) => (log += c));
  const t0 = performance.now();
  for (;;) {
    if (p.exitCode !== null) throw new Error(`server exited: ${log.slice(-600)}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ready`);
      if (r.ok) return { p, bootMs: Math.round(performance.now() - t0) };
    } catch {
      /* not up yet */
    }
    if (performance.now() - t0 > 60_000)
      throw new Error(`server did not become ready: ${log.slice(-600)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
async function signIn(port) {
  const base = `http://127.0.0.1:${port}`;
  const r = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  if (!r.ok) throw new Error(`sign-in failed ${r.status}`);
  return (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}
const getJson = async (port, cookie, path) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie } });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
};
const summary = async (port, cookie) => ({
  rules: (await getJson(port, cookie, '/api/rules')).rules?.length ?? null,
  materials: (await getJson(port, cookie, '/api/materials')).length ?? null,
  designs: (await getJson(port, cookie, '/api/portfolio?filter=all')).rows?.length ?? null,
  users: (await getJson(port, cookie, '/api/users')).length ?? null,
});

const report = {
  startedAt: new Date().toISOString(),
  pg: sh('psql', ['--version']).trim(),
  node: process.version,
};
let server;
try {
  sh('psql', ['--no-psqlrc', '-d', withDb('postgres'), '-c', `create database "${srcDb}"`]);
  // 1. the bundle migrates, bootstraps the first admin and syncs the rules; then the SYNTHETIC demo data
  const a = await startServer(srcDb, 3961);
  server = a.p;
  report.bundleBootMs = a.bootMs;
  sh(
    'node_modules/.bin/tsx',
    ['src/demo/run.ts'],
    { ...baseEnv(srcDb, 3961), KHALTA_ALLOW_DEMO_SEED: '1', DEMO_PASSWORD: adminPassword },
    resolve('apps/api'),
  );
  const smoke1 = spawnSync(
    'node',
    ['scripts/smoke-staging.mjs', 'http://127.0.0.1:3961', adminEmail, adminPassword],
    { encoding: 'utf8' },
  );
  report.smokeSource = smoke1.status === 0 ? 'pass' : smoke1.stdout;
  const cookie1 = await signIn(3961);
  report.sourceSummary = await summary(3961, cookie1);
  server.kill();
  await new Promise((r) => setTimeout(r, 800));
  // optional: pad the scratch database so the timings say something about a larger one (SYNTHETIC filler, scratch DB only)
  const pad = Number(arg('pad-mb') ?? 0);
  if (pad > 0) {
    psql(srcDb, 'create table drill_padding (id int, payload text)');
    psql(
      srcDb,
      `insert into drill_padding select g, string_agg(md5(random()::text || g::text), '') from generate_series(1, ${pad * 1024}) g, generate_series(1, 32) group by g`,
    );
    report.paddingMb = pad;
  }

  // 2. backup
  const out = await timed('backupMs', async () =>
    sh('node', ['dist/cli.js', 'backup'], baseEnv(srcDb, 3961)),
  );
  report.backup = JSON.parse(out.trim().split('\n').pop());
  report.databaseSizeMb = Math.round(
    Number(psql(srcDb, 'select pg_database_size(current_database())')) / 1048576,
  );

  // 3. restore into a new database, verified against the manifest
  const restoreOut = await timed('restoreMs', async () =>
    sh('node', ['dist/cli.js', 'restore', '--target', withDb(dstDb)], baseEnv(srcDb, 3961)),
  );
  const jsonStart = restoreOut.indexOf('{');
  report.restoreLine = restoreOut.slice(0, jsonStart).trim();
  report.verify = JSON.parse(restoreOut.slice(jsonStart));

  // 4. the application on the restored copy
  const b = await startServer(dstDb, 3962);
  server = b.p;
  report.restoredBootMs = b.bootMs;
  const smoke2 = spawnSync(
    'node',
    ['scripts/smoke-staging.mjs', 'http://127.0.0.1:3962', adminEmail, adminPassword],
    { encoding: 'utf8' },
  );
  report.smokeRestored = smoke2.status === 0 ? 'pass' : smoke2.stdout;
  const cookie2 = await signIn(3962);
  report.restoredSummary = await summary(3962, cookie2);
  // the compiled bundle also renders the PDF submittal (Chromium) and runs the worker with its schedules
  const designs = (await getJson(3962, cookie2, '/api/portfolio?filter=all')).rows;
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE && designs?.length) {
    const r = await fetch('http://127.0.0.1:3962/api/designs/' + designs[0].id + '/submittal', {
      method: 'POST',
      headers: {
        cookie: cookie2,
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:3962',
      },
      body: JSON.stringify({ lang: 'both' }),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    report.pdf =
      r.ok && buf.subarray(0, 4).toString() === '%PDF'
        ? `ok (${buf.length} bytes)`
        : `FAIL ${r.status}`;
  } else report.pdf = 'skipped (no PLAYWRIGHT_CHROMIUM_EXECUTABLE)';
  server.kill();
  await new Promise((r) => setTimeout(r, 500));
  const w = spawn('node', ['dist/worker.js'], {
    cwd: bundle,
    env: { ...process.env, ...baseEnv(dstDb, 3962) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let wlog = '';
  w.stdout.on('data', (c) => (wlog += c));
  w.stderr.on('data', (c) => (wlog += c));
  await new Promise((r) => setTimeout(r, 5000));
  report.worker =
    w.exitCode === null && wlog.includes('worker started') ? 'running' : `FAIL ${wlog.slice(-300)}`;
  report.workerSchedules = psql(
    dstDb,
    "select string_agg(name || ' ' || cron, ', ' order by name) from pgboss.schedule",
  );
  w.kill();
  await new Promise((r) => setTimeout(r, 500));
  report.sameAsSource =
    JSON.stringify(report.sourceSummary) === JSON.stringify(report.restoredSummary);
  report.timingsMs = t;
  report.totalMs = Object.values(t).reduce((x, y) => x + y, 0);
  report.ok =
    report.verify.ok &&
    report.smokeSource === 'pass' &&
    report.smokeRestored === 'pass' &&
    report.sameAsSource;
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
} catch (e) {
  report.error = String(e.message ?? e);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  server?.kill();
  await new Promise((r) => setTimeout(r, 500));
  for (const d of [srcDb, dstDb])
    spawnSync('psql', [
      '--no-psqlrc',
      '-d',
      withDb('postgres'),
      '-c',
      `drop database if exists "${d}" with (force)`,
    ]);
  rmSync(work, { recursive: true, force: true });
}
