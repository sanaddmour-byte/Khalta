// The proactive engine's triggers (01-domain §8). Plain functions: the job layer calls them, tests call them directly.
// None of them changes a design: they create, refresh and expire insights, and the nightly sweep records the digest
// and the realized savings of closed months.
import { schema, withAudit, type Db, type Executor } from '@khalta/db';
import {
  annualised,
  cementLabel,
  detectDrift,
  driftSeverity,
  freshness,
  opportunityEligible,
  priceStaleness,
  reevaluationSeverity,
  savingPerM3,
  todayAmman,
  type Properties,
} from '@khalta/engine';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DesignRow } from '../evaluation/service';
import { loadMaterialParams } from '../materials/service';
import { runOptimizer, requestBody, type RequestBody } from '../optimizer/service';
import { buildCells, loadLiveRows, loadPrefs, loadSgs } from '../prices/service';
import { effectiveVolumes, realizeForEntry, systemAuth } from '../savings/service';
import { loadSettings } from '../settings';
import { ApiError } from '../errors';
import { priceDesign } from './pricing';
import { expireUnseen, hashKey, upsertInsight } from './service';

const LIVE = ['approved', 'in_production'] as const;
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
    // every run leaves a trace, even when it found nothing to say
    await audit.record({
      action: 'job.run',
      entityType: 'job',
      entityId: name,
      after: { job: name },
    });
    return out;
  });

async function liveDesigns(
  tx: Executor,
  tenantId: string,
  plantIds?: string[],
): Promise<DesignRow[]> {
  const where = [
    eq(schema.mixDesigns.tenantId, tenantId),
    inArray(schema.mixDesigns.status, [...LIVE]),
  ];
  if (plantIds?.length) where.push(inArray(schema.mixDesigns.plantId, plantIds));
  return (await tx
    .select()
    .from(schema.mixDesigns)
    .where(and(...where))
    .limit(300)) as DesignRow[];
}

/** The latest recorded monthly volume of a design, else the stated average from the legacy file. */
async function monthlyVolume(tx: Executor, d: DesignRow): Promise<string | null> {
  const eff = await effectiveVolumes(tx, d.id);
  const last = [...eff.values()].pop();
  return last?.volumeM3 ?? d.avgMonthlyVolumeM3 ?? null;
}

/** `white` when the design's cement is recorded as white, else `grey` (which keeps unlabelled cements, excludes white). */
export async function cementColourOf(tx: Executor, designId: string): Promise<'white' | 'grey'> {
  const rows = await tx
    .select({ props: schema.materialTests.properties })
    .from(schema.mixDesignLines)
    .innerJoin(schema.materials, eq(schema.materials.id, schema.mixDesignLines.materialId))
    .innerJoin(
      schema.materialTests,
      and(
        eq(schema.materialTests.materialId, schema.materials.id),
        eq(schema.materialTests.isCurrent, true),
      ),
    )
    .where(
      and(eq(schema.mixDesignLines.designId, designId), eq(schema.materials.category, 'cement')),
    );
  return rows.some((r) => cementLabel(r.props as Record<string, unknown>).colour === 'white')
    ? 'white'
    : 'grey';
}

/** The request the optimizer would run for an existing design: its own requirements, its plant, current prices. */
export function requestFor(
  d: DesignRow,
  mode: 'ACI' | 'JS' | 'BOTH',
  cementColour: 'white' | 'grey' = 'grey',
): RequestBody | null {
  const r = d.requirements as Record<string, unknown>;
  const parsed = requestBody.safeParse({
    plantId: d.plantId,
    mode,
    objective: 'cheapest',
    cementColour,
    requirements: {
      fcMpa: r['fcMpa'],
      basis: r['basis'] ?? 'cylinder',
      testAgeDays: r['testAgeDays'] ?? 28,
      exposure: r['exposure'] ?? [],
      slumpMm: r['slumpMm'] ?? 0,
      nmasMm: r['nmasMm'] ?? null,
      pumpable: r['pumpable'] ?? false,
      s3Option: r['s3Option'] ?? null,
      airPct: r['airPct'] ?? null,
    },
  });
  return parsed.success ? parsed.data : null;
}

