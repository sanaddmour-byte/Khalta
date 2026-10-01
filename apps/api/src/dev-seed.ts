// Local development data: one tenant, two plants, one user per role (password printed below).
// Refuses to run against production. Not the demo dataset (that is M1.3).
import { createDb, schema, withAudit } from '@khalta/db';
import { ROLES } from '@khalta/rbac';
import { eq } from 'drizzle-orm';
import { createAuth } from './auth';
import { bootstrap } from './bootstrap';
import { loadConfig } from './config';
import { insertUserWithPassword } from './routes/users';

const config = loadConfig();
if (config.NODE_ENV === 'production') throw new Error('dev seed refuses to run in production');
const PASSWORD = 'dev-password-change-me';

const handle = createDb(config.DATABASE_URL);
const auth = createAuth(handle.db, config);
const { tenantId } = await bootstrap(handle.db, auth, config);
const ctx = { tenantId, actor: null, requestId: 'dev-seed' };

await withAudit(handle.db, ctx, async (tx, audit) => {
  const plantIds: string[] = [];
  for (const [code, en, ar] of [
    ['AMM-01', 'Amman', 'عمّان'],
    ['AQB-01', 'Aqaba', 'العقبة'],
  ] as const) {
    const [existing] = await tx.select().from(schema.plants).where(eq(schema.plants.code, code));
    if (existing) {
      plantIds.push(existing.id);
      continue;
    }
    const [p] = await tx
      .insert(schema.plants)
      .values({ tenantId, code, nameEn: en, nameAr: ar })
      .returning();
    plantIds.push(p!.id);
    await audit.record({
      action: 'plant.create',
      entityType: 'plant',
      entityId: p!.id,
      after: { code },
    });
  }
  for (const role of ROLES) {
    const email = `${role.replace('_', '.')}@khalta.test`;
    const [existing] = await tx.select().from(schema.users).where(eq(schema.users.email, email));
    if (existing) continue;
    const id = await insertUserWithPassword(tx, auth, {
      tenantId,
      email,
      name: role,
      role,
      password: PASSWORD,
      createdBy: null,
    });
    for (const plantId of plantIds.slice(0, role === 'plant_manager' ? 1 : 2))
      await tx.insert(schema.userPlants).values({ tenantId, userId: id, plantId });
    await audit.record({
      action: 'user.create',
      entityType: 'user',
      entityId: id,
      after: { email, role },
    });
  }
  await audit.record({ action: 'dev_seed.run', entityType: 'tenant', entityId: tenantId });
});
console.log(
  `seeded; sign in as <role>@khalta.test (e.g. admin@khalta.test) with password "${PASSWORD}"`,
);
await handle.close();
