import { randomBytes } from 'node:crypto';
import { createDb, schema, withAudit } from '@khalta/db';
import type { Role } from '@khalta/rbac';
import pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { inject } from 'vitest';
import { createApp } from '../src/app';
import { createAuth } from '../src/auth';
import { bootstrap } from '../src/bootstrap';
import { loadConfig, type Config } from '../src/config';
import { insertUserWithPassword } from '../src/routes/users';
import { syncRules } from '../src/rules/service';
import { loadSeeds } from '@khalta/rules/loader';

export const PASSWORD = 'correct-horse-battery-staple';
const SECRET = 'test-secret-test-secret-test-secret-123';

export function testEnv(url: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: url,
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: 'http://localhost:3000',
    APP_BASE_URL: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
  };
}

export async function createTestEnv(
  overrides: Partial<NodeJS.ProcessEnv> = {},
  opts: { seedRules?: boolean } = {},
) {
  const adminUrl = inject('adminUrl');
  const name = `khalta_t_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${inject('templateDb')}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;

  const config: Config = loadConfig({ ...testEnv(url.toString()), ...overrides });
  const handle = createDb(config.DATABASE_URL);
  const auth = createAuth(handle.db, config);
  const { tenantId } = await bootstrap(handle.db, auth, config);
  if (opts.seedRules) {
    const seeds = loadSeeds();
    await withAudit(handle.db, { tenantId, actor: null, requestId: 'test-seed' }, (tx, audit) =>
      syncRules(tx, audit, tenantId, seeds),
    );
  }
  const app = createApp({ config, db: handle.db, auth, logger: pino({ level: 'silent' }) });
  let n = 0;

  async function seedUser(
    role: Role,
    opts: { plantIds?: string[]; tenantId?: string; email?: string } = {},
  ) {
    const email = opts.email ?? `${role}-${++n}@example.test`;
    const tid = opts.tenantId ?? tenantId;
    const id = await handle.db.transaction(async (tx) => {
      const uid = await insertUserWithPassword(tx, auth, {
        tenantId: tid,
        email,
        name: `${role} ${n}`,
        role,
        password: PASSWORD,
        createdBy: null,
      });
      for (const plantId of opts.plantIds ?? [])
        await tx.insert(schema.userPlants).values({ tenantId: tid, userId: uid, plantId });
      return uid;
    });
    return { id, email, password: PASSWORD, role };
  }

  async function seedPlant(code: string, createdBy: string | null = null, tid = tenantId) {
    const [p] = await handle.db
      .insert(schema.plants)
      .values({ tenantId: tid, code, nameAr: `مصنع ${code}`, nameEn: `Plant ${code}`, createdBy })
      .returning();
    return p!;
  }

  async function seedTenant(slug: string) {
    const [t] = await handle.db.insert(schema.tenants).values({ slug, name: slug }).returning();
    return t!;
  }

  async function login(email: string, password = PASSWORD) {
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/sign-in/email').send({ email, password });
    if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${res.text}`);
    return agent;
  }

  async function auditRows() {
    return handle.db.select().from(schema.auditLog).orderBy(schema.auditLog.id);
  }

  async function close() {
    await handle.close();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }

  return {
    app,
    auth,
    config,
    db: handle.db,
    pool: handle.pool,
    tenantId,
    seedUser,
    seedPlant,
    seedTenant,
    login,
    auditRows,
    close,
    withAudit,
  };
}
export type TestEnv = Awaited<ReturnType<typeof createTestEnv>>;
