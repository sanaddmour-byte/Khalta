import { schema, type Db, type RequestContext } from '@khalta/db';
import { isPlantScoped, isRole, type PlantScope, type Role } from '@khalta/rbac';
import { and, eq, isNull } from 'drizzle-orm';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import type { Auth } from './auth';
import { forbidden, unauthenticated } from './errors';
import { loadSettings, type Settings } from './settings';

export interface AuthContext {
  user: { id: string; name: string; email: string };
  role: Role;
  tenantId: string;
  scope: PlantScope;
  settings: Settings;
  ctx: RequestContext;
}

/** Resolves the session to a full, server-trusted auth context (role, tenant, plants, settings). */
export function authenticate(db: Db, auth: Auth): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) throw unauthenticated();
      const [u] = await db.select().from(schema.users).where(eq(schema.users.id, session.user.id));
      if (!u || u.deletedAt || u.banned || !isRole(u.role)) throw unauthenticated();

      const settings = await loadSettings(db, u.tenantId);
      let plantIds: string[] = [];
      if (isPlantScoped(u.role)) {
        const rows = await db
          .select({ plantId: schema.userPlants.plantId })
          .from(schema.userPlants)
          .innerJoin(schema.plants, eq(schema.plants.id, schema.userPlants.plantId))
          .where(
            and(
              eq(schema.userPlants.userId, u.id),
              isNull(schema.userPlants.deletedAt),
              isNull(schema.plants.deletedAt),
            ),
          );
        plantIds = rows.map((r) => r.plantId);
      }
      const context: AuthContext = {
        user: { id: u.id, name: u.name, email: u.email },
        role: u.role,
        tenantId: u.tenantId,
        scope: { all: !isPlantScoped(u.role), plantIds },
        settings,
        ctx: { tenantId: u.tenantId, actor: { id: u.id, role: u.role }, requestId: String(req.id) },
      };
      res.locals['auth'] = context;
      next();
    } catch (e) {
      next(e);
    }
  };
}

/**
 * Cookie-authenticated state-changing requests from a browser must come from our own origin.
 * Requests without an Origin header (non-browser clients) are allowed; session cookies are
 * SameSite=Lax as an additional layer.
 */
export function originGuard(allowed: string[]): RequestHandler {
  const set = new Set(allowed);
  return (req, _res, next) => {
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const origin = req.headers.origin;
    if (unsafe && origin && !set.has(origin))
      return next(forbidden('Cross-origin request blocked'));
    next();
  };
}
