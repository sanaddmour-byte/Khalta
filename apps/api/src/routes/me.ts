import { capabilitiesOf } from '@khalta/rbac';
import type { ApiRoutes } from '../route';

export function meRoutes(api: ApiRoutes) {
  api.get(
    '/api/me',
    { summary: 'Current user, role, capabilities and plant scope', capability: null },
    async ({ auth }) => ({
      user: auth.user,
      role: auth.role,
      capabilities: capabilitiesOf(auth.role, auth.settings),
      scope: auth.scope,
      // only what the UI needs to render (digits); admin-only settings stay behind /api/settings
      settings: {
        numberFormat: auth.settings.numberFormat,
        sanityRanges: auth.settings.sanityRanges,
      },
    }),
  );
}
