import { schema } from '@khalta/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { notFound } from '../errors';
import type { ApiRoutes } from '../route';

const idParam = z.object({ id: z.uuid() });
const text = (n: number) => z.string().trim().max(n);
const fields = {
  nameAr: text(200).min(1),
  nameEn: text(200).min(1),
  contact: text(200).nullable(),
  phone: text(60).nullable(),
  email: text(200).nullable(),
  city: text(100).nullable(),
  isActive: z.boolean(),
};
const createBody = z.strictObject({
  nameAr: fields.nameAr,
  nameEn: fields.nameEn,
  contact: fields.contact.optional(),
  phone: fields.phone.optional(),
  email: fields.email.optional(),
  city: fields.city.optional(),
});
const patchBody = z.strictObject({
  nameAr: fields.nameAr.optional(),
  nameEn: fields.nameEn.optional(),
  contact: fields.contact.optional(),
  phone: fields.phone.optional(),
  email: fields.email.optional(),
  city: fields.city.optional(),
  isActive: fields.isActive.optional(),
});

const columns = {
  id: schema.suppliers.id,
  nameAr: schema.suppliers.nameAr,
  nameEn: schema.suppliers.nameEn,
  contact: schema.suppliers.contact,
  phone: schema.suppliers.phone,
  email: schema.suppliers.email,
  city: schema.suppliers.city,
  isActive: schema.suppliers.isActive,
};

export function supplierRoutes(api: ApiRoutes) {
  api.get(
    '/api/suppliers',
    { summary: 'List suppliers', capability: 'materials.read' },
    async ({ auth, db }) =>
      db
        .select(columns)
        .from(schema.suppliers)
        .where(
          and(eq(schema.suppliers.tenantId, auth.tenantId), isNull(schema.suppliers.deletedAt)),
        )
        .orderBy(asc(schema.suppliers.nameEn)),
  );

  api.mutate(
    'post',
    '/api/suppliers',
    { summary: 'Create supplier', capability: 'suppliers.write', body: createBody, status: 201 },
    async ({ auth, body, tx, audit }) => {
      const [row] = await tx
        .insert(schema.suppliers)
        .values({ ...body, tenantId: auth.tenantId, createdBy: auth.user.id })
        .returning(columns);
      if (!row) throw new Error('insert failed');
      await audit.record({
        action: 'supplier.create',
        entityType: 'supplier',
        entityId: row.id,
        after: row,
      });
      return row;
    },
  );

  api.mutate(
    'patch',
    '/api/suppliers/:id',
    { summary: 'Update supplier', capability: 'suppliers.write', body: patchBody, params: idParam },
    async ({ auth, body, params, tx, audit }) => {
      const scope = and(
        eq(schema.suppliers.id, params.id),
        eq(schema.suppliers.tenantId, auth.tenantId),
        isNull(schema.suppliers.deletedAt),
      );
      const [before] = await tx.select(columns).from(schema.suppliers).where(scope);
      if (!before) throw notFound('Supplier not found');
      const [after] = await tx
        .update(schema.suppliers)
        .set({ ...body, updatedAt: new Date() })
        .where(scope)
        .returning(columns);
      await audit.record({
        action: 'supplier.update',
        entityType: 'supplier',
        entityId: params.id,
        before,
        after,
      });
      return after;
    },
  );

  api.mutate(
    'delete',
    '/api/suppliers/:id',
    { summary: 'Soft-delete supplier', capability: 'suppliers.write', params: idParam },
    async ({ auth, params, tx, audit }) => {
      const scope = and(
        eq(schema.suppliers.id, params.id),
        eq(schema.suppliers.tenantId, auth.tenantId),
        isNull(schema.suppliers.deletedAt),
      );
      const [before] = await tx.select(columns).from(schema.suppliers).where(scope);
      if (!before) throw notFound('Supplier not found');
      await tx
        .update(schema.suppliers)
        .set({ deletedAt: new Date(), isActive: false })
        .where(scope);
      await audit.record({
        action: 'supplier.delete',
        entityType: 'supplier',
        entityId: params.id,
        before,
      });
    },
  );
}
