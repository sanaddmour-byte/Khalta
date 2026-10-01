import { schema, type Tx } from '@khalta/db';
import { ROLES } from '@khalta/rbac';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { hashPassword, MIN_PASSWORD_LENGTH, type Auth } from '../auth';
import { conflict, notFound } from '../errors';
import type { ApiRoutes } from '../route';

const email = z.email().transform((e) => e.toLowerCase());
const role = z.enum(ROLES);
const password = z.string().min(MIN_PASSWORD_LENGTH).max(128);
const idParam = z.object({ id: z.string().min(1) });

const createBody = z.strictObject({
  email,
  name: z.string().trim().min(1).max(200),
  role,
  password,
});
const patchBody = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  role: role.optional(),
});
const passwordBody = z.strictObject({ password });
const plantsBody = z.strictObject({ plantIds: z.array(z.uuid()).max(200) });

const publicUser = {
  id: schema.users.id,
  name: schema.users.name,
  email: schema.users.email,
  role: schema.users.role,
  createdAt: schema.users.createdAt,
};

async function activeAdminCount(tx: Tx, tenantId: string) {
  const rows = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.tenantId, tenantId),
        eq(schema.users.role, 'admin'),
        eq(schema.users.banned, false),
        isNull(schema.users.deletedAt),
      ),
    )
    .for('update');
  return rows.length;
}

async function findUser(tx: Tx, tenantId: string, id: string) {
  const [u] = await tx
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.id, id),
        eq(schema.users.tenantId, tenantId),
        isNull(schema.users.deletedAt),
      ),
    )
    .for('update');
  if (!u) throw notFound('User not found');
  return u;
}

/** Shared by the route and bootstrap: user row + credential account in the caller's transaction. */
export async function insertUserWithPassword(
  tx: Tx,
  auth: Auth,
  v: {
    tenantId: string;
    email: string;
    name: string;
    role: string;
    password: string;
    createdBy: string | null;
  },
) {
  const id = crypto.randomUUID();
  await tx.insert(schema.users).values({
    id,
    tenantId: v.tenantId,
    email: v.email,
    name: v.name,
    role: v.role,
    emailVerified: true,
    createdBy: v.createdBy,
  });
  await tx.insert(schema.accounts).values({
    id: crypto.randomUUID(),
    userId: id,
    accountId: id,
    providerId: 'credential',
    password: await hashPassword(auth, v.password),
  });
  return id;
}

