// Strength intelligence jobs (M5.2): acceptance and sequence alerts on a new result, a refit of the design's group,
// the cement-reduction nudge (through the M5.1 opportunity path), and the nightly revalidation of approved models.
// Nothing here suspends, approves or changes a design: alerts are insights and a QC manager decides.
import { schema, withAudit, type Db, type Executor } from '@khalta/db';
import {
  belowBandSequence,
  groupKey,
  judgeAcceptance,
  lowerBandMpa,
  todayAmman,
  type AcceptanceRules,
  type Severity,
} from '@khalta/engine';
import { and, asc, eq } from 'drizzle-orm';
import { expireByKey, upsertInsight } from '../insights/service';
import { onPriceChange } from '../insights/triggers';
import { loadCurrentRecords } from '../rules/service';
import { loadSettings } from '../settings';
import { designGroup, fitGroup, groupsAt, modelInForce, revalidateApproved } from './service';

const LIVE = ['approved', 'in_production'];
type Ctx = { db: Db; now?: Date };

const sys = <T>(
  db: Db,
  tenantId: string,
  name: string,
  fn: (
    tx: Parameters<Parameters<typeof withAudit>[2]>[0],
    audit: Parameters<Parameters<typeof withAudit>[2]>[1],
  ) => Promise<T>,
) =>
  withAudit(db, { tenantId, actor: null, requestId: `job:${name}` }, async (tx, audit) => {
    const out = await fn(tx, audit);
    await audit.record({
      action: 'job.run',
      entityType: 'job',
      entityId: name,
      after: { job: name },
    });
    return out;
  });

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The acceptance values of one ruleset, as stored (never hard-coded here). */
async function acceptanceRules(
  tx: Executor,
  tenantId: string,
  ruleset: 'ACI' | 'JS',
): Promise<AcceptanceRules> {
  const rules = await loadCurrentRecords(tx, tenantId);
  const at = (k: string) => rules.find((r) => r.ruleset === ruleset && r.key === k);
  const keys = [
    'accept.avg3.min_ratio_fc',
    'accept.fc_threshold_mpa',
    'accept.single.max_deficit_mpa',
    'accept.single.min_ratio_fc',
  ];
  return {
    avg3MinRatio: num(at(keys[0]!)?.value),
    thresholdMpa: num(at(keys[1]!)?.value),
    singleMaxDeficitMpa: num(at(keys[2]!)?.value),
    singleMinRatio: num(at(keys[3]!)?.value),
    verified: keys.every((k) => at(k)?.verified === true),
  };
}

type DesignRow = typeof schema.mixDesigns.$inferSelect;

/** Set averages of a design at its test age, oldest first (one test per set). */
export async function testsOf(
  tx: Executor,
  d: DesignRow,
  ageDays: number,
): Promise<{ setId: string; mpa: number }[]> {
  const rows = await tx
    .select()
    .from(schema.strengthResults)
    .where(
      and(eq(schema.strengthResults.designId, d.id), eq(schema.strengthResults.ageDays, ageDays)),
    )
    .orderBy(
      asc(schema.strengthResults.castDate),
      asc(schema.strengthResults.createdAt),
      asc(schema.strengthResults.id),
    );
  const sets = new Map<string, number[]>();
  for (const r of rows) sets.set(r.setId, [...(sets.get(r.setId) ?? []), Number(r.resultMpa)]);
  return [...sets].map(([setId, v]) => ({ setId, mpa: v.reduce((a, b) => a + b, 0) / v.length }));
}

export async function onStrengthIntel({ db, now }: Ctx, tenantId: string, designId: string) {
  return sys(db, tenantId, 'strength-intel', async (tx, audit) => {
    const [d] = await tx
      .select()
      .from(schema.mixDesigns)
      .where(and(eq(schema.mixDesigns.id, designId), eq(schema.mixDesigns.tenantId, tenantId)));
    if (!d) return { alerts: 0 };
    const settings = await loadSettings(tx, tenantId);
    const today = todayAmman(now ?? new Date());
    const req = d.requirements as {
      fcMpa?: number | null;
      basis?: string | null;
      testAgeDays?: number | null;
    };
    let alerts = 0;

    // refit the group (a proposal; an unchanged input set stores nothing new)
    const g = await designGroup(tx, d);
    if (g) await fitGroup(tx, tenantId, g, settings, null, today);

    if (!(LIVE as string[]).includes(d.status) || !req.fcMpa || !req.testAgeDays) return { alerts };
    const tests = (await testsOf(tx, d, req.testAgeDays)).map((t) => t.mpa);
    const latest = (await testsOf(tx, d, req.testAgeDays)).at(-1)?.setId ?? '';

    // 1. acceptance (running average of 3 and the single-test rule), every ruleset the design is judged by
    const mode = (d.rulesetMode ?? 'BOTH') as 'ACI' | 'JS' | 'BOTH';
    const sets = mode === 'BOTH' ? (['ACI', 'JS'] as const) : ([mode] as const);
    const judged = [];
    for (const rs of sets) {
      const rules = await acceptanceRules(tx, tenantId, rs);
      judged.push({ rs, rules, r: judgeAcceptance(req.fcMpa, tests, rules) });
    }
    const breaches = judged.filter((j) => j.r.status === 'breach');
    if (breaches.length > 0) {
      const first = breaches[0]!;
      const out = await upsertInsight(tx, audit, {
        tenantId,
        type: 'low_strength',
        severity: 'critical',
        plantId: d.plantId,
        designId,
        keyParts: [designId, 'acceptance'],
        payload: {
          designCode: d.code,
          criterion: 'acceptance',
          fcMpa: req.fcMpa,
          ageDays: req.testAgeDays,
          latestSetId: latest,
          breaches: breaches.flatMap((b) => b.r.breaches.map((x) => ({ ruleset: b.rs, ...x }))),
          rulesVerified: breaches.every((b) => b.rules.verified),
          rulesetsWithoutValues: judged.filter((j) => j.r.status === 'unknown').map((j) => j.rs),
          averageMpa:
            first.r.latestAvg3Mpa === null ? null : Math.round(first.r.latestAvg3Mpa * 100) / 100,
          requiredFcrMpa: null,
          note: 'a QC manager decides whether to suspend',
        },
        provisional: !breaches.every((b) => b.rules.verified),
      });
      if (out.action === 'created') alerts++;
    } else await expireByKey(tx, tenantId, 'low_strength', [designId, 'acceptance'], 'recovered');

    // 2. sequence: the last N tests all below the approved model's lower band
    const model = g ? await modelInForce(tx, tenantId, groupKey(g)) : null;
    const wcm = d.lastEvaluationId ? await wcmFromEval(tx, d.lastEvaluationId) : null;
    let sequence = false;
    if (model && wcm !== null) {
      const band = lowerBandMpa(
        { a: Number(model.a), b: Number(model.b) },
        wcm,
        Number(model.sMpa),
      );
      sequence = belowBandSequence(tests, band, settings.strengthSequenceSets);
      if (sequence) {
        const out = await upsertInsight(tx, audit, {
          tenantId,
          type: 'low_strength',
          severity: 'critical' as Severity,
          plantId: d.plantId,
          designId,
          keyParts: [designId, 'sequence'],
          payload: {
            designCode: d.code,
            criterion: 'sequence',
            sets: settings.strengthSequenceSets,
            lowerBandMpa: Math.round(band * 100) / 100,
            recentMpa: tests
              .slice(-settings.strengthSequenceSets)
              .map((x) => Math.round(x * 100) / 100),
            modelId: model.id,
            note: 'a QC manager decides whether to suspend',
          },
          provisional: false,
        });
        if (out.action === 'created') alerts++;
      }
    }
    if (!sequence)
      await expireByKey(tx, tenantId, 'low_strength', [designId, 'sequence'], 'recovered');
    return { alerts };
  });
}

