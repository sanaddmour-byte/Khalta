// `pnpm e2e`: the `main` project, then the `rules` project (they edit the same rules and must not overlap), one exit code.
import { spawnSync } from 'node:child_process';

const extra = process.argv.slice(2);
let code = 0;
for (const project of ['main', 'rules']) {
  const r = spawnSync('pnpm', ['exec', 'playwright', 'test', `--project=${project}`, ...extra], {
    stdio: 'inherit',
  });
  code = Math.max(code, r.status ?? 1);
}
process.exit(code);