// ------------------------------------------------------------------------------------------ price change

/** Re-optimise each approved / in-production design at the plant(s) at current prices; a validated, compliant, cheaper variant is a THEORETICAL opportunity. */
export async function onPriceChange({ db }: Ctx, tenantId: string, plantIds?: string[]) {
  return sys(db, tenantId, 'price-change', async (tx, audit) => {
    const settings = await loadSettings(tx, tenantId);
    const thresholds = {
      minPerM3: settings.insightMinSavingJodPerM3,
      minAnnualJod: settings.insightMinAnnualJod,
    };
    let created = 0;
    for (const d of await liveDesigns(tx, tenantId, plantIds)) {
      const now = await priceDesign(tx, tenantId, d);
      if (!now.cost || !now.validatorPass) continue;
      const stored = d.lastEvaluationId
        ? (
            await tx
              .select({ mode: schema.designEvaluations.mode })
              .from(schema.designEvaluations)
              .where(eq(schema.designEvaluations.id, d.lastEvaluationId))
          )[0]
        : undefined;
      // a design on a white cement is only ever offered white cements; any other design never gets one (M7.1)
      const body = requestFor(d, stored?.mode ?? 'BOTH', await cementColourOf(tx, d.id));
      if (!body) continue;
      let run;
      try {
        run = await runOptimizer(tx, tenantId, body);
      } catch (e) {
        if (e instanceof ApiError) continue; // blocked (named parameters missing) or rejected characteristics: nothing to offer
        throw e;
      }
      const best = run.result.candidates.find(
        (c) => run.validations.get(c.rank)?.status === 'pass' && c.costJodPerM3 !== null,
      );
      if (!best?.costJodPerM3) continue;
      const perM3 = savingPerM3(now.cost, best.costJodPerM3);
      const vol = await monthlyVolume(tx, d);
      const annual = vol ? annualised(perM3, vol) : null;
      if (!opportunityEligible(perM3, annual, thresholds)) continue;
      const linesKey = hashKey(
        JSON.stringify(
          best.lines
            .map((l: { materialId: string; kgPerM3: string }) => [l.materialId, l.kgPerM3])
            .sort(),
        ),
      );
      const r = await upsertInsight(tx, audit, {
        tenantId,
        type: 'opportunity',
        severity: 'medium',
        plantId: d.plantId,
        designId: d.id,
        keyParts: [d.id, linesKey],
        payload: {
          designCode: d.code,
          designVersion: d.version,
          request: body,
          candidate: { rank: best.rank, lines: best.lines, evidence: best.evidence },
          basis: 'current prices; theoretical until a trial and approval',
        },
        savingJodPerM3: perM3,
        annualJod: annual,
        provisional: best.report?.provisional ?? true,
      });
      if (r.action === 'created') created++;
    }
    return { created };
  });
}

// ------------------------------------------------------------------------------------------ material tests

