import { createDb, type Db } from '@khalta/db';
import { toNodeHandler } from 'better-auth/node';
import express from 'express';
import { randomUUID } from 'node:crypto';
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
}

// Only these Better Auth endpoints are exposed. Everything else (sign-up, change-email, password
// reset, ...) is closed: users and credentials change only through our audited API.
const AUTH_ALLOWLIST = new Set([
  '/api/auth/sign-in/email',
  '/api/auth/sign-out',
  '/api/auth/get-session',
]);

export function createApp({ config, db, auth = createAuth(db, config), logger }: AppDeps) {
  const log = logger ?? createLogger(config);
  const app = express();
  app.disable('x-powered-by');
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
  app.get('/api/openapi.json', authenticate(db, auth), (_req, res) => {
    res.json(api.openApiDocument());
  });
  app.use(api.router);

  app.use((_req, _res, next) => next(notFound()));
  app.use(errorHandler);
  return Object.assign(app, { api });
}

export { createDb };
