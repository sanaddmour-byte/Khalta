// `pnpm db:seed:demo`: creates the SYNTHETIC demo dataset. Refuses to run unless explicitly allowed.
import { createDb, runMigrations, withAudit } from '@khalta/db';
import { loadSeeds } from '@khalta/rules/loader';
import { createAuth } from '../auth';
import { bootstrap } from '../bootstrap';
import { loadConfig } from '../config';
import { syncRules } from '../rules/service';
import { seedDemo, seedDemoRules, upgradeDemoData } from './seed';

const config = loadConfig();
if (config.NODE_ENV === 'production' && process.env['KHALTA_ALLOW_DEMO_SEED'] !== '1')
  throw new Error(
    'demo seed refuses to run in production (set KHALTA_ALLOW_DEMO_SEED=1 on staging only)',
  );
const password =
  process.env['DEMO_PASSWORD'] ??
  (config.NODE_ENV === 'production' ? '' : 'demo-password-change-me');
if (password.length < 12)
  throw new Error('set DEMO_PASSWORD (at least 12 characters) for the demo users');

await runMigrations(config.DATABASE_URL);
const handle = createDb(config.DATABASE_URL);
const auth = createAuth(handle.db, config);
const { tenantId } = await bootstrap(handle.db, auth, config);
await withAudit(handle.db, { tenantId, actor: null, requestId: 'demo-seed' }, (tx, audit) =>
  syncRules(tx, audit, tenantId, loadSeeds()),
);
const r = await seedDemo({
  db: handle.db,
  auth,
  config,
  tenantId,
  password,
  log: (m) => console.log(`demo: ${m}`),
});
if (r.skipped)
  await upgradeDemoData({
    db: handle.db,
    auth,
    config,
    tenantId,
    password,
    log: (m) => console.log(`demo: ${m}`),
  });
const filled = await seedDemoRules({
  db: handle.db,
  auth,
  config,
  tenantId,
  password,
  log: (m) => console.log(`demo: ${m}`),
});
console.log(`demo rules: ${filled} synthetic values filled`);
console.log(
  r.skipped
    ? 'demo data already present; nothing changed'
    : `demo data created (${r.designs} legacy designs). Sign in as <role>@khalta.test`,
);
await handle.close();
