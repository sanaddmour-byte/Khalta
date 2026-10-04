// CSV exchange (F-029, ADR 0015): approved designs and batch weights for batching systems. Audited exports, plant-
// scoped, never any cost. Only `approved` and `in_production` designs are ever written; nothing here changes a design.
import { createHash } from 'node:crypto';
import { schema } from '@khalta/db';
import {
  batchCsv,
  batchPlanCsv,
  BATCH_SCHEMA,
  BATCH_V2_SCHEMA,
  DESIGNS_SCHEMA,
  designsCsv,
  todayAmman,
  type ExportBatch,
  type ExportBatchPlan,
  type BatchPlan,
  type ExportDesign,
  type MoistureInput,
  type BatchLineResult,
} from '@khalta/engine';
import { canAccessPlant } from '@khalta/rbac';
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, notFound } from '../errors';
import { designLines, ruleNumber, versionHash } from '../lifecycle/service';
import { loadCurrentRecords } from '../rules/service';
import type { ApiRoutes } from '../route';

const LIVE = ['approved', 'in_production'] as const;
const designsBody = z.strictObject({
  plantId: z.uuid().optional(),
  designId: z.uuid().optional(),
});
const batchBody = z.strictObject({
  instanceId: z.uuid().optional(),
  plantId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export function exportRoutes(api: ApiRoutes) {
  api.mutateFile(
    '/api/exports/designs.csv',
    {
      summary:
        'CSV of approved and in-production designs (khalta.designs.v1). Audited; never any cost; plant-scoped',
      capability: 'export.csv',
      body: designsBody,
    },
    async ({ auth, body, tx, audit }) => {
      if (body.plantId && !canAccessPlant(auth.scope, body.plantId))
        throw notFound('Plant not found');
      const rows = await tx
        .select({ d: schema.mixDesigns, plantCode: schema.plants.code })
        .from(schema.mixDesigns)
        .innerJoin(schema.plants, eq(schema.plants.id, schema.mixDesigns.plantId))
        .where(
          and(
            eq(schema.mixDesigns.tenantId, auth.tenantId),
            inArray(schema.mixDesigns.status, [...LIVE]),
            ...(body.plantId ? [eq(schema.mixDesigns.plantId, body.plantId)] : []),
            ...(body.designId ? [eq(schema.mixDesigns.id, body.designId)] : []),
          ),
        )
        .orderBy(
          asc(schema.plants.code),
          asc(schema.mixDesigns.code),
          asc(schema.mixDesigns.version),
        );
      const visible = rows.filter((r) => canAccessPlant(auth.scope, r.d.plantId));
      if (body.designId && visible.length === 0)
        throw new ApiError(409, 'conflict', 'This design is not approved or in production');
      const approverIds = [
        ...new Set(visible.flatMap((r) => (r.d.approvedBy ? [r.d.approvedBy] : []))),
      ];
      const names = new Map(
        (approverIds.length
          ? await tx
              .select({ id: schema.users.id, name: schema.users.name })
              .from(schema.users)
              .where(inArray(schema.users.id, approverIds))
          : []
        ).map((u) => [u.id, u.name]),
      );
      const out: ExportDesign[] = [];
      for (const { d, plantCode } of visible) {
        const lines = await tx
          .select({
            l: schema.mixDesignLines,
            name: schema.materials.marketNameEn,
            cat: schema.materials.category,
          })
          .from(schema.mixDesignLines)
          .innerJoin(schema.materials, eq(schema.materials.id, schema.mixDesignLines.materialId))
          .where(eq(schema.mixDesignLines.designId, d.id))
          .orderBy(asc(schema.mixDesignLines.sourceLine), asc(schema.mixDesignLines.id));
        const req = d.requirements as {
          fcMpa?: number | null;
          basis?: string | null;
          testAgeDays?: number | null;
          exposure?: string[];
          slumpMm?: number | null;
          nmasMm?: number | null;
          pumpable?: boolean | null;
        };
        out.push({
          code: d.code,
          name: d.name,
          plantCode,
          version: d.version,
          status: d.status as 'approved' | 'in_production',
          approvedAt: d.approvedAt ? d.approvedAt.toISOString() : null,
          approvedBy: d.approvedBy ? (names.get(d.approvedBy) ?? null) : null,
          designHash: versionHash(d, await designLines(tx, d.id)),
          rulesetMode: d.rulesetMode,
          avgMonthlyVolumeM3: d.avgMonthlyVolumeM3,
          requirements: {
            fcMpa: req.fcMpa ?? null,
            basis: req.basis ?? null,
            testAgeDays: req.testAgeDays ?? null,
            exposure: req.exposure ?? [],
            slumpMm: req.slumpMm ?? null,
            nmasMm: req.nmasMm ?? null,
            pumpable: req.pumpable ?? null,
          },
          lines: lines.map((x, i) => ({
            lineNo: i + 1,
            materialId: x.l.materialId,
            materialName: x.name,
            category: x.cat,
            kgPerM3: x.l.quantityKgM3,
          })),
        });
      }
      const csv = designsCsv(out);
      const hash = sha(csv);
      const plant = body.plantId ? (visible[0]?.plantCode ?? 'plant') : 'all';
      await audit.record({
        action: 'export.designs',
        entityType: 'export',
        entityId: hash,
        after: {
          schema: DESIGNS_SCHEMA,
          sha256: hash,
          designs: out.length,
          rows: out.reduce((a, d) => a + d.lines.length, 0),
          plantId: body.plantId ?? null,
          designId: body.designId ?? null,
        },
      });
      return {
        filename: `khalta-designs-${plant}-${todayAmman()}-${hash.slice(0, 8)}.csv`,
        contentType: 'text/csv; charset=utf-8',
        data: Buffer.from(csv, 'utf8'),
        headers: { 'X-Khalta-Sha256': hash },
      };
    },
  );

  api.mutateFile(
    '/api/exports/batch-weights.csv',
    {
      summary:
        'CSV of saved production batch weights (khalta.batch-weights.v1) for designs still approved or in production. Audited; never any cost',
      capability: 'export.csv',
      body: batchBody,
    },
    async ({ auth, body, tx, audit }) => {
      if (!body.instanceId && !body.plantId)
        throw new ApiError(
          400,
          'invalid_request',
          'Give an instance or a plant (with an optional date range)',
        );
      if (body.plantId && !canAccessPlant(auth.scope, body.plantId))
        throw notFound('Plant not found');
      const from = body.from ? new Date(`${body.from}T00:00:00+03:00`) : null;
      const to = body.to ? new Date(`${body.to}T23:59:59.999+03:00`) : null;
      const rows = await tx
        .select({
          b: schema.batchInstances,
          d: schema.mixDesigns,
          plantCode: schema.plants.code,
          actor: schema.users.name,
        })
        .from(schema.batchInstances)
        .innerJoin(schema.mixDesigns, eq(schema.mixDesigns.id, schema.batchInstances.designId))
        .innerJoin(schema.plants, eq(schema.plants.id, schema.batchInstances.plantId))
        .leftJoin(schema.users, eq(schema.users.id, schema.batchInstances.createdBy))
        .where(
          and(
            eq(schema.batchInstances.tenantId, auth.tenantId),
            eq(schema.batchInstances.validatorStatus, 'pass'),
            ...(body.instanceId ? [eq(schema.batchInstances.id, body.instanceId)] : []),
            ...(body.plantId ? [eq(schema.batchInstances.plantId, body.plantId)] : []),
            ...(from ? [gte(schema.batchInstances.createdAt, from)] : []),
            ...(to ? [lte(schema.batchInstances.createdAt, to)] : []),
          ),
        )
        .orderBy(asc(schema.batchInstances.createdAt));
      const mine = rows.filter((r) => canAccessPlant(auth.scope, r.b.plantId));
      if (body.instanceId && mine.length === 0) throw notFound('Batch weights not found');
      const exportable = mine.filter(
        (r) => r.b.kind === 'production' && (LIVE as readonly string[]).includes(r.d.status),
      );
      if (body.instanceId && exportable.length === 0)
        throw new ApiError(
          409,
          'conflict',
          'Only production batch weights of a design that is still approved or in production can be exported',
        );
      if (exportable.length === 0)
        throw new ApiError(409, 'nothing_to_export', 'No exportable batch weights in this range');
      const batches: ExportBatch[] = [];
      for (const { b, d, plantCode, actor } of exportable) {
        const result = b.result as {
          ok: true;
          lines: BatchLineResult[];
          designWaterKg: number;
          batchWaterKg: number;
        };
        const moisture = b.moisture as MoistureInput[];
        const mats = await tx
          .select({ id: schema.materials.id, name: schema.materials.marketNameEn })
          .from(schema.materials)
          .where(
            inArray(
              schema.materials.id,
              result.lines.map((l) => l.materialId),
            ),
          );
        batches.push({
          id: b.id,
          designCode: d.code,
          designVersion: b.designVersion,
          plantCode,
          kind: 'production',
          createdAt: b.createdAt.toISOString(),
          createdBy: actor ?? null,
          checkVerdict: 'pass',
          checkVersion: String(
            (b.validator as { validatorVersion?: string }).validatorVersion ?? '',
          ),
          designHash: versionHash(d, await designLines(tx, d.id)),
          designWaterKg: result.designWaterKg,
          batchWaterKg: result.batchWaterKg,
          lines: result.lines.map((l, i) => {
            const m = moisture.find((x) => x.materialId === l.materialId);
            return {
              lineNo: i + 1,
              materialId: l.materialId,
              materialName: mats.find((x) => x.id === l.materialId)?.name ?? '',
              category: l.category,
              kgSsd: l.kgSsd,
              kgOvenDry: l.kgOvenDry,
              kgBatch: l.kgBatch,
              freeWaterKg: l.freeWaterKg,
              solutionWaterKg: l.solutionWaterKg,
              totalMoisturePct: m?.totalMoisturePct ?? null,
              absorptionPct: m?.absorptionPct ?? null,
              moistureMeasuredAt: m?.measuredAt ?? null,
            };
          }),
        });
      }
      const csv = batchCsv(batches);
      const hash = sha(csv);
      await audit.record({
        action: 'export.batch_weights',
        entityType: 'export',
        entityId: hash,
        after: {
          schema: BATCH_SCHEMA,
          sha256: hash,
          batches: batches.length,
          skipped: mine.length - exportable.length,
          instanceId: body.instanceId ?? null,
          plantId: body.plantId ?? null,
          from: body.from ?? null,
          to: body.to ?? null,
        },
      });
      const stem = body.instanceId
        ? `batch-${body.instanceId.slice(0, 8)}`
        : `batches-${batches[0]!.plantCode}`;
      return {
        filename: `khalta-${stem}-${todayAmman()}-${hash.slice(0, 8)}.csv`,
        contentType: 'text/csv; charset=utf-8',
        data: Buffer.from(csv, 'utf8'),
        headers: { 'X-Khalta-Sha256': hash },
      };
    },
  );
  // ---- production batch PLANS (khalta.batch-weights.v2): refuses anything that is no longer safe to weigh ------------
  api.mutateFile(
    '/api/exports/batch-plans.csv',
    {
      summary:
        'CSV of saved batch plans (khalta.batch-weights.v2): what to weigh for a batch, bound to the exact design version. Refused (with every reason) when the design is not approved or in production, its version or a material test changed since preparation, a moisture reading is stale now, an equipment parameter is no longer on file, or the requirements it froze were superseded. Audited; never any cost',
      capability: 'export.csv',
      body: batchBody,
    },
    async ({ auth, body, tx, audit }) => {
      if (!body.instanceId && !body.plantId)
        throw new ApiError(
          400,
          'invalid_request',
          'Give a plan or a plant (with an optional date range)',
        );
      if (body.plantId && !canAccessPlant(auth.scope, body.plantId))
        throw notFound('Plant not found');
      const from = body.from ? new Date(`${body.from}T00:00:00+03:00`) : null;
      const to = body.to ? new Date(`${body.to}T23:59:59.999+03:00`) : null;
      const rows = await tx
        .select({
          b: schema.batchInstances,
          d: schema.mixDesigns,
          plantCode: schema.plants.code,
          actor: schema.users.name,
        })
        .from(schema.batchInstances)
        .innerJoin(schema.mixDesigns, eq(schema.mixDesigns.id, schema.batchInstances.designId))
        .innerJoin(schema.plants, eq(schema.plants.id, schema.batchInstances.plantId))
        .leftJoin(schema.users, eq(schema.users.id, schema.batchInstances.createdBy))
        .where(
          and(
            eq(schema.batchInstances.tenantId, auth.tenantId),
            eq(schema.batchInstances.kind, 'production'),
            ...(body.instanceId ? [eq(schema.batchInstances.id, body.instanceId)] : []),
            ...(body.plantId ? [eq(schema.batchInstances.plantId, body.plantId)] : []),
            ...(from ? [gte(schema.batchInstances.createdAt, from)] : []),
            ...(to ? [lte(schema.batchInstances.createdAt, to)] : []),
          ),
        )
        .orderBy(asc(schema.batchInstances.createdAt));
      const mine = rows.filter((r) => canAccessPlant(auth.scope, r.b.plantId));
      if (body.instanceId && mine.length === 0) throw notFound('Batch plan not found');
      const planned = mine.filter((r) => r.b.plan !== null);
      if (planned.length === 0)
        throw new ApiError(409, 'nothing_to_export', 'No saved batch plans in this selection');

      const rules = await loadCurrentRecords(tx, auth.tenantId);
      const staleHours = ruleNumber(rules, 'eng.moisture.stale_hours');
      const now = Date.now();
      const problems: { instanceId: string; designCode: string; code: string; detail: string }[] =
        [];
      const plans: ExportBatchPlan[] = [];
      for (const { b, d, plantCode, actor } of planned) {
        const bad = (code: string, detail: string) =>
          problems.push({ instanceId: b.id, designCode: d.code, code, detail });
        if (!(LIVE as readonly string[]).includes(d.status))
          bad(
            'design_not_live',
            `The design is ${d.status}: only an approved or in-production design can be weighed`,
          );
        const lines = await designLines(tx, d.id);
        if (versionHash(d, lines) !== b.designVersionHash)
          bad(
            'design_version_mismatch',
            'The design changed since this plan was prepared: prepare it again',
          );
        const tests = await tx
          .select({
            materialId: schema.materialTests.materialId,
            version: schema.materialTests.version,
          })
          .from(schema.materialTests)
          .where(
            and(
              eq(schema.materialTests.tenantId, auth.tenantId),
              inArray(
                schema.materialTests.materialId,
                lines.map((l) => l.materialId),
              ),
              eq(schema.materialTests.isCurrent, true),
            ),
          );
        const prepared = (b.materialTestVersions ?? {}) as Record<string, number | null>;
        for (const l of lines) {
          const now_ = tests.find((t) => t.materialId === l.materialId)?.version ?? null;
          if (now_ !== (prepared[l.materialId] ?? null))
            bad(
              'material_changed',
              `A material test changed since preparation (${l.materialId}): prepare the plan again`,
            );
        }
        if (staleHours === null)
          bad(
            'parameter_missing',
            'The moisture stale limit is not on file (eng.moisture.stale_hours)',
          );
        const moisture = (b.moisture ?? []) as MoistureInput[];
        for (const m of moisture) {
          const age = (now - Date.parse(m.measuredAt)) / 3_600_000;
          if (staleHours !== null && age > staleHours)
            bad(
              'moisture_stale_at_export',
              `The moisture reading for ${m.materialId} is ${Math.round(age * 10) / 10} h old; the limit is ${staleHours} h. Take a new reading and prepare the plan again`,
            );
        }
        for (const key of ['eng.batch.max_size_m3', 'eng.batch.max_rounding_deviation_pct'])
          if (ruleNumber(rules, key) === null) bad('parameter_missing', `${key} is not on file`);
        const frozen = d.requirementsFrozen as { projectRef: string; revision: number } | null;
        if (d.requirementsRevisionId) {
          const [rev] = await tx
            .select({ status: schema.projectRequirements.status })
            .from(schema.projectRequirements)
            .where(eq(schema.projectRequirements.id, d.requirementsRevisionId));
          if (rev?.status !== 'verified')
            bad(
              'requirements_superseded',
              'The project requirements this design froze are no longer current',
            );
        }
        const plan = b.plan as Extract<BatchPlan, { ok: true }>;
        const mats = await tx
          .select({ id: schema.materials.id, name: schema.materials.marketNameEn })
          .from(schema.materials)
          .where(
            inArray(
              schema.materials.id,
              plan.lines.map((l) => l.materialId),
            ),
          );
        const cv = (b.calcVersion ?? {}) as Record<string, string>;
        plans.push({
          id: b.id,
          designCode: d.code,
          designVersion: b.designVersion,
          designHash: b.designVersionHash ?? '',
          plantCode,
          requirementsRef: frozen ? `${frozen.projectRef} r${frozen.revision}` : '',
          preparedAt: b.createdAt.toISOString(),
          preparedBy: actor ?? null,
          calcVersion: `conversion ${cv['conversion'] ?? ''}; plan ${cv['plan'] ?? ''}`,
          checkVersions: `batch ${cv['batchValidator'] ?? ''}; plan ${cv['planValidator'] ?? ''}`,
          batchSizeM3: plan.batchSizeM3,
          exactTotalKg: plan.reconciliation.exactTotalKg,
          roundedTotalKg: plan.reconciliation.roundedTotalKg,
          lines: plan.lines.map((l, i) => {
            const m = moisture.find((x) => x.materialId === l.materialId);
            return {
              lineNo: i + 1,
              materialId: l.materialId,
              materialName: mats.find((x) => x.id === l.materialId)?.name ?? '',
              category: l.category,
              testVersion: prepared[l.materialId] ?? null,
              designKgPerM3: l.designKgPerM3,
              correctedKgPerM3: l.correctedKgPerM3,
              exactKg: l.exactKg,
              resolutionKg: l.resolutionKg,
              weighKg: l.roundedKg,
              errorKg: l.errorKg,
              totalMoisturePct: m?.totalMoisturePct ?? null,
              absorptionPct: m?.absorptionPct ?? null,
              moistureSource: m?.source ?? null,
              moistureMeasuredAt: m?.measuredAt ?? null,
              moistureAgeHoursAtExport: m
                ? Math.round(((now - Date.parse(m.measuredAt)) / 3_600_000) * 100) / 100
                : null,
            };
          }),
        });
      }
      if (problems.length > 0)
        throw new ApiError(
          409,
          'export_refused',
          'Some plans are not safe to weigh; nothing was exported',
          { problems },
        );
      const csv = batchPlanCsv(plans);
      const hash = sha(csv);
      await audit.record({
        action: 'export.batch_plans',
        entityType: 'export',
        entityId: hash,
        after: {
          schema: BATCH_V2_SCHEMA,
          sha256: hash,
          plans: plans.length,
          instanceId: body.instanceId ?? null,
          plantId: body.plantId ?? null,
          from: body.from ?? null,
          to: body.to ?? null,
        },
      });
      return {
        filename: `khalta-batch-plans-${plans[0]!.plantCode}-${todayAmman()}-${hash.slice(0, 8)}.csv`,
        contentType: 'text/csv; charset=utf-8',
        data: Buffer.from(csv, 'utf8'),
        headers: { 'X-Khalta-Sha256': hash },
      };
    },
  );
}
