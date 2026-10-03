import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.url().default('http://localhost:3000'),
  APP_BASE_URL: z.url().default('http://localhost:5173'),
  LOG_LEVEL: z.string().default('info'),
  BOOTSTRAP_ADMIN_EMAIL: z.email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),
  TENANT_NAME: z.string().default('Khalta'),
  /** `1` marks the database as synthetic demo data (UI banner). */
  KHALTA_DEMO: z.enum(['0', '1']).default('0'),
  /** `1` behind a reverse proxy (Railway): trust X-Forwarded-For for client IPs (rate limiting, logs). */
  TRUST_PROXY: z.enum(['0', '1']).default('0'),
  /** Proactive engine (M5.1): debounce for price-change jobs and the short delay other jobs wait for the commit. */
  JOB_PRICE_DEBOUNCE_SECONDS: z.coerce.number().int().min(0).default(900),
  JOB_DELAY_SECONDS: z.coerce.number().int().min(0).default(5),
  /** `1` runs the worker inside the API process (dev, tests, e2e); staging runs `worker.ts` separately. */
  JOBS_IN_PROCESS: z.enum(['0', '1']).default('0'),
  /** Built web app to serve from the API (same origin); unset = API only. */
  WEB_DIST_DIR: z.string().optional(),
  /** Which deployment this is. `production` turns on the strict guard below; staging runs as `staging`. */
  DEPLOY_ENV: z.enum(['development', 'test', 'staging', 'production']).optional(),
  /** Base URL the PDF's QR codes point at (defaults to APP_BASE_URL). */
  PDF_BASE_URL: z.url().optional(),
  /** Git SHA or version tag of this build (shown in backups and logs). */
  APP_VERSION: z.string().optional(),
  /** Backups (M6.2). A bucket (S3-compatible) or a directory; neither = no backups (reported by /ready). */
  BACKUP_ENABLED: z.enum(['0', '1']).default('1'),
  BACKUP_ENV: z.string().min(1).default('local'),
  BACKUP_BUCKET_NAME: z.string().optional(),
  BACKUP_BUCKET_ENDPOINT: z.url().optional(),
  BACKUP_BUCKET_REGION: z.string().default('auto'),
  BACKUP_BUCKET_ACCESS_KEY_ID: z.string().optional(),
  BACKUP_BUCKET_SECRET_ACCESS_KEY: z.string().optional(),
  BACKUP_DIR: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

/** Fails fast with a readable message; never falls back to an insecure secret. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const problems = productionProblems(parsed.data, env);
  if (problems.length > 0)
    throw new Error(
      `Unsafe production configuration:\n${problems.map((p) => `  ${p}`).join('\n')}`,
    );
  return parsed.data;
}

const PLACEHOLDER = /change-?me|e2e-secret|dev-|example|password|secret-secret|0000000/i;

/** What `DEPLOY_ENV=production` refuses to start with (M6.2). Staging and development are not held to it. */
export function productionProblems(c: Config, env: NodeJS.ProcessEnv = process.env): string[] {
  if (c.DEPLOY_ENV !== 'production') return [];
  const out: string[] = [];
  if (c.NODE_ENV !== 'production') out.push('NODE_ENV must be production');
  for (const [k, v] of [
    ['BETTER_AUTH_URL', c.BETTER_AUTH_URL],
    ['APP_BASE_URL', c.APP_BASE_URL],
    ['PDF_BASE_URL', c.PDF_BASE_URL ?? c.APP_BASE_URL],
  ] as const)
    if (!v.startsWith('https://')) out.push(`${k} must be an https:// origin`);
  if (PLACEHOLDER.test(c.BETTER_AUTH_SECRET))
    out.push('BETTER_AUTH_SECRET looks like a placeholder; generate one (openssl rand -base64 48)');
  if (c.BOOTSTRAP_ADMIN_PASSWORD && PLACEHOLDER.test(c.BOOTSTRAP_ADMIN_PASSWORD))
    out.push('BOOTSTRAP_ADMIN_PASSWORD looks like a placeholder');
  if (c.KHALTA_DEMO === '1')
    out.push('KHALTA_DEMO=1 (synthetic data banner) is not allowed in production');
  if (env['KHALTA_ALLOW_DEMO_SEED'])
    out.push('KHALTA_ALLOW_DEMO_SEED must not be set in production');
  if (c.TRUST_PROXY !== '1') out.push('TRUST_PROXY must be 1 behind the platform proxy');
  return out;
}
