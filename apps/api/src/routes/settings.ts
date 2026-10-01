import { schema } from '@khalta/db';
import { sql } from 'drizzle-orm';
import { loadSettings, settingsPatchSchema, settingsSchema } from '../settings';
import type { ApiRoutes } from '../route';

export function settingsRoutes(api: ApiRoutes) {
  api.get(
    '/api/settings',
    { summary: 'Get tenant settings', capability: 'org.manage' },
    async ({ auth, db }) => loadSettings(db, auth.tenantId),
  );

  api.mutate(
    'patch',
    '/api/settings',
    { summary: 'Update tenant settings', capability: 'org.manage', body: settingsPatchSchema },
    async ({ auth, body, tx, audit }) => {
      const before = await loadSettings(tx, auth.tenantId);
      const after = settingsSchema.parse({ ...before, ...body });
      await tx
        .insert(schema.tenantSettings)
        .values({ tenantId: auth.tenantId, settings: after, updatedBy: auth.user.id })
        .onConflictDoUpdate({
          target: schema.tenantSettings.tenantId,
          set: { settings: after, updatedBy: auth.user.id, updatedAt: sql`now()` },
        });
      await audit.record({
        action: 'settings.update',
        entityType: 'tenant_settings',
        entityId: auth.tenantId,
        before,
        after,
      });
      return after;
    },
  );
}
