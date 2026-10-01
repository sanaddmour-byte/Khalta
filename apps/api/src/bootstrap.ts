import { withAudit, schema, type Db } from '@khalta/db';
import { count } from 'drizzle-orm';
import type { Auth } from './auth';
import type { Config } from './config';
import { insertUserWithPassword } from './routes/users';

/**
 * Single-tenant v1 (ADR 0001): ensure the one tenant exists and, only while there are no users at
 * all, create the first admin from BOOTSTRAP_ADMIN_* (audited as a system action).
 */
export async function bootstrap(db: Db, auth: Auth, config: Config): Promise<{ tenantId: string }> {
  let [tenant] = await db.select().from(schema.tenants).limit(1);
  if (!tenant) {
    [tenant] = await db
      .insert(schema.tenants)
      .values({ slug: 'default', name: config.TENANT_NAME })
      .returning();
  }
  if (!tenant) throw new Error('tenant bootstrap failed');
  const tenantId = tenant.id;

  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(schema.users);
  if (n === 0 && config.BOOTSTRAP_ADMIN_EMAIL && config.BOOTSTRAP_ADMIN_PASSWORD) {
    const { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_PASSWORD: password } = config;
    await withAudit(db, { tenantId, actor: null, requestId: 'bootstrap' }, async (tx, audit) => {
      const id = await insertUserWithPassword(tx, auth, {
        tenantId,
        email: email.toLowerCase(),
        name: 'Administrator',
        role: 'admin',
        password,
        createdBy: null,
      });
      await audit.record({
        action: 'user.bootstrap_admin',
        entityType: 'user',
        entityId: id,
        after: { email, role: 'admin' },
      });
    });
  }
  return { tenantId };
}
