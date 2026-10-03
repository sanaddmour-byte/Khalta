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
});

export type Config = z.infer<typeof schema>;

/** Fails fast with a readable message; never falls back to an insecure secret. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
