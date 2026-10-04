import { schema, type AuditRecorder, type Tx } from '@khalta/db';
import {
  ADJUSTMENT_KINDS,
  monthEnd,
  multiply,
  netSaving,
  parseDecimal,
  reconciliationOf,
  roundTo,
  type AdjustmentKind,
} from '@khalta/engine';
import { roleCan } from '@khalta/rbac';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, forbidden, notFound } from '../errors';
import type { ApiRoutes } from '../route';
import { evaluateAndStore, loadDesign } from '../evaluation/run';
import { realizeForEntry, systemAuth } from '../savings/service';

const mode = z.enum(['ACI', 'JS', 'BOTH']).default('BOTH');
const baselineBody = z.strictObject({
  designId: z.uuid(),
  priceSnapshotId: z.uuid(),
  mode,
});
const theoreticalBody = z.strictObject({
  baselineId: z.uuid(),
  variantDesignId: z.uuid(),
  mode,
});

/** cost (or saving) × monthly volume × 12, exact decimals, rounded to 3 places. */
function annual(perM3: string, monthlyVolume: string | null): string | null {
  if (!monthlyVolume) return null;
  const a = parseDecimal(perM3);
  const v = parseDecimal(monthlyVolume);
  if (a === null || v === null) return null;
  return roundTo(multiply(multiply(a, v), 12n * 10n ** 9n), 3);
}