/** A new material test: compare with the previous one, re-evaluate the designs that use the material. */
export async function onMaterialTest({ db }: Ctx, tenantId: string, materialId: string) {
  return sys(db, tenantId, 'material-test', async (tx, audit) => {
    const tests = await tx
      .select()
      .from(schema.materialTests)
      .where(
        and(
          eq(schema.materialTests.tenantId, tenantId),
          eq(schema.materialTests.materialId, materialId),
        ),
      )
      .orderBy(desc(schema.materialTests.version))
      .limit(2);
    const [cur, prev] = tests;
    if (!cur || !prev) return { created: 0 };
    const params = await loadMaterialParams(tx, tenantId);
    const [mat] = await tx
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, materialId));
    if (!mat) return { created: 0 };
    const drift = detectDrift(
      prev.properties as Properties,
      cur.properties as Properties,
      params.driftTolerance,
      params.fmSieves,
    );
    const sourceChanged = prev.source !== cur.source;
    const sev = driftSeverity(drift, sourceChanged);
    const users = await tx
      .select({ designId: schema.mixDesignLines.designId })
      .from(schema.mixDesignLines)
      .innerJoin(schema.mixDesigns, eq(schema.mixDesigns.id, schema.mixDesignLines.designId))
      .where(
        and(
          eq(schema.mixDesignLines.materialId, materialId),
          inArray(schema.mixDesigns.status, [...LIVE]),
        ),
      );
    const designIds = [...new Set(users.map((u) => u.designId))];
    let created = 0;
    let worst = sev;
    const failing: { designId: string; code: string }[] = [];
    for (const id of designIds) {
      const [d] = (await tx
        .select()
        .from(schema.mixDesigns)
        .where(eq(schema.mixDesigns.id, id))) as DesignRow[];
      const p = await priceDesign(tx, tenantId, d!);
      const fails = p.report.checks.filter((c) => c.status === 'fail').length;
      const yieldCheck = p.report.checks.find((c) => c.id === 'yield');
      const yieldPct = typeof yieldCheck?.value === 'number' ? yieldCheck.value * 100 : null;
      const s = reevaluationSeverity({
        newFailures: fails,
        yieldDriftPct: yieldPct,
        wasPassing: d!.lastVerdict === 'pass',
      });
      if (s) {
        failing.push({ designId: id, code: d!.code });
        const r = await upsertInsight(tx, audit, {
          tenantId,
          type: 'compliance_failure',
          severity: s,
          plantId: d!.plantId,
          designId: id,
          keyParts: [id, cur.id],
          payload: {
            designCode: d!.code,
            cause: 'material_test',
            materialId,
            failingChecks: p.report.checks.filter((c) => c.status === 'fail').map((c) => c.id),
            yieldDriftPct: yieldPct,
          },
          provisional: p.provisional,
        });
        if (r.action === 'created') created++;
        if (!worst || s === 'critical' || (s === 'high' && worst !== 'critical')) worst = s;
      }
    }
    if (sev) {
      const r = await upsertInsight(tx, audit, {
        tenantId,
        type: 'test_drift',
        severity: worst ?? sev,
        plantId: mat.plantId,
        keyParts: [materialId, cur.id],
        payload: {
          materialId,
          materialName: mat.marketNameEn,
          fromVersion: prev.version,
          toVersion: cur.version,
          sourceChanged,
          drift: drift.map((d) => ({
            field: d.field,
            previous: d.previous,
            current: d.current,
            delta: d.delta,
            status: d.status,
          })),
          noToleranceConfigured: drift.some((d) => d.status === 'no_tolerance'),
          affectedDesigns: designIds.length,
          failing,
        },
      });
      if (r.action === 'created') created++;
    }
    return { created };
  });
}

// ------------------------------------------------------------------------------------------ rule change

/** A rule or project change: re-evaluate every live design; list the ones that now fail or became provisional. */
export async function onRuleChange({ db }: Ctx, tenantId: string) {
  return sys(db, tenantId, 'rule-change', async (tx, audit) => {
    const failing: { designId: string; code: string; checks: string[] }[] = [];
    let provisional = 0;
    for (const d of await liveDesigns(tx, tenantId)) {
      const p = await priceDesign(tx, tenantId, d);
      const checks = p.report.checks.filter((c) => c.status === 'fail').map((c) => c.id);
      if (checks.length > 0 && d.lastVerdict !== 'fail')
        failing.push({ designId: d.id, code: d.code, checks });
      if (p.provisional && d.lastVerdict === 'pass') provisional++;
    }
    if (failing.length === 0 && provisional === 0) return { created: 0 };
    const r = await upsertInsight(tx, audit, {
      tenantId,
      type: 'rule_change',
      severity: failing.length > 0 ? 'high' : 'info',
      keyParts: [
        'rules',
        failing
          .map((f) => f.designId)
          .sort()
          .join(','),
        provisional,
      ],
      payload: {
        newFailures: failing,
        newlyProvisional: provisional,
        note: 'designs listed may need revalidation (a QC decision)',
      },
    });
    return { created: r.action === 'created' ? 1 : 0 };
  });
}

