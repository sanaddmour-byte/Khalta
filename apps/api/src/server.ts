import { createDb, runMigrations } from '@khalta/db';
import { createApp } from './app';
import { createAuth } from './auth';
import { bootstrap } from './bootstrap';
import { loadConfig } from './config';

const config = loadConfig();
await runMigrations(config.DATABASE_URL);
const handle = createDb(config.DATABASE_URL);
const auth = createAuth(handle.db, config);
await bootstrap(handle.db, auth, config);

createApp({ config, db: handle.db, auth }).listen(config.PORT, () => {
  console.log(`api listening on :${config.PORT}`);
});
