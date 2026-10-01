import { schema, type Db } from '@khalta/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { eq } from 'drizzle-orm';
import type { Config } from './config';

export const MIN_PASSWORD_LENGTH = 12;
const SESSION_SECONDS = 60 * 60 * 24 * 7; // 7 days, sliding (refreshed once a day)

/**
 * Better Auth handles credentials, sessions and password hashing only. Sign-up is disabled: users
 * are created by an Admin through our audited API. Roles/plants/tenancy are read from our own
 * tables by the API middleware, never from the auth session payload.
 */
export function createAuth(db: Db, config: Config) {
  return betterAuth({
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.BETTER_AUTH_URL,
    trustedOrigins: [config.APP_BASE_URL],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    // Our own columns on the user table. Better Auth never inserts users here (sign-up is closed),
    // but it validates the Drizzle schema against its model and must know about required columns.
    user: {
      additionalFields: {
        tenantId: { type: 'string', required: true, input: false },
        role: { type: 'string', required: false, input: false },
        banned: { type: 'boolean', required: false, input: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: 128,
    },
    session: { expiresIn: SESSION_SECONDS, updateAge: 60 * 60 * 24 },
    rateLimit: { enabled: config.NODE_ENV !== 'test', window: 60, max: 100 },
    databaseHooks: {
      session: {
        create: {
          // Deactivated or soft-deleted users cannot open a session.
          before: async (session) => {
            const [u] = await db
              .select({ banned: schema.users.banned, deletedAt: schema.users.deletedAt })
              .from(schema.users)
              .where(eq(schema.users.id, session.userId));
            if (!u || u.banned || u.deletedAt) return false;
            return { data: session };
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

export async function hashPassword(auth: Auth, password: string): Promise<string> {
  return (await auth.$context).password.hash(password);
}
