import { schema, type AuditRecorder, type Executor } from '@khalta/db';
import {
  adHocMaterialSchema,
  CATEGORIES,
  SOURCES,
  type Category,
  type Properties,
  type Source,
} from '@khalta/engine';
import { canAccessPlant } from '@khalta/rbac';
import { and, asc, eq, ilike, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthContext } from '../middleware';
import { ApiError, conflict, forbidden, notFound } from '../errors';
import {
  currentTest,
  loadMaterial,
  loadMaterialParams,
  resolveNewTest,
  summarize,
  testHistory,
  type MaterialRow,
  type TestRow,
} from '../materials/service';
import type { ApiRoutes } from '../route';

const idParam = z.object({ id: z.uuid() });
const text = (n: number) => z.string().trim().max(n);
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const listQuery = z.object({
  category: z.enum(CATEGORIES).optional(),
  plantId: z.uuid().optional(),
  supplierId: z.uuid().optional(),
  q: text(100).optional(),
  includeInactive: bool.optional(),
});
const readinessQuery = z.object({
  sulfateGoverns: bool.optional(),
  asrActive: bool.optional(),
  recycledWater: bool.optional(),
});

const materialFields = {
  plantId: z.uuid().nullable(),
  supplierId: z.uuid().nullable(),
  marketNameAr: text(120).nullable(),
  marketNameEn: text(120).min(1),
  technicalName: text(120).nullable(),
  sourceName: text(120).nullable(),
  notes: text(1000).nullable(),
};
const createBody = z.strictObject({
  category: z.enum(CATEGORIES),
  plantId: materialFields.plantId.optional(),
  supplierId: materialFields.supplierId.optional(),
  marketNameAr: materialFields.marketNameAr.optional(),
  marketNameEn: materialFields.marketNameEn,
  technicalName: materialFields.technicalName.optional(),
  sourceName: materialFields.sourceName.optional(),
  notes: materialFields.notes.optional(),
});
const patchBody = z.strictObject({
  plantId: materialFields.plantId.optional(),
  supplierId: materialFields.supplierId.optional(),
  marketNameAr: materialFields.marketNameAr.optional(),
  marketNameEn: materialFields.marketNameEn.optional(),
  technicalName: materialFields.technicalName.optional(),
  sourceName: materialFields.sourceName.optional(),
  notes: materialFields.notes.optional(),
  isActive: z.boolean().optional(),
});

const testBody = z.strictObject({
  properties: z.record(z.string(), z.unknown()),
  source: z.enum(SOURCES),
  /** Per-field override of `source` for new or changed fields. */
  fieldSources: z.record(z.string(), z.enum(SOURCES)).optional(),
  testedAt: z.iso.date(),
  validUntil: z.iso.date().optional(),
  labRef: text(120).optional(),
  attachmentId: z.uuid().optional(),
  declaredReason: text(500).optional(),
  changeReason: text(500).optional(),
});
const promoteBody = z.strictObject({
  material: adHocMaterialSchema,
  plantId: z.uuid().nullable().optional(),
  supplierId: z.uuid().nullable().optional(),
  reason: text(500).min(3),
});

/** Visible to the caller: unscoped roles see all; scoped roles see tenant-level and own-plant materials. */
const visible = (auth: AuthContext, m: Pick<MaterialRow, 'plantId'>) =>
  auth.scope.all || m.plantId === null || canAccessPlant(auth.scope, m.plantId);

async function mustSee(db: Executor, auth: AuthContext, id: string) {
  const m = await loadMaterial(db, auth.tenantId, id);
  // hidden and missing look identical
  if (!m || !visible(auth, m)) throw notFound('Material not found');
  return m;
}

function assertPlantWritable(auth: AuthContext, plantId: string | null | undefined) {
  if (plantId && !canAccessPlant(auth.scope, plantId))
    throw forbidden('That plant is outside your scope');
}

async function assertRefs(
  db: Executor,
  auth: AuthContext,
  plantId?: string | null,
  supplierId?: string | null,
) {
  if (plantId) {
    const [p] = await db
      .select({ id: schema.plants.id })
      .from(schema.plants)
      .where(
        and(
          eq(schema.plants.id, plantId),
          eq(schema.plants.tenantId, auth.tenantId),
          isNull(schema.plants.deletedAt),
        ),
      );
    if (!p) throw new ApiError(400, 'invalid_request', 'Unknown plant');
  }
  if (supplierId) {
    const [s] = await db
      .select({ id: schema.suppliers.id })
      .from(schema.suppliers)
      .where(
        and(
          eq(schema.suppliers.id, supplierId),
          eq(schema.suppliers.tenantId, auth.tenantId),
          isNull(schema.suppliers.deletedAt),
        ),
      );
    if (!s) throw new ApiError(400, 'invalid_request', 'Unknown supplier');
  }
}

