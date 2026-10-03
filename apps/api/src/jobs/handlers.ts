import { schema, type Db } from '@khalta/db';
import {
  nightly,
  onMaterialTest,
  onPriceChange,
  onRuleChange,
  onStrengthResult,
} from '../insights/triggers';
import type { Handler, JobName } from './index';

/** Job name → trigger. Data comes from the route that enqueued it (tenant, plants, ids). */
export function handlersFor(db: Db): Record<JobName, Handler> {
  const ctx = { db };
  const str = (v: unknown) => String(v);
  return {
    'price-change': (d) =>
      onPriceChange(ctx, str(d['tenantId']), d['plantIds'] as string[] | undefined).then(() => {}),
    'material-test': (d) =>
      onMaterialTest(ctx, str(d['tenantId']), str(d['materialId'])).then(() => {}),
    'rule-change': (d) => onRuleChange(ctx, str(d['tenantId'])).then(() => {}),
    'strength-result': (d) =>
      onStrengthResult(ctx, str(d['tenantId']), str(d['designId'])).then(() => {}),
    nightly: async () => {
      for (const t of await db.select({ id: schema.tenants.id }).from(schema.tenants))
        await nightly(ctx, t.id);
    },
  };
}
