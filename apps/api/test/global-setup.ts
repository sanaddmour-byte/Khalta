import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { runMigrations } from '@khalta/db';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

// Tests run against a real PostgreSQL. TEST_DATABASE_URL (a role that may CREATE DATABASE) wins;
// otherwise a throwaway local cluster is started (tools/test-db/start.sh, no Docker needed).
// One migrated template database is built once; each test file clones it (fast, fully isolated).
declare module 'vitest' {
  export interface ProvidedContext {
    adminUrl: string;
    templateDb: string;
  }
}

function withDb(url: string, db: string) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** PDF tests need Chromium; use the pre-installed one when the environment does not say where it is. */
function pickChromium() {
  if (process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE']) return;
  const dir = '/opt/pw-browsers';
  if (!existsSync(dir)) return;
  for (const d of readdirSync(dir).filter((x) => /^chromium-\d+$/.test(x))) {
    const exe = join(dir, d, 'chrome-linux', 'chrome');
    if (existsSync(exe)) process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] = exe;
  }
}

export default async function setup(project: TestProject) {
  pickChromium();
  const adminUrl =
    process.env['TEST_DATABASE_URL'] ??
    execFileSync(join(import.meta.dirname, '../../../tools/test-db/start.sh'), { encoding: 'utf8' })
      .trim()
      .split('\n')
      .pop()!;
  const templateDb = `khalta_tpl_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${templateDb}`);
  await runMigrations(withDb(adminUrl, templateDb));
  project.provide('adminUrl', adminUrl);
  project.provide('templateDb', templateDb);

  return async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${templateDb}`);
    await admin.end();
  };
}
