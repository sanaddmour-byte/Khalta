// Change-impact assessment: a change (price, material test, expiry, rule, requirement revision, strength result)
// is assessed ONCE per distinct change (a dedupe key), per approved design, by the same evaluator and validator the
// rest of the app uses. The job's state is recorded so an operator can see pending, running, failed and completed
// work, and a retry after a failure assesses the same change again without duplicating anything. Approved versions are
// never touched: every outcome except `no_action` is a decision for a person (`dispositions`).
import { schema, withAudit, type Db, type Executor } from '@khalta/db';
import { classifyImpact, type ImpactFacts, type ImpactTrigger } from '@khalta/engine';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { DesignRow } from '../evaluation/service';
import { priceDesign } from '../insights/pricing';
import { loadMaterialParams } from '../materials/service';
import { detectDrift, type Properties } from '@khalta/engine';

const LIVE = ['approved', 'in_production'] as const;

export interface ChangeSubject {
  trigger: ImpactTrigger;
  /** The thing that changed (a material id, a revision id, a design id, a plant list…). */
  subject: string;
  /** A token that differs for every distinct change of that subject (a row id, a timestamp, a version). */
  token: string;
  /** Limits a price change to some plants. */
  plantIds?: string[];
}

export const dedupeKeyOf = (c: ChangeSubject) => `${c.trigger}|${c.subject}|${c.token}`;

async function liveUsing(tx: Executor, tenantId: string, materialId: string) {
  const rows = await tx
    .select({ designId: schema.mixDesignLines.designId })
    .from(schema.mixDesignLines)
    .innerJoin(schema.mixDesigns, eq(schema.mixDesigns.id, schema.mixDesignLines.designId))
    .where(
      and(
        eq(schema.mixDesigns.tenantId, tenantId),
        eq(schema.mixDesignLines.materialId, materialId),
        inArray(schema.mixDesigns.status, [...LIVE]),
      ),
    );
  return [...new Set(rows.map((r) => r.designId))];
}

async function liveAll(tx: Executor, tenantId: string, plantIds?: string[]) {
  return (
    await tx
      .select({ id: schema.mixDesigns.id })
      .from(schema.mixDesigns)
      .where(
        and(
          eq(schema.mixDesigns.tenantId, tenantId),
          inArray(schema.mixDesigns.status, [...LIVE]),
          ...(plantIds?.length ? [inArray(schema.mixDesigns.plantId, plantIds)] : []),
        ),
      )
      .limit(500)
  ).map((r) => r.id);
}

const designOf = async (tx: Executor, id: string) =>
  (await tx.select().from(schema.mixDesigns).where(eq(schema.mixDesigns.id, id)))[0] as DesignRow;

