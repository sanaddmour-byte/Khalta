import { schema, type Db } from '@khalta/db';
import {
  nightly,
  onMaterialTest,
  onPriceChange,
  onRuleChange,
  onStrengthResult,
} from '../insights/triggers';
import { assessChange, tokens } from '../impact/service';
import { todayAmman } from '@khalta/engine';
import type { ImpactTrigger } from '@khalta/engine';
import { backupJob } from '../backup/job';
import { nightlyStrength, onStrengthIntel } from '../strength/intel';
import type { Handler, JobName } from './index';

/** Job name → trigger. Data comes from the route that enqueued it (tenant, plants, ids). */
export function handlersFor(db: Db): Record<JobName, Handler> {
  const ctx = { db };
  const str = (v: unknown) => String(v);
  return {
    'price-change': async (d) => {
      const plantIds = d['plantIds'] as string[] | undefined;
      await onPriceChange(ctx, str(d['tenantId']), plantIds);
      await assessChange(db, str(d['tenantId']), {
        trigger: 'price_change',
        subject: (plantIds ?? ['all']).slice().sort().join(','),
        token: await tokens.price(db, str(d['tenantId'])),
        ...(plantIds ? { plantIds } : {}),
      });
    },
    'material-test': async (d) => {
      await onMaterialTest(ctx, str(d['tenantId']), str(d['materialId']));
      await assessChange(db, str(d['tenantId']), {
        trigger: 'material_change',
        subject: str(d['materialId']),
        token: await tokens.test(db, str(d['tenantId']), str(d['materialId'])),
      });
    },
    'rule-change': async (d) => {
      await onRuleChange(ctx, str(d['tenantId']));
      await assessChange(db, str(d['tenantId']), {
        trigger: 'rule_revision',
        subject: 'rules',
        token: await tokens.rules(db, str(d['tenantId'])),
      });
    },
    'strength-result': async (d) => {
      await onStrengthResult(ctx, str(d['tenantId']), str(d['designId']));
      await onStrengthIntel(ctx, str(d['tenantId']), str(d['designId']));
      await assessChange(db, str(d['tenantId']), {
        trigger: 'strength_deterioration',
        subject: str(d['designId']),
        token: await tokens.strength(db, str(d['designId'])),
      });
    },
    // a generic change (for example a newly verified project-requirements revision)
    'change-impact': async (d) => {
      await assessChange(db, str(d['tenantId']), {
        trigger: str(d['trigger']) as ImpactTrigger,
        subject: str(d['subject']),
        token: str(d['token']),
      });
    },
    backup: async () => {
      await backupJob(db);
    },
    nightly: async () => {
      for (const t of await db.select({ id: schema.tenants.id }).from(schema.tenants)) {
        await nightly(ctx, t.id);
        await nightlyStrength(ctx, t.id);
        await assessChange(db, t.id, {
          trigger: 'test_expiry',
          subject: 'tests',
          token: todayAmman(),
        });
      }
    },
  };
}
