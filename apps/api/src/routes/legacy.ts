import { schema } from '@khalta/db';
import { detectMapping, LEGACY_COLUMNS, type Mapping } from '@khalta/engine';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, conflict, notFound } from '../errors';
import { MAX_IMPORT_BYTES, readTable } from '../prices/import';
import { planImport, type Decisions, type Plan } from '../legacy/service';
import type { ApiRoutes } from '../route';

const idParam = z.object({ id: z.uuid() });
const uploadQuery = z.object({ filename: z.string().max(300).optional() });
const mappingSchema = z
  .partialRecord(z.enum(LEGACY_COLUMNS), z.number().int().min(0).max(200))
  .optional();
const decisionSchema = z.union([
  z.strictObject({ materialId: z.uuid() }),
  z.strictObject({ create: z.literal(true) }),
  z.null(),
]);
const planBody = z.strictObject({
  mapping: mappingSchema,
  decisions: z.record(z.string().max(300), decisionSchema).optional(),
});
const MAX_LINES = 5000;

export function legacyRoutes(api: ApiRoutes) {
  api.upload(
    '/api/imports/legacy/upload',
    {
      summary: 'Upload a legacy mix-design file (.xlsx or .csv, Appendix D long format)',
      capability: 'import.run',
      query: uploadQuery,
      limitBytes: MAX_IMPORT_BYTES,
    },
    async ({ auth, body, query, tx, audit }) => {
      if (body.length === 0) throw new ApiError(400, 'invalid_request', 'The upload is empty');
      let table: string[][];
      try {
        table = await readTable(body, query.filename ?? 'upload.csv');
      } catch {
        throw new ApiError(415, 'unsupported_type', 'Upload an .xlsx or .csv file');
      }
      const [header = [], ...rows] = table;
      if (rows.length === 0)
        throw new ApiError(400, 'invalid_request', 'The file has no data rows');
      if (rows.length > MAX_LINES)
        throw new ApiError(400, 'too_many', `At most ${MAX_LINES} lines per import`);
      const [batch] = await tx
        .insert(schema.legacyImportBatches)
        .values({
          tenantId: auth.tenantId,
          filename: query.filename ?? null,
          header,
          rows,
          status: 'uploaded',
          createdBy: auth.user.id,
        })
        .returning({ id: schema.legacyImportBatches.id });
      await audit.record({
        action: 'legacy.import.upload',
        entityType: 'legacy_import_batch',
        entityId: batch!.id,
        after: { filename: query.filename ?? null, lines: rows.length },
      });
      const { mapping, missing } = detectMapping(header);
      return { batchId: batch!.id, header, lines: rows.length, mapping, missing };
    },
  );

  async function loadBatch(
    db: Parameters<typeof planImport>[0],
    tenantId: string,
    userId: string,
    id: string,
  ) {
    const [b] = await db
      .select()
      .from(schema.legacyImportBatches)
      .where(
        and(
          eq(schema.legacyImportBatches.id, id),
          eq(schema.legacyImportBatches.tenantId, tenantId),
          eq(schema.legacyImportBatches.createdBy, userId),
        ),
      );
    if (!b) throw notFound('Import not found');
    return b;
  }

  api.readPost(
    '/api/imports/legacy/:id/preview',
    {
      summary: 'Re-run mapping, material matching and validation; nothing is written',
      capability: 'import.run',
      body: planBody,
    },
    async ({ auth, body, params, db }) => {
      const { id } = idParam.parse(params);
      const b = await loadBatch(db, auth.tenantId, auth.user.id, id);
      return planImport(
        db,
        auth,
        { header: b.header as string[], rows: b.rows as string[][] },
        body.mapping as Mapping | undefined,
        (body.decisions ?? {}) as Decisions,
      );
    },
  );

  api.mutate(
    'post',
    '/api/imports/legacy/:id/commit',
    {
      summary: 'Create the designs from a clean preview, all or nothing (single use)',
      capability: 'import.run',
      body: planBody,
      params: idParam,
    },
    async ({ auth, body, params, tx, audit }) => {
      const b = await loadBatch(tx, auth.tenantId, auth.user.id, params.id);
      if (b.status === 'committed') throw conflict('This import was already applied');
      await tx
        .select({ id: schema.legacyImportBatches.id })
        .from(schema.legacyImportBatches)
        .where(eq(schema.legacyImportBatches.id, b.id))
        .for('update');
      const decisions = (body.decisions ?? {}) as Decisions;
      let plan: Plan = await planImport(
        tx,
        auth,
        { header: b.header as string[], rows: b.rows as string[][] },
        body.mapping as Mapping | undefined,
        decisions,
      );
      if (
        plan.missing.length ||
        plan.fileErrors.length ||
        plan.designs.length === 0 ||
        plan.designs.some((d) => d.errors.length)
      )
        throw new ApiError(
          400,
          'has_errors',
          'Fix the errors in the file or the matching and preview again',
          { summary: plan.summary },
        );

      // materials the user chose to create (empty: no tests, flagged)
      const created = new Map<string, string>();
      for (const m of plan.materials.filter((x) => x.decision === 'create')) {
        const arabic = /[؀-ۿ]/.test(m.name);
        const [row] = await tx
          .insert(schema.materials)
          .values({
            tenantId: auth.tenantId,
            category: m.category,
            marketNameEn: m.name,
            marketNameAr: arabic ? m.name : null,
            notes: 'Created during legacy import; no tests yet',
            promotedFrom: 'legacy_import',
            createdBy: auth.user.id,
          })
          .returning({ id: schema.materials.id });
        created.set(m.key, row!.id);
        await audit.record({
          action: 'material.create',
          entityType: 'material',
          entityId: row!.id,
          after: { name: m.name, category: m.category, via: 'legacy_import' },
        });
      }
      // freeze: re-plan with the created ids as explicit choices so lines carry real material ids
      const frozen: Decisions = { ...decisions };
      for (const [k, id] of created) frozen[k] = { materialId: id };
      plan = await planImport(
        tx,
        auth,
        { header: b.header as string[], rows: b.rows as string[][] },
        body.mapping as Mapping | undefined,
        frozen,
      );
      if (plan.designs.some((d) => d.errors.length))
        throw new ApiError(400, 'has_errors', 'The import could not be completed');
      const methodOf = (key: string, id: string | null) =>
        (created.has(key)
          ? 'created'
          : id && plan.materials.find((m) => m.key === key)?.exactId === id
            ? 'exact'
            : 'confirmed') as 'exact' | 'confirmed' | 'created';

      const usedIds = [...new Set(plan.designs.flatMap((d) => d.lines.map((l) => l.materialId!)))];
      const tests = usedIds.length
        ? await tx
            .select({
              materialId: schema.materialTests.materialId,
              id: schema.materialTests.id,
              version: schema.materialTests.version,
              source: schema.materialTests.source,
            })
            .from(schema.materialTests)
            .where(
              and(
                eq(schema.materialTests.isCurrent, true),
                inArray(schema.materialTests.materialId, usedIds),
              ),
            )
        : [];
      const testBy = new Map(tests.map((t) => [t.materialId, t]));

      const ids: string[] = [];
      for (const d of plan.designs) {
        const [row] = await tx
          .insert(schema.mixDesigns)
          .values({
            tenantId: auth.tenantId,
            code: d.code,
            name: d.name,
            plantId: d.plantId!,
            status: 'draft',
            requirements: d.requirements,
            importedApprovalRef: d.approvalReference,
            importedInProduction: d.inProduction,
            avgMonthlyVolumeM3: d.avgMonthlyVolumeM3,
            evaluationPending: true,
            warnings: d.warnings,
            importBatchId: b.id,
            inputsSnapshot: {
              importBatchId: b.id,
              filename: b.filename,
              firstLine: d.firstLine,
              materials: d.lines.map((l) => ({
                materialId: l.materialId,
                testId: testBy.get(l.materialId!)?.id ?? null,
                testVersion: testBy.get(l.materialId!)?.version ?? null,
                source: testBy.get(l.materialId!)?.source ?? null,
              })),
            },
            createdBy: auth.user.id,
          })
          .returning({ id: schema.mixDesigns.id });
        ids.push(row!.id);
        await tx.insert(schema.mixDesignLines).values(
          d.lines.map((l) => ({
            tenantId: auth.tenantId,
            designId: row!.id,
            materialId: l.materialId!,
            quantityKgM3: l.kg!,
            originalQuantity: l.quantity,
            originalUnit: l.unit,
            originalName: l.materialName,
            sourceLine: l.line,
            matchMethod: methodOf(`${l.category}|${l.materialName.trim()}`, l.materialId),
          })),
        );
        await tx.insert(schema.designTransitions).values({
          tenantId: auth.tenantId,
          designId: row!.id,
          fromStatus: 'none',
          toStatus: 'draft',
          actorId: auth.user.id,
          evidence: { kind: 'legacy_import', batchId: b.id, filename: b.filename },
        });
        await audit.record({
          action: 'design.import',
          entityType: 'mix_design',
          entityId: row!.id,
          after: {
            code: d.code,
            plantId: d.plantId,
            status: 'draft',
            lines: d.lines.length,
            warnings: d.warnings.length,
          },
        });
      }
      await tx
        .update(schema.legacyImportBatches)
        .set({ status: 'committed', committedAt: new Date(), summary: plan.summary })
        .where(eq(schema.legacyImportBatches.id, b.id));
      await audit.record({
        action: 'legacy.import.commit',
        entityType: 'legacy_import_batch',
        entityId: b.id,
        after: { designs: ids.length, createdMaterials: created.size },
      });
      return { designs: ids.length, createdMaterials: created.size, designIds: ids };
    },
  );
}