/** The facts for one design under one change. Pure reads: nothing is stored or altered here. */
async function factsFor(
  tx: Executor,
  tenantId: string,
  c: ChangeSubject,
  d: DesignRow,
): Promise<ImpactFacts> {
  const f: ImpactFacts = {};
  if (c.trigger === 'price_change') return f;
  if (c.trigger === 'requirements_revision') {
    f.requirementsSuperseded = true;
    return f;
  }
  if (c.trigger === 'strength_deterioration') {
    const [ev] = d.lastEvaluationId
      ? await tx
          .select({ report: schema.designEvaluations.report })
          .from(schema.designEvaluations)
          .where(eq(schema.designEvaluations.id, d.lastEvaluationId))
      : [];
    const fcr = (ev?.report as { strengthAdequacy?: { fcrMpa?: number | null } } | undefined)
      ?.strengthAdequacy?.fcrMpa;
    const age = (d.requirements as { testAgeDays?: number }).testAgeDays;
    const rows = await tx
      .select()
      .from(schema.strengthResults)
      .where(eq(schema.strengthResults.designId, d.id))
      .orderBy(desc(schema.strengthResults.castDate), desc(schema.strengthResults.createdAt));
    const last = rows.filter((r) => r.ageDays === age)[0];
    if (last && typeof fcr === 'number') {
      const set = rows.filter(
        (r) => r.setId === last.setId && r.castDate === last.castDate && r.ageDays === age,
      );
      const avg = set.reduce((s, r) => s + Number(r.resultMpa), 0) / set.length;
      f.strengthBelowFcr = avg < fcr;
    }
    return f;
  }
  const priced = await priceDesign(tx, tenantId, d);
  const fails = priced.report.checks.filter((x) => x.status === 'fail').length;
  if (fails > 0 && d.lastVerdict !== 'fail') f.newFailures = fails;
  if (c.trigger === 'test_expiry')
    f.testExpired = priced.report.dataQuality.some((q) => q.code === 'tests_expired');
  if (c.trigger === 'material_change') {
    const tests = await tx
      .select()
      .from(schema.materialTests)
      .where(
        and(
          eq(schema.materialTests.tenantId, tenantId),
          eq(schema.materialTests.materialId, c.subject),
        ),
      )
      .orderBy(desc(schema.materialTests.version))
      .limit(2);
    const [cur, prev] = tests;
    if (cur && prev) {
      f.sourceChanged = prev.source !== cur.source;
      const params = await loadMaterialParams(tx, tenantId);
      const drift = detectDrift(
        prev.properties as Properties,
        cur.properties as Properties,
        params.driftTolerance,
        params.fmSieves,
      );
      f.driftExceeded = drift.length > 0;
    }
  }
  return f;
}

async function designsFor(tx: Executor, tenantId: string, c: ChangeSubject): Promise<string[]> {
  switch (c.trigger) {
    case 'price_change':
    case 'rule_revision':
      return liveAll(tx, tenantId, c.trigger === 'price_change' ? c.plantIds : undefined);
    case 'test_expiry':
      return liveAll(tx, tenantId);
    case 'material_change':
      return liveUsing(tx, tenantId, c.subject);
    case 'strength_deterioration':
      return [c.subject];
    case 'requirements_revision': {
      // live designs that froze ANY superseded revision of the same project
      const [rev] = await tx
        .select({ projectRef: schema.projectRequirements.projectRef })
        .from(schema.projectRequirements)
        .where(eq(schema.projectRequirements.id, c.subject));
      if (!rev) return [];
      const old = await tx
        .select({ id: schema.projectRequirements.id })
        .from(schema.projectRequirements)
        .where(
          and(
            eq(schema.projectRequirements.tenantId, tenantId),
            eq(schema.projectRequirements.projectRef, rev.projectRef),
            eq(schema.projectRequirements.status, 'superseded'),
          ),
        );
      if (old.length === 0) return [];
      const rows = await tx
        .select({ id: schema.mixDesigns.id })
        .from(schema.mixDesigns)
        .where(
          and(
            eq(schema.mixDesigns.tenantId, tenantId),
            inArray(schema.mixDesigns.status, [...LIVE]),
            inArray(
              schema.mixDesigns.requirementsRevisionId,
              old.map((o) => o.id),
            ),
          ),
        );
      return rows.map((r) => r.id);
    }
  }
}

export type AssessResult =
  | { state: 'skipped'; impactId: string }
  | { state: 'completed'; impactId: string; items: number; actionable: number };

/**
 * Assess one change. Idempotent: a change already completed is skipped; one that is pending, running or failed is run
 * (again). A failure is recorded on the row and rethrown so the queue retries it; the retry reuses the same row.
 */