async function wcmFromEval(tx: Executor, evalId: string): Promise<number | null> {
  const [e] = await tx
    .select({ report: schema.designEvaluations.report })
    .from(schema.designEvaluations)
    .where(eq(schema.designEvaluations.id, evalId));
  return num(
    (e?.report as { figures?: Record<string, unknown> } | undefined)?.figures?.['ratio.wcm'],
  );
}

/** Steady overstrength with an approved model in force: let the opportunity path re-optimise the plant (theoretical only). */
async function overstrengthNudge(ctx: Ctx, tenantId: string) {
  const plants = await withAudit(
    ctx.db,
    { tenantId, actor: null, requestId: 'job:overstrength' },
    async (tx, audit) => {
      const settings = await loadSettings(tx, tenantId);
      const live = await tx
        .select()
        .from(schema.mixDesigns)
        .where(and(eq(schema.mixDesigns.tenantId, tenantId)));
      const hit = new Set<string>();
      for (const d of live) {
        if (!(LIVE as string[]).includes(d.status)) continue;
        const g = await designGroup(tx, d);
        if (!g || !(await modelInForce(tx, tenantId, groupKey(g)))) continue;
        const age = (d.requirements as { testAgeDays?: number | null }).testAgeDays;
        const fcr = await fcrOf(tx, d);
        if (!age || fcr === null) continue;
        const t = (await testsOf(tx, d, age)).map((x) => x.mpa);
        if (t.length < settings.strengthOverMinSets) continue;
        const avg = t.reduce((a, b) => a + b, 0) / t.length;
        if (avg >= fcr * (1 + settings.strengthOverMarginPct / 100)) hit.add(d.plantId);
      }
      await audit.record({
        action: 'job.run',
        entityType: 'job',
        entityId: 'overstrength',
        after: { plants: [...hit] },
      });
      return [...hit];
    },
  );
  if (plants.length > 0) await onPriceChange(ctx, tenantId, plants);
  return plants;
}

async function fcrOf(tx: Executor, d: DesignRow): Promise<number | null> {
  if (!d.lastEvaluationId) return null;
  const [e] = await tx
    .select({ report: schema.designEvaluations.report })
    .from(schema.designEvaluations)
    .where(eq(schema.designEvaluations.id, d.lastEvaluationId));
  return num(
    (e?.report as { strengthAdequacy?: { fcrMpa?: number | null } } | undefined)?.strengthAdequacy
      ?.fcrMpa,
  );
}

/** The nightly part of F-028: refit every group, revalidate approved models, look for steady overstrength. */
export async function nightlyStrength(ctx: Ctx, tenantId: string) {
  const today = todayAmman(ctx.now ?? new Date());
  const invalid = await sys(ctx.db, tenantId, 'strength-nightly', async (tx, audit) => {
    const settings = await loadSettings(tx, tenantId);
    for (const g of await groupsAt(tx, tenantId))
      await fitGroup(tx, tenantId, g, settings, null, today);
    const bad = await revalidateApproved(tx, audit, tenantId, settings, today);
    for (const b of bad)
      await upsertInsight(tx, audit, {
        tenantId,
        type: 'model_invalidated',
        severity: 'medium',
        plantId: b.plantId,
        keyParts: [b.id],
        payload: {
          modelId: b.id,
          reasons: b.reasons,
          note: 'the optimizer has gone back to the ACI 211.1 baseline for this group',
        },
      });
    return bad.length;
  });
  const plants = await overstrengthNudge(ctx, tenantId);
  return { invalidated: invalid, overstrengthPlants: plants };
}
