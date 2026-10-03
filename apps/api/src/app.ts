import { createDb, type Db } from '@khalta/db';
import { toNodeHandler } from 'better-auth/node';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { createAuth, type Auth } from './auth';
import { createLogger } from './logger';
import type { Config } from './config';
import { errorHandler, notFound } from './errors';
import { authenticate, originGuard } from './middleware';
import { ApiRoutes } from './route';
import { auditRoutes } from './routes/audit';
import { attachmentRoutes } from './routes/attachments';
import { designRoutes } from './routes/designs';
import { insightRoutes } from './routes/insights';
import { strengthRoutes } from './routes/strength';
import { volumeRoutes } from './routes/volumes';
import { labRoutes } from './routes/lab';
import { RecordingJobs, type Jobs } from './jobs';
import { lifecycleRoutes } from './routes/lifecycle';
import { evaluationRoutes } from './routes/evaluations';
import { portfolioRoutes } from './routes/portfolio';
import { baselineRoutes } from './routes/baselines';
import { designRequestRoutes } from './routes/designRequests';
import { profileRoutes } from './routes/profiles';
import { legacyRoutes } from './routes/legacy';
import { materialRoutes } from './routes/materials';
import { meRoutes } from './routes/me';
import { plantRoutes } from './routes/plants';
import { priceRoutes } from './routes/prices';
import { ruleRoutes } from './routes/rules';
import { settingsRoutes } from './routes/settings';
import { supplierRoutes } from './routes/suppliers';
import { userRoutes } from './routes/users';

export interface AppDeps {
  config: Config;
  db: Db;
  auth?: Auth;
  logger?: Logger;
  /** Background queue; a recording stub when omitted (API tests). */
  jobs?: Jobs;
  /** Queue health for admins (the worker reports pg-boss queue counts). */
  jobStatus?: () => Promise<unknown>;
}

// Only these Better Auth endpoints are exposed. Everything else (sign-up, change-email, password
// reset, ...) is closed: users and credentials change only through our audited API.
const AUTH_ALLOWLIST = new Set([
  '/api/auth/sign-in/email',
  '/api/auth/sign-out',
  '/api/auth/get-session',
]);

export function createApp({
  config,
  db,
  auth = createAuth(db, config),
  logger,
  jobs,
  jobStatus,
}: AppDeps) {
  const log = logger ?? createLogger(config);
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use(pinoHttp({ logger: log, genReqId: () => randomUUID() }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(originGuard([config.APP_BASE_URL, config.BETTER_AUTH_URL]));

  const authHandler = toNodeHandler(auth);
  app.all('/api/auth/*splat', (req, res, next) => {
    if (!AUTH_ALLOWLIST.has(req.path)) return next(notFound());
    return authHandler(req, res);
  });

  app.use(express.json({ limit: '1mb' }));

  const api = new ApiRoutes(db);
  api.jobs = jobs ?? new RecordingJobs();
  api.jobStatus = jobStatus ?? null;
  api.priceDebounceSeconds = config.JOB_PRICE_DEBOUNCE_SECONDS;
  api.jobDelaySeconds = config.JOB_DELAY_SECONDS;
  api.router.use(authenticate(db, auth));
  meRoutes(api);
  userRoutes(api, auth);
  plantRoutes(api);
  settingsRoutes(api);
  auditRoutes(api);
  ruleRoutes(api);
  supplierRoutes(api);
  attachmentRoutes(api);
  materialRoutes(api);
  priceRoutes(api);
  legacyRoutes(api);
  designRoutes(api);
  lifecycleRoutes(api);
  labRoutes(api);
  insightRoutes(api);
  volumeRoutes(api);
  strengthRoutes(api);
  evaluationRoutes(api);
  portfolioRoutes(api);
  baselineRoutes(api);
  designRequestRoutes(api);
  profileRoutes(api);
  app.get('/api/openapi.json', authenticate(db, auth), (_req, res) => {
    res.json(api.openApiDocument());
  });
  // Built web app, same origin (ADR 0006). Registered before the authenticated API router, but it only answers existing files and non-API GET paths.
  const webDir = config.WEB_DIST_DIR ? resolve(config.WEB_DIST_DIR) : null;
  if (webDir && existsSync(join(webDir, 'index.html'))) {
    app.use(
      express.static(webDir, {
        index: false,
        setHeaders: (res, file) => {
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader(
            'Cache-Control',
            file.includes(`${join(webDir, 'assets')}`)
              ? 'public, max-age=31536000, immutable'
              : 'no-cache',
          );
        },
      }),
    );
    app.use((req, res, next) => {
      if ((req.method !== 'GET' && req.method !== 'HEAD') || /^\/(api|health)(\/|$)/.test(req.path))
        return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Frame-Options', 'DENY');
      res.sendFile(join(webDir, 'index.html'));
    });
  }

  app.use(api.router);

  app.use((_req, _res, next) => next(notFound()));
  app.use(errorHandler);
  return Object.assign(app, { api });
}

export { createDb };