// ------------------------------------------------------------------------------------------ strength results

/** A strength set for a live design: below f′cr (the average at the design's test age) is a critical alert. */
export async function onStrengthResult({ db }: Ctx, tenantId: string, designId: string) {
  return sys(db, tenantId, 'strength-result', async (tx, audit) => {
    const [d] = (await tx
      .select()
      .from(schema.mixDesigns)
      .where(
        and(eq(schema.mixDesigns.id, designId), eq(schema.mixDesigns.tenantId, tenantId)),
      )) as DesignRow[];
    if (!d || !(LIVE as readonly string[]).includes(d.status)) return { created: 0 };
    const age = (d.requirements as { testAgeDays?: number }).testAgeDays;
    const [ev] = d.lastEvaluationId
      ? await tx
          .select({ report: schema.designEvaluations.report })
          .from(schema.designEvaluations)
          .where(eq(schema.designEvaluations.id, d.lastEvaluationId))
      : [];
    const fcr =
      (ev?.report as { strengthAdequacy?: { fcrMpa?: number | null } } | undefined)
        ?.strengthAdequacy?.fcrMpa ?? null;
    if (!age || fcr === null) return { created: 0 };
    const sets = await tx
      .select()
      .from(schema.strengthResults)
      .where(
        and(eq(schema.strengthResults.designId, designId), eq(schema.strengthResults.ageDays, age)),
      )
      .orderBy(desc(schema.strengthResults.createdAt));
    const latest = sets[0]?.setId;
    if (!latest) return { created: 0 };
    const mine = sets.filter((s) => s.setId === latest).map((s) => Number(s.resultMpa));
    const avg = mine.reduce((a, b) => a + b, 0) / mine.length;
    if (avg + 1e-9 >= fcr) return { created: 0 };
    const r = await upsertInsight(tx, audit, {
      tenantId,
      type: 'low_strength',
      severity: 'critical',
      plantId: d.plantId,
      designId,
      keyParts: [designId, latest],
      payload: {
        designCode: d.code,
        setId: latest,
        ageDays: age,
        specimens: mine,
        averageMpa: Math.round(avg * 100) / 100,
        requiredFcrMpa: fcr,
        note: 'a QC manager decides whether to suspend',
      },
    });
    return { created: r.action === 'created' ? 1 : 0 };
  });
}

// ------------------------------------------------------------------------------------------ nightly

export interface NightlyOptions {
  /** Seconds the sweep treats as "this run started": insights not refreshed since then expire. */
  runStartedAt?: Date;
}

/** Expired tests and stale prices per plant (nudges). */
export async function nudges({ db }: Ctx, tenantId: string, now = new Date()) {
  return sys(db, tenantId, 'nudges', async (tx, audit) => {
    const settings = await loadSettings(tx, tenantId);
    const params = await loadMaterialParams(tx, tenantId);
    const plants = await tx
      .select()
      .from(schema.plants)
      .where(eq(schema.plants.tenantId, tenantId));
    for (const p of plants) {
      const mats = await tx
        .select({ m: schema.materials, t: schema.materialTests })
        .from(schema.materials)
        .innerJoin(
          schema.materialTests,
          and(
            eq(schema.materialTests.materialId, schema.materials.id),
            eq(schema.materialTests.isCurrent, true),
          ),
        )
        .where(eq(schema.materials.plantId, p.id));
      const expired = mats
        .filter(
          ({ m, t }) =>
            freshness(t.testedAt, now, params.testAgeLimitDays[m.category]).status === 'expired',
        )
        .map(({ m, t }) => ({
          materialId: m.id,
          name: m.marketNameEn,
          category: m.category,
          testedAt: t.testedAt,
        }));
      if (expired.length > 0)
        await upsertInsight(tx, audit, {
          tenantId,
          type: 'test_expired',
          severity: 'medium',
          plantId: p.id,
          keyParts: [
            p.id,
            expired
              .map((e) => e.materialId)
              .sort()
              .join(','),
          ],
          payload: {
            expired,
            note: 'new approvals using these tests are blocked until they are renewed',
          },
        });
      const ids = mats.map(({ m }) => m.id);
      const cells = ids.length
        ? buildCells(
            await loadLiveRows(tx, tenantId, ids, [p.id]),
            await loadPrefs(tx, tenantId, [p.id]),
            await loadSgs(tx, tenantId, ids),
            todayAmman(now),
            todayAmman(now),
            settings.stalePriceDays,
          )
        : [];
      void priceStaleness;
      const stale = cells
        .filter((c) => c.staleness?.status === 'stale')
        .map((c) => ({ materialId: c.materialId, ageDays: c.staleness!.ageDays }));
      if (stale.length > 0)
        await upsertInsight(tx, audit, {
          tenantId,
          type: 'prices_stale',
          severity: 'info',
          plantId: p.id,
          keyParts: [
            p.id,
            stale
              .map((s) => s.materialId)
              .sort()
              .join(','),
          ],
          payload: { stale },
        });
    }
  });
}

