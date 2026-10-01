import express from 'express';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';

export function createApp(logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' })) {
  const app = express();
  app.disable('x-powered-by');
  app.use(pinoHttp({ logger }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}
