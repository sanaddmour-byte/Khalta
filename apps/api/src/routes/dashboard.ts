// Role dashboards: what each role should look at first, as counts and short worklists, scoped to the caller's plants.
// Every figure is a count or a name read from existing records; nothing is computed that the screens behind it do not
// show, and cost figures never appear here (cost lives on the screens that gate it).
import { schema } from '@khalta/db';
import { ownershipOf } from '@khalta/engine';
import { canAccessPlant, roleCan } from '@khalta/rbac';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ApiRoutes } from '../route';

export interface DashCard {
  id: string;
  count: number;
  /** The screen that lists them. */
  to: string;
  tone: 'neutral' | 'attention' | 'critical';
}

export function dashboardRoutes(api: ApiRoutes) {
  api.get(
    '/api/dashboard',
    {
      summary:
        'What this role should look at first: counts and short worklists for the caller’s plants (no cost figures)',
      capability: 'library.read',
    },
    async ({ auth, db }) => {
      const scoped = <T extends { plantId: string | null }>(rows: T[]) =>
        rows.filter((r) => !r.plantId || canAccessPlant(auth.scope, r.plantId));
      const designs = scoped(
        await db
          .select({
            id: schema.mixDesigns.id,
            code: schema.mixDesigns.code,
            name: schema.mixDesigns.name,
            plantId: schema.mixDesigns.plantId,
            status: schema.mixDesigns.status,
            needsRevalidation: schema.mixDesigns.needsRevalidation,
            updatedAt: schema.mixDesigns.updatedAt,
          })
          .from(schema.mixDesigns)
          .where(
            and(eq(schema.mixDesigns.tenantId, auth.tenantId), isNull(schema.mixDesigns.deletedAt)),
          ),
      );
      const n = (f: (d: (typeof designs)[number]) => boolean) => designs.filter(f).length;
      const alerts = scoped(
        await db
          .select({
            id: schema.insights.id,
            type: schema.insights.type,
            severity: schema.insights.severity,
            plantId: schema.insights.plantId,
            designId: schema.insights.designId,
            lastSeenAt: schema.insights.lastSeenAt,
          })
          .from(schema.insights)
          .where(
            and(
              eq(schema.insights.tenantId, auth.tenantId),
              inArray(schema.insights.status, ['open']),
            ),
          )
          .orderBy(desc(schema.insights.lastSeenAt))
          .limit(300),
      );
      const urgent = alerts.filter((a) => a.severity === 'critical' || a.severity === 'high');
      const events = urgent.length
        ? await db
            .select()
            .from(schema.insightEvents)
            .where(
              and(
                inArray(
                  schema.insightEvents.insightId,
                  urgent.map((a) => a.id),
                ),
                inArray(schema.insightEvents.kind, ['assigned', 'acknowledged', 'escalated']),
              ),
            )
        : [];
      const now = new Date().toISOString();
      const own = urgent.map((a) => ({
        a,
        o: ownershipOf(
          events
            .filter((e) => e.insightId === a.id)
            .map((e) => ({
              kind: e.kind,
              at: e.at.toISOString(),
              detail: e.detail as Record<string, unknown>,
            })),
          now,
        ),
      }));
      const impactRows = await db
        .select({
          klass: schema.changeImpactItems.klass,
          disposition: schema.changeImpactItems.disposition,
          plantId: schema.changeImpactItems.plantId,
        })
        .from(schema.changeImpactItems)
        .where(eq(schema.changeImpactItems.tenantId, auth.tenantId));
      const openImpacts = scoped(impactRows).filter(
        (i) => i.klass !== 'no_action' && !i.disposition,
      );
      const failedJobs = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.changeImpacts)
        .where(
          and(
            eq(schema.changeImpacts.tenantId, auth.tenantId),
            eq(schema.changeImpacts.jobState, 'failed'),
          ),
        );

      const cards: DashCard[] = [];
      const add = (id: string, count: number, to: string, tone: DashCard['tone'] = 'neutral') =>
        cards.push({ id, count, to, tone });
      const can = (c: Parameters<typeof roleCan>[1]) => roleCan(auth.role, c, auth.settings);

      if (can('design.approve')) {
        add(
          'awaitingApproval',
          n((d) => d.status === 'trial_passed'),
          '/library',
          'attention',
        );
        add(
          'needsRevalidation',
          n((d) => d.needsRevalidation),
          '/library',
          'attention',
        );
      }
      if (can('design.write') || can('trial.request')) {
        add(
          'draftDesigns',
          n((d) => d.status === 'draft'),
          '/library',
        );
        add(
          'inTrial',
          n((d) => d.status === 'trial_candidate' || d.status === 'trial_in_progress'),
          '/library',
        );
      }
      if (can('production.release') || auth.role === 'plant_manager')
        add(
          'inProduction',
          n((d) => d.status === 'in_production'),
          '/library',
        );
      if (auth.role === 'sales' || auth.role === 'viewer')
        add(
          'approvedDesigns',
          n((d) => d.status === 'approved' || d.status === 'in_production'),
          '/library',
        );
      if (can('insight.accept') || auth.role === 'plant_manager' || can('design.write')) {
        add(
          'criticalAlerts',
          alerts.filter((a) => a.severity === 'critical').length,
          '/insights',
          'critical',
        );
        add(
          'unownedAlerts',
          own.filter((x) => x.o.state === 'unassigned').length,
          '/insights',
          'attention',
        );
        add(
          'overdueAlerts',
          own.filter((x) => x.o.state === 'overdue' || x.o.state === 'escalated').length,
          '/insights',
          'critical',
        );
        add('changeImpacts', openImpacts.length, '/insights', 'attention');
      }
      if (can('price.edit') || auth.role === 'procurement')
        add(
          'priceAlerts',
          alerts.filter((a) => a.type === 'prices_stale').length,
          '/prices',
          'attention',
        );
      if (can('org.manage')) {
        add('failedJobs', failedJobs[0]?.n ?? 0, '/insights', 'critical');
        const [u] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.users)
          .where(and(eq(schema.users.tenantId, auth.tenantId), isNull(schema.users.deletedAt)));
        add('users', u?.n ?? 0, '/settings');
      }

      const names = new Map(designs.map((d) => [d.id, d]));
      return {
        role: auth.role,
        cards,
        worklists: {
          awaitingApproval: can('design.approve')
            ? designs
                .filter((d) => d.status === 'trial_passed')
                .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
                .slice(0, 5)
                .map((d) => ({ id: d.id, code: d.code, name: d.name }))
            : [],
          alerts: alerts
            .filter((a) => a.severity === 'critical' || a.severity === 'high')
            .slice(0, 5)
            .map((a) => ({
              id: a.id,
              type: a.type,
              severity: a.severity,
              designCode: a.designId ? (names.get(a.designId)?.code ?? null) : null,
            })),
        },
      };
    },
  );
}