/** The day's digest (one per tenant per day). */
export async function takeDigest({ db }: Ctx, tenantId: string, now = new Date()) {
  return sys(db, tenantId, 'digest', async (tx) => {
    const day = todayAmman(now);
    const open = await tx
      .select()
      .from(schema.insights)
      .where(and(eq(schema.insights.tenantId, tenantId), eq(schema.insights.status, 'open')));
    const since = new Date(now.getTime() - 24 * 3600_000);
    const count = (f: (i: (typeof open)[number]) => boolean) => open.filter(f).length;
    const top = open
      .filter((i) => i.type === 'opportunity' && i.savingJodPerM3)
      .sort((a, b) => Number(b.savingJodPerM3) - Number(a.savingJodPerM3))
      .slice(0, 5)
      .map((i) => ({
        id: i.id,
        designId: i.designId,
        savingJodPerM3: i.savingJodPerM3,
        annualJod: i.annualJod,
      }));
    const summary = {
      open: open.length,
      new24h: count((i) => i.firstSeenAt > since),
      bySeverity: Object.fromEntries(
        ['critical', 'high', 'medium', 'info'].map((s) => [s, count((i) => i.severity === s)]),
      ),
      byType: Object.fromEntries(
        [...new Set(open.map((i) => i.type))].map((t) => [t, count((i) => i.type === t)]),
      ),
      topOpportunities: top,
    };
    await tx.insert(schema.dailyDigests).values({ tenantId, day, summary }).onConflictDoNothing();
    return summary;
  });
}

/** Month-close and realized savings: every approved replacement, every closed month with a recorded volume. */
export async function realizeAll({ db }: Ctx, tenantId: string) {
  return sys(db, tenantId, 'realized', async (tx, audit) => {
    const auth = await systemAuth(tx, tenantId);
    const approved = await tx
      .select()
      .from(schema.savingsEntries)
      .where(
        and(
          eq(schema.savingsEntries.tenantId, tenantId),
          eq(schema.savingsEntries.state, 'approved'),
        ),
      );
    let created = 0;
    for (const a of approved)
      created += (await realizeForEntry(tx, audit, auth, a, { create: true, persist: true }))
        .entries.length;
    return { created };
  });
}

/** The nightly sweep: every trigger once, expiry of what no longer holds, realized savings, the digest. */
export async function nightly(ctx: Ctx, tenantId: string, opts: NightlyOptions = {}) {
  const started = opts.runStartedAt ?? new Date();
  await onPriceChange(ctx, tenantId);
  await nudges(ctx, tenantId, ctx.now ?? new Date());
  await onRuleChange(ctx, tenantId);
  await sys(ctx.db, tenantId, 'expire', async (tx) => {
    await expireUnseen(tx, tenantId, ['opportunity', 'test_expired', 'prices_stale'], started);
  });
  const realized = await realizeAll(ctx, tenantId);
  const digest = await takeDigest(ctx, tenantId, ctx.now ?? new Date());
  return { realized, digest };
}
