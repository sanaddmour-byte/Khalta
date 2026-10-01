import { pino, type DestinationStream } from 'pino';
import type { Config } from './config';

/** Production logger. Never logs credentials or session tokens. */
export function createLogger(config: Pick<Config, 'LOG_LEVEL'>, destination?: DestinationStream) {
  return pino(
    {
      level: config.LOG_LEVEL,
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
        censor: '[redacted]',
      },
    },
    destination,
  );
}
