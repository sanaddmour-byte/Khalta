import { execFileSync } from 'node:child_process';
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

export default async function setup(project: TestProject) {
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
