import { createDb, runMigrations, withAudit } from '@khalta/db';
import { loadSeeds } from '@khalta/rules/loader';
import { createApp } from './app';
import { createAuth } from './auth';
import { bootstrap } from './bootstrap';
import { loadConfig } from './config';
import { startWorker, type Jobs } from './jobs';
import { handlersFor } from './jobs/handlers';
import { startHeartbeat } from './ops';
import { syncRules } from './rules/service';

const config = loadConfig();
await runMigrations(config.DATABASE_URL);
const handle = createDb(config.DATABASE_URL);
const auth = createAuth(handle.db, config);
const { tenantId } = await bootstrap(handle.db, auth, config);

// Idempotent: inserts seed rules that do not exist yet; never overwrites database content.
const seeds = loadSeeds();
if (seeds.errors.length)
  throw new Error(`rule seed files are invalid:\n${seeds.errors.join('\n')}`);
const sync = await withAudit(
  handle.db,
  { tenantId, actor: null, requestId: 'startup' },
  (tx, audit) => syncRules(tx, audit, tenantId, seeds),
);
console.log(
  `rules: ${sync.inserted} inserted, ${sync.drift.length} differ from seed files (database wins)`,
);

// In dev, tests and e2e the worker runs inside this process; staging runs `worker.ts` as its own service.
let jobs: Jobs | undefined;
let jobStatus: (() => Promise<unknown>) | undefined;
if (config.JOBS_IN_PROCESS === '1') {
  const w = await startWorker(config, handlersFor(handle.db), (e, name) =>
    console.error(`job ${name} failed`, e),
  );
  jobs = w.jobs;
  jobStatus = w.status;
  startHeartbeat(handle.db, config.APP_VERSION);
}

createApp({
  config,
  db: handle.db,
  auth,
  ...(jobs ? { jobs } : {}),
  ...(jobStatus ? { jobStatus } : {}),
}).listen(config.PORT, () => {
  console.log(`api listening on :${config.PORT}`);
});
