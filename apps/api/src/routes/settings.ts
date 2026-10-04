import { schema } from '@khalta/db';
import { sql } from 'drizzle-orm';
import { roleCan } from '@khalta/rbac';
import { ApiError } from '../errors';
import {
  isAdministrativeSetting,
  loadSettings,
  settingsPatchSchema,
  settingsSchema,
} from '../settings';
import type { ApiRoutes } from '../route';

export function settingsRoutes(api: ApiRoutes) {
  api.get(
    '/api/settings',
    { summary: 'Get tenant settings', capability: 'settings.edit' },
    async ({ auth, db }) => loadSettings(db, auth.tenantId),
  );

  api.mutate(
    'patch',
    '/api/settings',
    {
      summary:
        'Update tenant settings. Administrative keys need org.manage; every other (safety-relevant) key needs engineering authority',
      capability: 'settings.edit',
      body: settingsPatchSchema,
    },
    async ({ auth, body, tx, audit }) => {
      const before = await loadSettings(tx, auth.tenantId);
      const after = settingsSchema.parse({ ...before, ...body });
      const changed = Object.keys(body).filter(
        (k) =>
          JSON.stringify((before as Record<string, unknown>)[k]) !==
          JSON.stringify((after as Record<string, unknown>)[k]),
      );
      const engineering = changed.filter((k) => !isAdministrativeSetting(k));
      const administrative = changed.filter(isAdministrativeSetting);
      if (engineering.length > 0 && !roleCan(auth.role, 'config.engineering', auth.settings))
        throw new ApiError(
          403,
          'engineering_authorization_required',
          'These settings affect evidence, validity limits or acceptance; they need engineering authority',
          { keys: engineering },
        );
      if (administrative.length > 0 && !roleCan(auth.role, 'org.manage', auth.settings))
        throw new ApiError(
          403,
          'administrator_required',
          'These settings are organisational; they need an administrator',
          { keys: administrative },
        );
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
        after: { ...after, _changed: changed, _safetyRelevant: engineering },
      });
      return after;
    },
  );
}
