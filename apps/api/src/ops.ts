// Operations endpoints and headers (M6.2): `/ready` (deploy gate) and the security headers. `/health` stays a cheap
// liveness check; `/ready` asks the database and the migration state, and only REPORTS backup freshness.
import { appliedMigrations, expectedMigrations, schema, type Db } from '@khalta/db';
import { createHash } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import type { Config } from './config';

/**
 * The built app and the API need nothing but themselves: no third-party scripts, styles, fonts or frames. The one
 * inline script in the HTML shell (theme and direction before first paint) is allowed by its hash, computed from the
 * file actually served.
 */
export function buildCsp(indexHtml: string): string {
  const hashes = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => `'sha256-${createHash('sha256').update(m[1]!, 'utf8').digest('base64')}'`,
  );
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders(config: Pick<Config, 'DEPLOY_ENV'>) {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.DEPLOY_ENV === 'production')
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

export const BACKUP_STALE_HOURS = 26;
export type BackupState = 'ok' | 'stale' | 'none' | 'failed' | 'disabled';

export async function backupState(
  db: Db,
  enabled: boolean,
  now = new Date(),
): Promise<{ state: BackupState; lastOkAt: string | null; lastStatus: string | null }> {
  if (!enabled) return { state: 'disabled', lastOkAt: null, lastStatus: null };
  const [last] = await db
    .select()
    .from(schema.backupRuns)
    .orderBy(desc(schema.backupRuns.startedAt))
    .limit(1);
  const [ok] = await db
    .select()
    .from(schema.backupRuns)
    .where(eq(schema.backupRuns.status, 'ok'))
    .orderBy(desc(schema.backupRuns.finishedAt))
    .limit(1);
  if (!ok)
    return { state: last ? 'failed' : 'none', lastOkAt: null, lastStatus: last?.status ?? null };
  const ageH = (now.getTime() - (ok.finishedAt as Date).getTime()) / 3_600_000;
  return {
    state: ageH > BACKUP_STALE_HOURS ? 'stale' : 'ok',
    lastOkAt: (ok.finishedAt as Date).toISOString(),
    lastStatus: last?.status ?? null,
  };
}

/** 200 when the database answers and every migration is applied; 503 otherwise. Backup state is information only. */
export function readyHandler(
  db: Db,
  config: Pick<Config, 'BACKUP_ENABLED' | 'APP_VERSION'>,
  expected = expectedMigrations(),
) {
  return async (_req: Request, res: Response) => {
    let applied = -1;
    let dbOk = false;
    try {
      applied = await appliedMigrations(db);
      dbOk = true;
    } catch {
      /* reported below */
    }
    const migrationsOk = dbOk && applied === expected;
    const backup = dbOk
      ? await backupState(db, config.BACKUP_ENABLED === '1').catch(() => ({
          state: 'none' as const,
          lastOkAt: null,
          lastStatus: null,
        }))
      : { state: 'none' as const, lastOkAt: null, lastStatus: null };
    res.status(dbOk && migrationsOk ? 200 : 503).json({
      status: dbOk && migrationsOk ? 'ready' : 'not_ready',
      database: dbOk ? 'ok' : 'unreachable',
      migrations: { applied, expected },
      backup,
      version: config.APP_VERSION ?? null,
    });
  };
}