export async function assessChange(
  db: Db,
  tenantId: string,
  c: ChangeSubject,
): Promise<AssessResult> {
  const key = dedupeKeyOf(c);
  const claimed = await withAudit(
    db,
    { tenantId, actor: null, requestId: `job:change-impact` },
    async (tx, audit) => {
      await tx
        .insert(schema.changeImpacts)
        .values({ tenantId, trigger: c.trigger, subject: c.subject, dedupeKey: key })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(schema.changeImpacts)
        .where(
          and(eq(schema.changeImpacts.tenantId, tenantId), eq(schema.changeImpacts.dedupeKey, key)),
        )
        .for('update');
      await audit.record({
        action: 'job.run',
        entityType: 'job',
        entityId: 'change-impact',
        after: { trigger: c.trigger, subject: c.subject, state: row!.jobState },
      });
      if (row!.jobState === 'completed') return { id: row!.id, skip: true };
      await tx
        .update(schema.changeImpacts)
        .set({
          jobState: 'running',
          attempts: sql`${schema.changeImpacts.attempts} + 1`,
          startedAt: sql`now()`,
          lastError: null,
        })
        .where(eq(schema.changeImpacts.id, row!.id));
      return { id: row!.id, skip: false };
    },
  );
  if (claimed.skip) return { state: 'skipped', impactId: claimed.id };
  try {
    return await withAudit(
      db,
      { tenantId, actor: null, requestId: `job:change-impact` },
      async (tx, audit) => {
        let actionable = 0;
        const ids = await designsFor(tx, tenantId, c);
        for (const id of ids) {
          const d = await designOf(tx, id);
          if (!d) continue;
          const a = classifyImpact(c.trigger, await factsFor(tx, tenantId, c, d));
          if (a.class !== 'no_action') actionable++;
          await tx
            .insert(schema.changeImpactItems)
            .values({
              tenantId,
              impactId: claimed.id,
              designId: d.id,
              plantId: d.plantId,
              designVersion: d.version,
              klass: a.class,
              reasons: a.reasons,
            })
            .onConflictDoNothing();
        }
        await tx
          .update(schema.changeImpacts)
          .set({
            jobState: 'completed',
            finishedAt: sql`now()`,
            summary: { designs: ids.length, actionable },
          })
          .where(eq(schema.changeImpacts.id, claimed.id));
        await audit.record({
          action: 'change_impact.assess',
          entityType: 'change_impact',
          entityId: claimed.id,
          after: { trigger: c.trigger, subject: c.subject, designs: ids.length, actionable },
        });
        return { state: 'completed' as const, impactId: claimed.id, items: ids.length, actionable };
      },
    );
  } catch (e) {
    await db
      .update(schema.changeImpacts)
      .set({
        jobState: 'failed',
        // drizzle wraps the driver's message; the cause is the useful part
        lastError: String(
          (e as { cause?: Error }).cause?.message ?? (e as Error).message ?? e,
        ).slice(0, 500),
        finishedAt: sql`now()`,
      })
      .where(eq(schema.changeImpacts.id, claimed.id));
    throw e;
  }
}

/** Version tokens for the triggers, read from the rows that changed. */
export const tokens = {
  async rules(db: Executor, tenantId: string) {
    const [r] = await db
      .select({ at: sql<string>`max(${schema.rules.createdAt})::text` })
      .from(schema.rules)
      .where(and(eq(schema.rules.tenantId, tenantId), isNotNull(schema.rules.createdAt)));
    return r?.at ?? 'none';
  },
  async test(db: Executor, tenantId: string, materialId: string) {
    const [r] = await db
      .select({ v: schema.materialTests.version })
      .from(schema.materialTests)
      .where(
        and(
          eq(schema.materialTests.tenantId, tenantId),
          eq(schema.materialTests.materialId, materialId),
          eq(schema.materialTests.isCurrent, true),
        ),
      );
    return `v${r?.v ?? 0}`;
  },
  async price(db: Executor, tenantId: string) {
    const [r] = await db
      .select({ at: sql<string>`max(${schema.materialPrices.createdAt})::text` })
      .from(schema.materialPrices)
      .where(eq(schema.materialPrices.tenantId, tenantId));
    return r?.at ?? 'none';
  },
  async strength(db: Executor, designId: string) {
    const [r] = await db
      .select({ id: schema.strengthResults.id })
      .from(schema.strengthResults)
      .where(eq(schema.strengthResults.designId, designId))
      .orderBy(desc(schema.strengthResults.createdAt))
      .limit(1);
    return r?.id ?? 'none';
  },
};
