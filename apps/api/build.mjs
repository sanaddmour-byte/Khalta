// Compiles the API, the worker and the ops CLI into `dist/` (ADR 0017). Workspace packages (@khalta/*) are bundled; every
// third-party package stays external and MUST be a direct dependency of this package, so `pnpm deploy --prod` ships it.
// Runtime layout next to dist/: `migrations/` (SQL + journal), `seeds/` (rule seed YAML), `node_modules/`.
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const out = resolve(arg('out') ?? join(here, 'out'));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const direct = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@khalta/'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const result = await build({
  entryPoints: {
    server: join(here, 'src/server.ts'),
    worker: join(here, 'src/worker.ts'),
    cli: join(here, 'src/cli/ops.ts'),
    // staging only: `node dist/demo.js` (refuses to run in production unless KHALTA_ALLOW_DEMO_SEED=1)
    demo: join(here, 'src/demo/run.ts'),
  },
  outdir: join(out, 'dist'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  metafile: true,
  logLevel: 'warning',
  external: direct,
  // CommonJS packages that are inlined need require(); none are expected, this keeps a stray one working
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

// every bare import left in the output must be a node builtin or a direct dependency
const bare = new Set();
for (const o of Object.values(result.metafile.outputs))
  for (const i of o.imports) {
    if (!i.external) continue;
    const name = i.path.startsWith('@')
      ? i.path.split('/').slice(0, 2).join('/')
      : i.path.split('/')[0];
    if (name.startsWith('node:') || builtinModules.includes(name)) continue;
    bare.add(name);
  }
const missing = [...bare].filter((n) => !direct.includes(n));
if (missing.length) {
  console.error(
    `dist imports packages that are not direct dependencies of @khalta/api: ${missing.join(', ')}`,
  );
  process.exit(1);
}
cpSync(resolve(here, '../../packages/db/migrations'), join(out, 'migrations'), { recursive: true });
cpSync(resolve(here, '../../packages/rules/seeds'), join(out, 'seeds'), { recursive: true });
console.log(`built ${out} (externals: ${[...bare].sort().join(', ')})`);