export function baselineRoutes(api: ApiRoutes) {
  api.mutate(
    'post',
    '/api/baselines',
    {
      summary:
        'Record what an attested design costs per m³ at one named price snapshot (immutable; never re-priced)',
      capability: 'baseline.create',
      body: baselineBody,
      status: 201,
    },
    async ({ auth, body, tx, audit }) => {
      const design = await loadDesign(tx, auth, body.designId, true);
      if (!design.approvalSource || !['approved', 'in_production'].includes(design.status))
        throw new ApiError(
          409,
          'conflict',
          'Only an attested or approved design can have a baseline',
        );
      const [snap] = await tx
        .select()
        .from(schema.priceSnapshots)
        .where(
          and(
            eq(schema.priceSnapshots.id, body.priceSnapshotId),
            eq(schema.priceSnapshots.tenantId, auth.tenantId),
          ),
        );
      if (!snap) throw notFound('Price snapshot not found');
      if (!(snap.plantIds as string[]).includes(design.plantId))
        throw new ApiError(
          409,
          'conflict',
          'The price snapshot does not cover this design’s plant',
        );
      const [dupe] = await tx
        .select({ id: schema.costBaselines.id })
        .from(schema.costBaselines)
        .where(
          and(
            eq(schema.costBaselines.designId, design.id),
            eq(schema.costBaselines.priceSnapshotId, snap.id),
          ),
        );
      if (dupe)
        throw new ApiError(409, 'conflict', 'This design already has a baseline at this snapshot');

      const run = await evaluateAndStore(tx, auth, audit, design, {
        mode: body.mode,
        priceSnapshotId: snap.id,
        evaluationDate: snap.asOf,
      });
      const reasons: { code: string; detail?: unknown }[] = [];
      if (run.validator.status !== 'pass') reasons.push({ code: 'validator_failed' });
      if (run.report.cost.state !== 'complete' || run.report.cost.totalJodPerM3 === null)
        reasons.push({ code: 'cost_incomplete', detail: run.report.cost.missing });
      if (reasons.length > 0)
        throw new ApiError(
          409,
          'baseline_not_possible',
          'A baseline needs a complete, validated cost',
          { reasons },
        );

      const cost = run.report.cost.totalJodPerM3!;
      const [b] = await tx
        .insert(schema.costBaselines)
        .values({
          tenantId: auth.tenantId,
          designId: design.id,
          evaluationId: run.evaluationId,
          priceSnapshotId: snap.id,
          plantId: design.plantId,
          costJodPerM3: cost,
          monthlyVolumeM3: design.avgMonthlyVolumeM3,
          volumeSource: design.avgMonthlyVolumeM3 ? 'import_file' : null,
          annualJod: annual(cost, design.avgMonthlyVolumeM3),
          createdBy: auth.user.id,
        })
        .returning();
      await audit.record({
        action: 'baseline.create',
        entityType: 'cost_baseline',
        entityId: b!.id,
        after: {
          designId: design.id,
          snapshot: snap.id,
          costJodPerM3: cost,
          evaluationId: run.evaluationId,
        },
      });
      return {
        id: b!.id,
        costJodPerM3: cost,
        annualJod: b!.annualJod,
        evaluationId: run.evaluationId,
      };
    },
  );

  api.get(
    '/api/baselines',
    { summary: 'Cost baselines with the snapshot each one is fixed to', capability: 'cost.view' },
    async ({ auth, db }) => {
      const rows = await db
        .select({
          id: schema.costBaselines.id,
          designId: schema.costBaselines.designId,
          code: schema.mixDesigns.code,
          version: schema.mixDesigns.version,
          plantId: schema.costBaselines.plantId,
          snapshotId: schema.costBaselines.priceSnapshotId,
          snapshotName: schema.priceSnapshots.name,
          asOf: schema.priceSnapshots.asOf,
          costJodPerM3: schema.costBaselines.costJodPerM3,
          monthlyVolumeM3: schema.costBaselines.monthlyVolumeM3,
          volumeSource: schema.costBaselines.volumeSource,
          annualJod: schema.costBaselines.annualJod,
          createdAt: schema.costBaselines.createdAt,
        })
        .from(schema.costBaselines)
        .innerJoin(schema.mixDesigns, eq(schema.mixDesigns.id, schema.costBaselines.designId))
        .innerJoin(
          schema.priceSnapshots,
          eq(schema.priceSnapshots.id, schema.costBaselines.priceSnapshotId),
        )
        .where(eq(schema.costBaselines.tenantId, auth.tenantId))
        .orderBy(desc(schema.costBaselines.createdAt));
      return rows.filter((r) => auth.scope.all || auth.scope.plantIds.includes(r.plantId));
    },
  );

  api.mutate(
    'post',
    '/api/savings/theoretical',
    {
      summary:
        'Price a manual variant of a baseline design at the baseline’s own snapshot; a compliant, validated, cheaper variant becomes a THEORETICAL ledger entry',
      capability: 'design.write',
      body: theoreticalBody,
    },
    async ({ auth, body, tx, audit }) => {
      if (!roleCan(auth.role, 'cost.view', auth.settings)) throw forbidden();
      const [base] = await tx
        .select()
        .from(schema.costBaselines)
        .where(
          and(
            eq(schema.costBaselines.id, body.baselineId),
            eq(schema.costBaselines.tenantId, auth.tenantId),
          ),
        );
      if (!base || !(auth.scope.all || auth.scope.plantIds.includes(base.plantId)))
        throw notFound('Baseline not found');
      const baseDesign = await loadDesign(tx, auth, base.designId);
      const variant = await loadDesign(tx, auth, body.variantDesignId, true);
      if (
        variant.id === baseDesign.id ||
        variant.code !== baseDesign.code ||
        variant.plantId !== baseDesign.plantId
      )
        throw new ApiError(
          409,
          'conflict',
          'The variant must be another version of the baseline design',
        );
      if (!['draft', 'evaluated'].includes(variant.status))
        throw new ApiError(
          409,
          'conflict',
          'Only a draft or evaluated variant can be priced as an opportunity',
        );
      const [snap] = await tx
        .select()
        .from(schema.priceSnapshots)
        .where(eq(schema.priceSnapshots.id, base.priceSnapshotId));

      // Both designs are priced at the baseline's snapshot: market movement is never credited to the change.
      const run = await evaluateAndStore(tx, auth, audit, variant, {
        mode: 'BOTH',
        priceSnapshotId: base.priceSnapshotId,
        evaluationDate: snap!.asOf,
      });
      const reasons: { code: string; detail?: unknown }[] = [];
      if (run.validator.status !== 'pass') reasons.push({ code: 'validator_failed' });
      if (run.report.verdict !== 'pass') reasons.push({ code: `verdict_${run.report.verdict}` });
      if (run.report.cost.state !== 'complete' || run.report.cost.totalJodPerM3 === null)
        reasons.push({ code: 'cost_incomplete', detail: run.report.cost.missing });
      let saving: bigint | null = null;
      if (run.report.cost.totalJodPerM3 !== null) {
        const b = parseDecimal(base.costJodPerM3);
        const v = parseDecimal(run.report.cost.totalJodPerM3);
        if (b !== null && v !== null) saving = b - v;
        if (saving !== null && saving <= 0n) reasons.push({ code: 'not_cheaper' });
      }
      if (reasons.length > 0 || saving === null) {
        await audit.record({
          action: 'savings.variant_checked',
          entityType: 'mix_design',
          entityId: variant.id,
          after: {
            baselineId: base.id,
            eligible: false,
            reasons: reasons.map((r) => r.code),
            evaluationId: run.evaluationId,
          },
        });
        return { eligible: false, reasons, evaluationId: run.evaluationId };
      }
      const perM3 = roundTo(saving, 3);
      const [e] = await tx
        .insert(schema.savingsEntries)
        .values({
          tenantId: auth.tenantId,
          baselineId: base.id,
          baselineDesignId: baseDesign.id,
          variantDesignId: variant.id,
          variantEvaluationId: run.evaluationId,
          priceSnapshotId: base.priceSnapshotId,
          state: 'theoretical',
          reasonCode: 'manual_variant',
          savingJodPerM3: perM3,
          monthlyVolumeM3: base.monthlyVolumeM3,
          annualJod: annual(perM3, base.monthlyVolumeM3),
          provisional: run.report.provisional,
          createdBy: auth.user.id,
        })
        .returning();
      await audit.record({
        action: 'savings.theoretical',
        entityType: 'savings_entry',
        entityId: e!.id,
        after: {
          baselineId: base.id,
          variantDesignId: variant.id,
          savingJodPerM3: perM3,
          state: 'theoretical',
        },
      });
      return {
        eligible: true,
        reasons: [],
        evaluationId: run.evaluationId,
        entry: {
          id: e!.id,
          savingJodPerM3: perM3,
          annualJod: e!.annualJod,
          state: 'theoretical',
          provisional: e!.provisional,
        },
      };
    },
  );

  api.get(
    '/api/savings',
    {
      summary:
        'Ledger entries in three states (theoretical, approved, realized); never summed across states',
      capability: 'cost.view',
    },
    async ({ auth, db }) => {
      const rows = await db
        .select({
          id: schema.savingsEntries.id,
          state: schema.savingsEntries.state,
          reasonCode: schema.savingsEntries.reasonCode,
          baselineId: schema.savingsEntries.baselineId,
          baselineDesignId: schema.savingsEntries.baselineDesignId,
          variantDesignId: schema.savingsEntries.variantDesignId,
          snapshotId: schema.savingsEntries.priceSnapshotId,
          snapshotName: schema.priceSnapshots.name,
          asOf: schema.priceSnapshots.asOf,
          savingJodPerM3: schema.savingsEntries.savingJodPerM3,
          monthlyVolumeM3: schema.savingsEntries.monthlyVolumeM3,
          annualJod: schema.savingsEntries.annualJod,
          provisional: schema.savingsEntries.provisional,
          period: schema.savingsEntries.period,
          producedVolumeM3: schema.savingsEntries.producedVolumeM3,
          baselineCostJodPerM3: schema.savingsEntries.baselineCostJodPerM3,
          replacementCostJodPerM3: schema.savingsEntries.replacementCostJodPerM3,
          totalJod: schema.savingsEntries.totalJod,
          createdAt: schema.savingsEntries.createdAt,
          plantId: schema.mixDesigns.plantId,
          code: schema.mixDesigns.code,
          variantVersion: schema.mixDesigns.version,
        })
        .from(schema.savingsEntries)
        .innerJoin(
          schema.mixDesigns,
          eq(schema.mixDesigns.id, schema.savingsEntries.variantDesignId),
        )
        .innerJoin(
          schema.priceSnapshots,
          eq(schema.priceSnapshots.id, schema.savingsEntries.priceSnapshotId),
        )
        .where(eq(schema.savingsEntries.tenantId, auth.tenantId))
        .orderBy(desc(schema.savingsEntries.createdAt));
      const mine = rows.filter((r) => auth.scope.all || auth.scope.plantIds.includes(r.plantId));
      const adj = mine.length
        ? await db
            .select()
            .from(schema.savingsAdjustments)
            .where(
              inArray(
                schema.savingsAdjustments.entryId,
                mine.map((r) => r.id),
              ),
            )
        : [];
      // the volume each realized month actually used: the latest recorded row for that design and month
      const vols = await db
        .select({
          designId: schema.productionVolumes.designId,
          month: schema.productionVolumes.month,
          source: schema.productionVolumes.source,
        })
        .from(schema.productionVolumes)
        .where(eq(schema.productionVolumes.tenantId, auth.tenantId))
        .orderBy(asc(schema.productionVolumes.createdAt));
      const sourceOf = new Map(vols.map((v) => [`${v.designId}|${v.month}`, v.source]));
      return mine.map((r) => {
        const mineAdj = adj.filter((a) => a.entryId === r.id);
        const gross = r.totalJod ?? r.annualJod;
        const volumeSource =
          r.state === 'realized' && r.period
            ? (sourceOf.get(`${r.variantDesignId}|${r.period}`) ?? null)
            : null;
        return {
          ...r,
          adjustments: mineAdj.map((a) => ({
            id: a.id,
            kind: a.kind,
            amountJod: a.amountJod,
            note: a.note,
            createdAt: a.createdAt,
          })),
          // gross, costs and net are all shown; a reversal never hides the original figure
          net:
            gross && r.state !== 'theoretical'
              ? netSaving(
                  gross,
                  mineAdj.map((a) => ({ kind: a.kind as AdjustmentKind, amountJod: a.amountJod })),
                )
              : null,
          volumeSource,
          attribution:
            r.state === 'realized' && r.period ? { from: r.period, to: monthEnd(r.period) } : null,
          reconciliation:
            r.state === 'realized'
              ? reconciliationOf({ volumeSource, provisional: r.provisional })
              : null,
        };
      });
    },
  );

  api.mutate(
    'post',
    '/api/savings/entries/:id/adjustments',
    {
      summary:
        'Reverse an approved or realized entry, or attach a trial, implementation or extra cost to it. Entries are never edited: each is its own row, one reversal per entry, and the gross figure stays visible',
      capability: 'insight.accept',
      params: z.object({ id: z.uuid() }),
      body: z.strictObject({
        kind: z.enum(ADJUSTMENT_KINDS),
        /** Costs only: a positive amount in JOD. A reversal takes its amount from the entry. */
        amountJod: z
          .string()
          .regex(/^\d{1,12}(\.\d{1,3})?$/)
          .optional(),
        note: z.string().trim().min(10).max(500),
      }),
      status: 201,
    },
    async ({ auth, params, body, tx, audit }) => {
      const [e] = await tx
        .select({ e: schema.savingsEntries, plantId: schema.mixDesigns.plantId })
        .from(schema.savingsEntries)
        .innerJoin(
          schema.mixDesigns,
          eq(schema.mixDesigns.id, schema.savingsEntries.variantDesignId),
        )
        .where(
          and(
            eq(schema.savingsEntries.id, params.id),
            eq(schema.savingsEntries.tenantId, auth.tenantId),
          ),
        )
        .for('update', { of: schema.savingsEntries });
      if (!e || !(auth.scope.all || auth.scope.plantIds.includes(e.plantId)))
        throw notFound('Ledger entry not found');
      if (e.e.state === 'theoretical')
        throw new ApiError(
          409,
          'conflict',
          'A theoretical figure is an opportunity, not a booked saving; there is nothing to reverse or charge',
        );
      let amount: string;
      if (body.kind === 'reversal') {
        const gross = e.e.totalJod ?? e.e.annualJod;
        const g = gross === null ? null : parseDecimal(gross.replace(/^-/, ''));
        if (!gross || g === null || g === 0n)
          throw new ApiError(409, 'nothing_to_reverse', 'This entry has no figure to reverse');
        amount = gross.replace(/^-/, '');
      } else {
        if (!body.amountJod || Number(body.amountJod) <= 0)
          throw new ApiError(400, 'invalid_request', 'A cost needs a positive amount in JOD');
        amount = body.amountJod;
      }
      const dup =
        body.kind === 'reversal'
          ? await tx
              .select({ id: schema.savingsAdjustments.id })
              .from(schema.savingsAdjustments)
              .where(
                and(
                  eq(schema.savingsAdjustments.entryId, e.e.id),
                  eq(schema.savingsAdjustments.kind, 'reversal'),
                ),
              )
          : [];
      if (dup.length > 0) throw new ApiError(409, 'conflict', 'This entry was already reversed');
      const [row] = await tx
        .insert(schema.savingsAdjustments)
        .values({
          tenantId: auth.tenantId,
          entryId: e.e.id,
          kind: body.kind,
          amountJod: amount,
          note: body.note,
          createdBy: auth.user.id,
        })
        .returning({ id: schema.savingsAdjustments.id });
      await audit.record({
        action: `savings.${body.kind}`,
        entityType: 'savings_entry',
        entityId: e.e.id,
        after: { adjustmentId: row!.id, kind: body.kind, amountJod: amount, note: body.note },
      });
      return { id: row!.id, kind: body.kind, amountJod: amount };
    },
  );

  api.get(
    '/api/savings/blocked',
    {
      summary:
        'Months a realized saving cannot be computed yet, and why (no volume, no month snapshot, incomplete cost); nothing is estimated',
      capability: 'cost.view',
    },
    async ({ auth, db }) => {
      const approved = await db
        .select({
          e: schema.savingsEntries,
          code: schema.mixDesigns.code,
          plantId: schema.mixDesigns.plantId,
        })
        .from(schema.savingsEntries)
        .innerJoin(
          schema.mixDesigns,
          eq(schema.mixDesigns.id, schema.savingsEntries.variantDesignId),
        )
        .where(
          and(
            eq(schema.savingsEntries.tenantId, auth.tenantId),
            eq(schema.savingsEntries.state, 'approved'),
          ),
        );
      const sys = await systemAuth(db, auth.tenantId);
      const none = { record: async () => {} } as unknown as AuditRecorder;
      const blocked: { designId: string; code: string; month: string; reason: string }[] = [];
      for (const a of approved) {
        if (!(auth.scope.all || auth.scope.plantIds.includes(a.plantId))) continue;
        const r = await realizeForEntry(db as unknown as Tx, none, sys, a.e, {
          create: false,
          persist: false,
        });
        for (const b of r.blocked)
          blocked.push({
            designId: a.e.variantDesignId,
            code: a.code,
            month: b.month,
            reason: b.reason,
          });
      }
      return { blocked };
    },
  );
}
