// Prepares a fresh e2e database (migrated + dev seed) before the API starts. Uses TEST_DATABASE_URL
// when set (CI service container); otherwise starts the throwaway local cluster (no Docker needed).
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const admin =
  process.env.TEST_DATABASE_URL ??
  execFileSync('tools/test-db/start.sh', { encoding: 'utf8' }).trim().split('\n').pop();
const url = new URL(admin);
url.pathname = '/khalta_e2e';

const client = new pg.Client({ connectionString: admin });
await client.connect();
await client.query('DROP DATABASE IF EXISTS khalta_e2e WITH (FORCE)');
await client.query('CREATE DATABASE khalta_e2e');
await client.end();

const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'e2e-secret-e2e-secret-e2e-secret-1234',
};
execFileSync('pnpm', ['--filter', '@khalta/db', 'migrate'], { env, stdio: 'inherit' });
execFileSync('pnpm', ['--filter', '@khalta/api', 'seed:dev'], { env, stdio: 'inherit' });
