// `pnpm db:migrate`. A separate entry so that bundling the library never runs migrations as a side effect.
import { runMigrations } from './migrate';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
await runMigrations(url);
console.log('migrations applied');