const materialDto = (m: MaterialRow) => ({
  id: m.id,
  category: m.category as Category,
  plantId: m.plantId,
  supplierId: m.supplierId,
  marketNameAr: m.marketNameAr,
  marketNameEn: m.marketNameEn,
  technicalName: m.technicalName,
  sourceName: m.sourceName,
  notes: m.notes,
  isActive: m.isActive,
  promotedFrom: m.promotedFrom,
});

const testDto = (
  t: TestRow,
  attachment?: { filename: string; contentType: string; sizeBytes: number } | null,
) => ({
  id: t.id,
  version: t.version,
  isCurrent: t.isCurrent,
  source: t.source,
  fieldSources: t.fieldSources as Record<string, Source>,
  properties: t.properties as Properties,
  testedAt: t.testedAt,
  validUntil: t.validUntil,
  labRef: t.labRef,
  attachmentId: t.attachmentId,
  attachment: attachment ?? null,
  declaredReason: t.declaredReason,
  declaredBy: t.declaredBy,
  declaredAt: t.declaredAt,
  changeReason: t.changeReason,
  createdAt: t.createdAt,
  createdBy: t.createdBy,
});

async function attachmentMeta(db: Executor, tenantId: string, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((i): i is string => !!i))];
  if (wanted.length === 0)
    return new Map<string, { filename: string; contentType: string; sizeBytes: number }>();
  const rows = await db
    .select({
      id: schema.attachments.id,
      filename: schema.attachments.filename,
      contentType: schema.attachments.contentType,
      sizeBytes: schema.attachments.sizeBytes,
    })
    .from(schema.attachments)
    .where(and(eq(schema.attachments.tenantId, tenantId), inArray(schema.attachments.id, wanted)));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Inserts a new current test version (superseding the previous one) and returns it with its warnings. */
async function addTest(
  tx: Executor,
  audit: AuditRecorder,
  auth: AuthContext,
  m: MaterialRow,
  body: z.infer<typeof testBody>,
) {
  const [settingsParams, prev] = await Promise.all([
    loadMaterialParams(tx, auth.tenantId),
    currentTest(tx, auth.tenantId, m.id),
  ]);
  if (body.attachmentId) {
    const [a] = await tx
      .select({ id: schema.attachments.id })
      .from(schema.attachments)
      .where(
        and(
          eq(schema.attachments.id, body.attachmentId),
          eq(schema.attachments.tenantId, auth.tenantId),
        ),
      );
    if (!a) throw new ApiError(400, 'invalid_request', 'Unknown attachment');
  }
  const r = resolveNewTest(
    m.category as Category,
    {
      properties: body.properties,
      source: body.source,
      fieldSources: body.fieldSources,
      declaredReason: body.declaredReason,
      hasAttachment: !!body.attachmentId,
    },
    prev,
    auth.settings,
  );
  const now = new Date();
  if (prev)
    await tx
      .update(schema.materialTests)
      .set({ isCurrent: false, supersededAt: now })
      .where(eq(schema.materialTests.id, prev.id));
  const anyDeclared = r.declared.length > 0 || r.source === 'user_declared';
  const [row] = await tx
    .insert(schema.materialTests)
    .values({
      tenantId: auth.tenantId,
      materialId: m.id,
      version: (prev?.version ?? 0) + 1,
      isCurrent: true,
      source: r.source,
      fieldSources: r.sources,
      properties: r.props,
      testedAt: body.testedAt,
      validUntil: body.validUntil ?? null,
      labRef: body.labRef ?? null,
      attachmentId: body.attachmentId ?? null,
      declaredReason: anyDeclared ? (body.declaredReason ?? null) : null,
      declaredBy: anyDeclared ? auth.user.id : null,
      declaredAt: anyDeclared ? now : null,
      changeReason: body.changeReason ?? null,
      createdBy: auth.user.id,
    })
    .returning();
  if (!row) throw new Error('insert failed');
  await audit.record({
    action: 'material.test.create',
    entityType: 'material_test',
    entityId: row.id,
    before: prev ? testDto(prev) : null,
    after: testDto(row),
  });
  const summary = summarize(m.category as Category, row, prev, settingsParams, now);
  const meta = await attachmentMeta(tx, auth.tenantId, [row.attachmentId]);
  return {
    test: testDto(row, row.attachmentId ? (meta.get(row.attachmentId) ?? null) : null),
    warnings: r.warnings,
    summary,
  };
}

