// The worker service (staging and production run this next to the API, same image): pg-boss jobs only, no HTTP.
import { createDb } from '@khalta/db';
import { loadConfig } from './config';
import { startWorker } from './jobs';
import { handlersFor } from './jobs/handlers';
import { startHeartbeat } from './ops';

const config = loadConfig();
const handle = createDb(config.DATABASE_URL);
const worker = await startWorker(config, handlersFor(handle.db), (e, name) =>
  console.error(`job ${name} failed`, e),
);
const stopBeat = startHeartbeat(handle.db, config.APP_VERSION);
console.log('worker started');
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    stopBeat();
    void worker.stop().then(() => process.exit(0));
  });