export function userRoutes(api: ApiRoutes, auth: Auth) {
  api.get(
    '/api/users',
    { summary: 'List users', capability: 'org.manage' },
    async ({ auth: a, db }) => {
      const users = await db
        .select(publicUser)
        .from(schema.users)
        .where(and(eq(schema.users.tenantId, a.tenantId), isNull(schema.users.deletedAt)))
        .orderBy(asc(schema.users.email));
      const links = await db
        .select({ userId: schema.userPlants.userId, plantId: schema.userPlants.plantId })
        .from(schema.userPlants)
        .where(
          and(eq(schema.userPlants.tenantId, a.tenantId), isNull(schema.userPlants.deletedAt)),
        );
      return users.map((u) => ({
        ...u,
        plantIds: links.filter((l) => l.userId === u.id).map((l) => l.plantId),
      }));
    },
  );

  api.mutate(
    'post',
    '/api/users',
    { summary: 'Create user', capability: 'org.manage', body: createBody, status: 201 },
    async ({ auth: a, body, tx, audit }) => {
      const id = await insertUserWithPassword(tx, auth, {
        ...body,
        tenantId: a.tenantId,
        createdBy: a.user.id,
      });
      const after = { id, email: body.email, name: body.name, role: body.role };
      await audit.record({ action: 'user.create', entityType: 'user', entityId: id, after });
      return after;
    },
  );

  api.mutate(
    'patch',
    '/api/users/:id',
    {
      summary: 'Update user name/role',
      capability: 'org.manage',
      body: patchBody,
      params: idParam,
    },
    async ({ auth: a, body, params, tx, audit }) => {
      const before = await findUser(tx, a.tenantId, params.id);
      if (
        body.role &&
        body.role !== 'admin' &&
        before.role === 'admin' &&
        (await activeAdminCount(tx, a.tenantId)) <= 1
      )
        throw conflict('Cannot demote the last active admin');
      const patch = { ...body, updatedAt: new Date() };
      await tx.update(schema.users).set(patch).where(eq(schema.users.id, params.id));
      const after = {
        id: before.id,
        name: body.name ?? before.name,
        role: body.role ?? before.role,
      };
      await audit.record({
        action: 'user.update',
        entityType: 'user',
        entityId: before.id,
        before: { name: before.name, role: before.role },
        after,
      });
      return after;
    },
  );

  api.mutate(
    'delete',
    '/api/users/:id',
    { summary: 'Deactivate (soft-delete) user', capability: 'org.manage', params: idParam },
    async ({ auth: a, params, tx, audit }) => {
      const before = await findUser(tx, a.tenantId, params.id);
      if (before.id === a.user.id) throw conflict('You cannot delete your own account');
      if (before.role === 'admin' && (await activeAdminCount(tx, a.tenantId)) <= 1)
        throw conflict('Cannot delete the last active admin');
      const now = new Date();
      await tx
        .update(schema.users)
        .set({ deletedAt: now, banned: true, updatedAt: now })
        .where(eq(schema.users.id, before.id));
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, before.id));
      await audit.record({
        action: 'user.delete',
        entityType: 'user',
        entityId: before.id,
        before: { email: before.email, role: before.role },
      });
    },
  );

  api.mutate(
    'post',
    '/api/users/:id/password',
    {
      summary: 'Admin password reset',
      capability: 'org.manage',
      body: passwordBody,
      params: idParam,
    },
    async ({ auth: a, body, params, tx, audit }) => {
      const u = await findUser(tx, a.tenantId, params.id);
      const hash = await hashPassword(auth, body.password);
      await tx
        .update(schema.accounts)
        .set({ password: hash, updatedAt: new Date() })
        .where(and(eq(schema.accounts.userId, u.id), eq(schema.accounts.providerId, 'credential')));
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, u.id)); // force re-login
      // The password itself is never written to the audit log.
      await audit.record({ action: 'user.password_reset', entityType: 'user', entityId: u.id });
    },
  );

  api.mutate(
    'put',
    '/api/users/:id/plants',
    {
      summary: 'Replace plant assignments',
      capability: 'org.manage',
      body: plantsBody,
      params: idParam,
    },
    async ({ auth: a, body, params, tx, audit }) => {
      const u = await findUser(tx, a.tenantId, params.id);
      const wanted = [...new Set(body.plantIds)];
      if (wanted.length) {
        const found = await tx
          .select({ id: schema.plants.id })
          .from(schema.plants)
          .where(
            and(
              inArray(schema.plants.id, wanted),
              eq(schema.plants.tenantId, a.tenantId),
              isNull(schema.plants.deletedAt),
            ),
          );
        if (found.length !== wanted.length) throw notFound('One or more plants not found');
      }
      const current = await tx
        .select()
        .from(schema.userPlants)
        .where(and(eq(schema.userPlants.userId, u.id), isNull(schema.userPlants.deletedAt)));
      const currentIds = current.map((c) => c.plantId);
      const toRemove = current.filter((c) => !wanted.includes(c.plantId));
      const toAdd = wanted.filter((id) => !currentIds.includes(id));
      const now = new Date();
      for (const r of toRemove)
        await tx
          .update(schema.userPlants)
          .set({ deletedAt: now })
          .where(eq(schema.userPlants.id, r.id));
      if (toAdd.length)
        await tx.insert(schema.userPlants).values(
          toAdd.map((plantId) => ({
            tenantId: a.tenantId,
            userId: u.id,
            plantId,
            createdBy: a.user.id,
          })),
        );
      await audit.record({
        action: 'user.plants_set',
        entityType: 'user',
        entityId: u.id,
        before: { plantIds: currentIds.sort() },
        after: { plantIds: wanted.sort() },
      });
      return { plantIds: wanted };
    },
  );
}
