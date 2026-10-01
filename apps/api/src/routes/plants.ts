import { schema, type Db } from '@khalta/db';
import { canAccessPlant } from '@khalta/rbac';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { conflict, notFound } from '../errors';
import type { ApiRoutes } from '../route';
import { loadSettings } from '../settings';

const idParam = z.object({ id: z.uuid() });
const fields = {
  code: z.string().trim().min(1).max(32),
  nameAr: z.string().trim().min(1).max(200),
  nameEn: z.string().trim().min(1).max(200),
  city: z.string().trim().max(100).nullable(),
  region: z.string().trim().max(100).nullable(),
  isActive: z.boolean(),
  ambientProfile: z.enum(['hot', 'moderate']),
  haulCostJodPerM3Km: z
    .string()
    .regex(/^\d{1,9}(\.\d{1,3})?$/)
    .nullable(), // JOD, 3 decimals, as string (no floats for money)
};
const createBody = z.strictObject({
  code: fields.code,
  nameAr: fields.nameAr,
  nameEn: fields.nameEn,
  city: fields.city.optional(),
  region: fields.region.optional(),
  ambientProfile: fields.ambientProfile.optional(),
  haulCostJodPerM3Km: fields.haulCostJodPerM3Km.optional(),
});
const patchBody = z.strictObject(
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) as {
    [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]>;
  },
);

const columns = {
  id: schema.plants.id,
  code: schema.plants.code,
  nameAr: schema.plants.nameAr,
  nameEn: schema.plants.nameEn,
  city: schema.plants.city,
  region: schema.plants.region,
  isActive: schema.plants.isActive,
  ambientProfile: schema.plants.ambientProfile,
  haulCostJodPerM3Km: schema.plants.haulCostJodPerM3Km,
};

async function loadPlant(db: Pick<Db, 'select'>, tenantId: string, id: string) {
  const [p] = await db
    .select(columns)
    .from(schema.plants)
    .where(
      and(
        eq(schema.plants.id, id),
        eq(schema.plants.tenantId, tenantId),
        isNull(schema.plants.deletedAt),
      ),
    );
  return p;
}

export function plantRoutes(api: ApiRoutes) {
  api.get(
    '/api/plants',
    { summary: 'List plants visible to the caller', capability: null },
    async ({ auth, db }) => {
      const where = [eq(schema.plants.tenantId, auth.tenantId), isNull(schema.plants.deletedAt)];
      if (!auth.scope.all) {
        if (auth.scope.plantIds.length === 0) return [];
        where.push(inArray(schema.plants.id, [...auth.scope.plantIds]));
      }
      return db
        .select(columns)
        .from(schema.plants)
        .where(and(...where))
        .orderBy(asc(schema.plants.code));
    },
  );

  api.get(
    '/api/plants/:id',
    { summary: 'Get one plant', capability: null, params: idParam },
    async ({ auth, params, db }) => {
      // Inaccessible and non-existent plants look identical (no existence leak across plant scopes).
      if (!canAccessPlant(auth.scope, params.id)) throw notFound('Plant not found');
      const p = await loadPlant(db, auth.tenantId, params.id);
      if (!p) throw notFound('Plant not found');
      return p;
    },
  );

  api.mutate(
    'post',
    '/api/plants',
    { summary: 'Create plant', capability: 'org.manage', body: createBody, status: 201 },
    async ({ auth, body, tx, audit }) => {
      const settings = await loadSettings(tx, auth.tenantId);
      const active = await tx
        .select({ id: schema.plants.id })
        .from(schema.plants)
        .where(and(eq(schema.plants.tenantId, auth.tenantId), isNull(schema.plants.deletedAt)));
      if (active.length >= settings.maxPlants)
        throw conflict(`Plant limit reached (${settings.maxPlants})`);
      const [row] = await tx
        .insert(schema.plants)
        .values({ ...body, tenantId: auth.tenantId, createdBy: auth.user.id })
        .returning(columns);
      if (!row) throw new Error('insert failed');
      await audit.record({
        action: 'plant.create',
        entityType: 'plant',
        entityId: row.id,
        after: row,
      });
      return row;
    },
  );

  api.mutate(
    'patch',
    '/api/plants/:id',
    { summary: 'Update plant', capability: 'org.manage', body: patchBody, params: idParam },
    async ({ auth, body, params, tx, audit }) => {
      const before = await loadPlant(tx, auth.tenantId, params.id);
      if (!before) throw notFound('Plant not found');
      const [after] = await tx
        .update(schema.plants)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(schema.plants.id, params.id))
        .returning(columns);
      await audit.record({
        action: 'plant.update',
        entityType: 'plant',
        entityId: params.id,
        before,
        after,
      });
      return after;
    },
  );

  api.mutate(
    'delete',
    '/api/plants/:id',
    { summary: 'Soft-delete plant', capability: 'org.manage', params: idParam },
    async ({ auth, params, tx, audit }) => {
      const before = await loadPlant(tx, auth.tenantId, params.id);
      if (!before) throw notFound('Plant not found');
      await tx
        .update(schema.plants)
        .set({ deletedAt: new Date(), isActive: false })
        .where(eq(schema.plants.id, params.id));
      await audit.record({
        action: 'plant.delete',
        entityType: 'plant',
        entityId: params.id,
        before,
      });
    },
  );
}