export function materialRoutes(api: ApiRoutes) {
  api.get(
    '/api/materials/params',
    {
      summary:
        'Engineering parameters the materials screens use (FM series, age limits, drift tolerances)',
      capability: 'materials.read',
    },
    async ({ auth, db }) => loadMaterialParams(db, auth.tenantId),
  );

  api.get(
    '/api/materials',
    {
      summary: 'List materials with readiness, freshness and source',
      capability: 'materials.read',
      query: listQuery,
    },
    async ({ auth, query, db }) => {
      const where = [
        eq(schema.materials.tenantId, auth.tenantId),
        isNull(schema.materials.deletedAt),
      ];
      if (!query.includeInactive) where.push(eq(schema.materials.isActive, true));
      if (query.category) where.push(eq(schema.materials.category, query.category));
      if (query.plantId) where.push(eq(schema.materials.plantId, query.plantId));
      if (query.supplierId) where.push(eq(schema.materials.supplierId, query.supplierId));
      if (query.q) {
        const like = `%${query.q.replace(/[%_\\]/g, '\\$&')}%`;
        where.push(
          or(
            ilike(schema.materials.marketNameEn, like),
            ilike(schema.materials.marketNameAr, like),
            ilike(schema.materials.technicalName, like),
          )!,
        );
      }
      if (!auth.scope.all) {
        where.push(
          auth.scope.plantIds.length
            ? or(
                isNull(schema.materials.plantId),
                inArray(schema.materials.plantId, [...auth.scope.plantIds]),
              )!
            : isNull(schema.materials.plantId),
        );
      }
      const mats = await db
        .select()
        .from(schema.materials)
        .where(and(...where))
        .orderBy(asc(schema.materials.category), asc(schema.materials.marketNameEn));
      if (mats.length === 0) return [];
      const [params, tests] = await Promise.all([
        loadMaterialParams(db, auth.tenantId),
        db
          .select()
          .from(schema.materialTests)
          .where(
            and(
              eq(schema.materialTests.tenantId, auth.tenantId),
              eq(schema.materialTests.isCurrent, true),
              inArray(
                schema.materialTests.materialId,
                mats.map((m) => m.id),
              ),
            ),
          ),
      ]);
      const byMat = new Map(tests.map((t) => [t.materialId, t]));
      const now = new Date();
      return mats.map((m) => {
        const t = byMat.get(m.id);
        const s = summarize(m.category as Category, t, undefined, params, now);
        return {
          ...materialDto(m),
          testedAt: t?.testedAt ?? null,
          version: t?.version ?? null,
          source: t?.source ?? null,
          hasTest: s.hasTest,
          canEvaluate: s.canEvaluate,
          canDesign: s.canDesign,
          fm: 'fm' in s ? s.fm : null,
          freshness: 'freshness' in s ? s.freshness : null,
          declaredKeyFields: 'declaredKeyFields' in s ? s.declaredKeyFields : [],
        };
      });
    },
  );

  api.get(
    '/api/materials/:id',
    {
      summary: 'Material with its current test and readiness',
      capability: 'materials.read',
      params: idParam,
    },
    async ({ auth, params, db }) => {
      const m = await mustSee(db, auth, params.id);
      const [hist, p] = await Promise.all([
        testHistory(db, auth.tenantId, m.id),
        loadMaterialParams(db, auth.tenantId),
      ]);
      const cur = hist.find((t) => t.isCurrent);
      const prev = cur ? hist.find((t) => t.version === cur.version - 1) : undefined;
      const att = await attachmentMeta(
        db,
        auth.tenantId,
        hist.map((t) => t.attachmentId),
      );
      return {
        material: materialDto(m),
        current: cur
          ? testDto(cur, cur.attachmentId ? (att.get(cur.attachmentId) ?? null) : null)
          : null,
        summary: summarize(m.category as Category, cur, prev, p, new Date()),
        versions: hist.length,
      };
    },
  );

  api.get(
    '/api/materials/:id/tests',
    { summary: 'Test history, newest first', capability: 'materials.read', params: idParam },
    async ({ auth, params, db }) => {
      const m = await mustSee(db, auth, params.id);
      const hist = await testHistory(db, auth.tenantId, m.id);
      const att = await attachmentMeta(
        db,
        auth.tenantId,
        hist.map((t) => t.attachmentId),
      );
      return hist.map((t) => testDto(t, t.attachmentId ? (att.get(t.attachmentId) ?? null) : null));
    },
  );

  api.get(
    '/api/materials/:id/readiness',
    {
      summary: 'What the material can be used for, with named blockers',
      capability: 'materials.read',
      params: idParam,
      query: readinessQuery,
    },
    async ({ auth, params, query, db }) => {
      const m = await mustSee(db, auth, params.id);
      const [cur, p] = await Promise.all([
        currentTest(db, auth.tenantId, m.id),
        loadMaterialParams(db, auth.tenantId),
      ]);
      return summarize(m.category as Category, cur, undefined, p, new Date(), {
        ...(query.sulfateGoverns !== undefined && { sulfateGoverns: query.sulfateGoverns }),
        ...(query.asrActive !== undefined && { asrActive: query.asrActive }),
        ...(query.recycledWater !== undefined && { recycledWater: query.recycledWater }),
      });
    },
  );

  api.mutate(
    'post',
    '/api/materials',
    {
      summary: 'Create a material (tests are added separately)',
      capability: 'materials.write',
      body: createBody,
      status: 201,
    },
    async ({ auth, body, tx, audit }) => {
      assertPlantWritable(auth, body.plantId);
      await assertRefs(tx, auth, body.plantId, body.supplierId);
      const [row] = await tx
        .insert(schema.materials)
        .values({ ...body, tenantId: auth.tenantId, createdBy: auth.user.id })
        .returning();
      if (!row) throw new Error('insert failed');
      await audit.record({
        action: 'material.create',
        entityType: 'material',
        entityId: row.id,
        after: materialDto(row),
      });
      return materialDto(row);
    },
  );

  api.mutate(
    'patch',
    '/api/materials/:id',
    {
      summary: 'Update a material (source and category are fixed once tested)',
      capability: 'materials.write',
      body: patchBody,
      params: idParam,
    },
    async ({ auth, body, params, tx, audit }) => {
      const before = await mustSee(tx, auth, params.id);
      if (body.plantId !== undefined) assertPlantWritable(auth, body.plantId);
      await assertRefs(tx, auth, body.plantId, body.supplierId);
      const changesSource =
        (body.supplierId !== undefined && body.supplierId !== before.supplierId) ||
        (body.sourceName !== undefined && body.sourceName !== before.sourceName);
      if (changesSource && (await currentTest(tx, auth.tenantId, before.id)))
        throw conflict(
          'A tested material cannot change supplier or source; create a new material instead',
        );
      const [after] = await tx
        .update(schema.materials)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(schema.materials.id, before.id))
        .returning();
      if (!after) throw new Error('update failed');
      await audit.record({
        action: 'material.update',
        entityType: 'material',
        entityId: before.id,
        before: materialDto(before),
        after: materialDto(after),
      });
      return materialDto(after);
    },
  );

  api.mutate(
    'delete',
    '/api/materials/:id',
    {
      summary: 'Soft-delete a material (history is kept)',
      capability: 'materials.write',
      params: idParam,
    },
    async ({ auth, params, tx, audit }) => {
      const before = await mustSee(tx, auth, params.id);
      await tx
        .update(schema.materials)
        .set({ deletedAt: new Date(), isActive: false })
        .where(eq(schema.materials.id, before.id));
      await audit.record({
        action: 'material.delete',
        entityType: 'material',
        entityId: before.id,
        before: materialDto(before),
      });
    },
  );

  api.mutate(
    'post',
    '/api/materials/:id/tests',
    {
      summary: 'Record a new test version (never edits an old one)',
      capability: 'lab.enter',
      body: testBody,
      params: idParam,
      status: 201,
    },
    async ({ auth, body, params, tx, audit }) => {
      const m = await mustSee(tx, auth, params.id);
      // A plant manager enters tests only for materials homed at their own plant.
      if (auth.role === 'plant_manager' && !(m.plantId && canAccessPlant(auth.scope, m.plantId)))
        throw forbidden('Plant managers can enter tests only for their own plant’s materials');
      return addTest(tx, audit, auth, m, body);
    },
  );

  api.mutate(
    'post',
    '/api/materials/promote',
    {
      summary: 'Promote an ad-hoc request material into the library with a user_declared test',
      capability: 'materials.write',
      body: promoteBody,
      status: 201,
    },
    async ({ auth, body, tx, audit }) => {
      const a = body.material;
      assertPlantWritable(auth, body.plantId);
      await assertRefs(tx, auth, body.plantId, body.supplierId);
      const [row] = await tx
        .insert(schema.materials)
        .values({
          tenantId: auth.tenantId,
          category: a.category,
          plantId: body.plantId ?? null,
          supplierId: body.supplierId ?? null,
          marketNameAr: a.market_name_ar ?? null,
          marketNameEn: a.market_name_en,
          technicalName: a.technical_name ?? null,
          sourceName: a.source ?? null,
          promotedFrom: 'ad_hoc',
          createdBy: auth.user.id,
        })
        .returning();
      if (!row) throw new Error('insert failed');
      await audit.record({
        action: 'material.promote',
        entityType: 'material',
        entityId: row.id,
        after: materialDto(row),
      });
      const result = await addTest(tx, audit, auth, row, {
        properties: a.properties,
        source: 'user_declared',
        testedAt: new Date().toISOString().slice(0, 10),
        declaredReason: `Promoted from an ad-hoc request material: ${body.reason}`,
      });
      return {
        material: materialDto(row),
        ...result,
        // Prices live in the price matrix (M1.2); the ad-hoc price is handed back, never stored here.
        pendingPriceJodPerKg: a.price_jod_per_kg ?? null,
      };
    },
  );
}
